import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const OUTPUT_DIR = path.join(homedir(), "Pictures", "Screenshots");
const SHORTCUT = "ctrl+alt+s";

function timestamp() {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function run(command: string, args: string[], options: { input?: Buffer | string } = {}) {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(command, args, { stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				resolve({ stdout: out, stderr: err });
			} else {
				const message = err.trim() || out.trim() || `${command} exited with code ${code}`;
				reject(new Error(message));
			}
		});

		if (options.input && child.stdin) {
			child.stdin.end(options.input);
		}
	});
}

async function copyImageToClipboard(filePath: string) {
	const bytes = await readFile(filePath);
	const child = spawn("wl-copy", ["--type", "image/png"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	child.on("error", () => undefined);
	child.stdin?.end(bytes);
}

async function commandExists(command: string) {
	try {
		await run("sh", ["-c", `command -v ${command}`]);
		return true;
	} catch {
		return false;
	}
}

async function freezeUntil<T>(work: () => Promise<T>) {
	let freezer: ReturnType<typeof spawn> | undefined;
	try {
		if (await commandExists("hyprpicker")) {
			freezer = spawn("hyprpicker", ["-r", "-z"], { stdio: "ignore" });
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return await work();
	} finally {
		freezer?.kill();
	}
}

async function captureRegion() {
	await mkdir(OUTPUT_DIR, { recursive: true });

	// Match the reference script: invoking again cancels an active slurp selection.
	try {
		await run("pkill", ["slurp"]);
	} catch {
		// No existing slurp is fine.
	}

	const selection = (await freezeUntil(() => run("slurp", []))).stdout.trim();
	if (!selection) return undefined;

	const filePath = path.join(OUTPUT_DIR, `PiShot_${timestamp()}.png`);
	await run("grim", ["-g", selection, filePath]);

	try {
		await copyImageToClipboard(filePath);
	} catch {
		// Clipboard is best-effort; do not block satty on wl-copy's clipboard owner lifecycle.
	}

	return filePath;
}

async function annotateWithSatty(filePath: string) {
	if (!(await commandExists("satty"))) return;

	await run("satty", [
		"--filename",
		filePath,
		"--output-filename",
		filePath,
		"--actions-on-enter",
		"save-to-file",
		"--actions-on-enter",
		"exit",
		"--actions-on-escape",
		"exit",
		"--early-exit",
	]);
}

function attachShotToEditor(ctx: ExtensionContext, filePath: string) {
	const current = ctx.ui.getEditorText();
	const needsSpace = current.length > 0 && !/\s$/.test(current);
	ctx.ui.pasteToEditor(`${needsSpace ? " " : ""}${filePath}`);
}

async function takePiShot(_pi: ExtensionAPI, ctx: ExtensionContext) {
	ctx.ui.setStatus("pi-shots", "📸 selecting");
	try {
		const filePath = await captureRegion();
		if (!filePath) {
			ctx.ui.notify("截图已取消", "info");
			return;
		}

		ctx.ui.setStatus("pi-shots", "✏️ annotating");
		await annotateWithSatty(filePath);

		ctx.ui.setStatus("pi-shots", "📎 attaching");
		attachShotToEditor(ctx, filePath);
		ctx.ui.notify(`已附加截图到输入框：${filePath}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`pi-shots 失败：${message}`, "error");
	} finally {
		ctx.ui.setStatus("pi-shots", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut(SHORTCUT, {
		description: "Capture a region, annotate in satty, and attach it to the editor",
		handler: (ctx) => takePiShot(pi, ctx),
	});

	pi.registerCommand("shot", {
		description: "Capture a region, annotate in satty, and attach it to the editor",
		handler: async (_args, ctx) => takePiShot(pi, ctx),
	});
}
