// External-editor side of the `/memory` detail view. Enter opens the memory
// file in the same editor pi uses for Ctrl+G (`settings.externalEditor` →
// `VISUAL` → `EDITOR` → platform default), but on the real file rather than a
// temp copy: the point is editing the memory in place. No pi imports here, so
// the resolution and the spawn are unit-testable.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EditorResult = { ok: true } | { ok: false; error: string };

/**
 * Editor command, resolved exactly like pi's built-in Ctrl+G:
 * the `externalEditor` setting wins over `VISUAL`, which wins over `EDITOR`.
 * A blank setting counts as unset.
 */
export function resolveEditorCommand(
	externalEditorSetting: unknown,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string {
	if (typeof externalEditorSetting === "string" && externalEditorSetting.trim() !== "") {
		return externalEditorSetting;
	}
	const environmentEditor = env.VISUAL || env.EDITOR;
	if (environmentEditor) return environmentEditor;
	return platform === "win32" ? "notepad" : "nano";
}

/** `externalEditor` from the agent's `settings.json`; undefined when unreadable. */
export function readExternalEditorSetting(agentDir: string): unknown {
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
			externalEditor?: unknown;
		};
		return settings.externalEditor;
	} catch {
		return undefined;
	}
}

/**
 * Run `command` on `filePath` with the terminal handed over (stdio inherit).
 * Resolves when the editor exits; a non-zero code or a spawn error is data, not
 * a rejection, so the caller can show it instead of unwinding the overlay.
 */
export async function editFileInEditor(command: string, filePath: string): Promise<EditorResult> {
	// Same naive split as pi: a command with spaces means "editor + args".
	const [editor, ...args] = command.split(" ").filter((part) => part !== "");
	if (editor === undefined) return { ok: false, error: "no external editor configured" };
	return new Promise<EditorResult>((resolve) => {
		let settled = false;
		const finish = (result: EditorResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		try {
			const child = spawn(editor, [...args, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", (err) => finish({ ok: false, error: err.message }));
			child.on("close", (code) =>
				finish(code === 0 ? { ok: true } : { ok: false, error: `editor exited with code ${code}` }),
			);
		} catch (err) {
			finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	});
}
