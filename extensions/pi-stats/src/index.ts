import { dirname } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { UsageDetector } from "./detector";
import { canonicalizeSkillName, PiSkillRegistry } from "./registry";
import {
	renderScanResult,
	scanSessionHistoryWithProgress,
	scanToolSessionHistoryWithProgress,
	sessionFileKey,
	skillOriginKey,
	toolOriginKey,
	type ScanSessionHistoryProgress,
} from "./scanner";
import { SkillStatsOverlay } from "./stats-overlay";
import { SQLiteSkillStatsStore, type SkillStatsStore, type ToolUsageAggregate, type UsageAggregate } from "./store";

export default function skillStatsExtension(pi: ExtensionAPI) {
	let store: SkillStatsStore | undefined;
	let statsDisabled = false;
	let initWarningShown = false;
	let writeWarningShown = false;
	let registry = PiSkillRegistry.fromCommands([]);
	const detector = new UsageDetector(registry);
	// Skills detected in the input event are recorded once the user message entry
	// has been persisted (the input event fires before persistence), so that the
	// origin key can reference the same session entry id a later scan would use.
	let pendingInputSkills: string[] = [];

	function refreshRegistry() {
		registry = PiSkillRegistry.fromCommands(pi.getCommands());
		detector.setRegistry(registry);
	}

	function notifyOnce(ctx: ExtensionContext, kind: "init" | "write", message: string) {
		if (kind === "init") {
			if (initWarningShown) return;
			initWarningShown = true;
		} else {
			if (writeWarningShown) return;
			writeWarningShown = true;
		}
		ctx.ui.notify(message, "warning");
	}

	async function ensureStore(ctx: ExtensionContext): Promise<SkillStatsStore | undefined> {
		if (statsDisabled) return undefined;
		if (store) return store;
		try {
			const config = loadConfig();
			store = await SQLiteSkillStatsStore.create(config.dataDir);
			return store;
		} catch (error) {
			statsDisabled = true;
			notifyOnce(ctx, "init", `pi-skill-stats disabled: ${errorMessage(error)}`);
			return undefined;
		}
	}

	async function record(ctx: ExtensionContext, skill: string, originKey?: string) {
		const activeStore = await ensureStore(ctx);
		if (!activeStore) return;
		try {
			activeStore.insert({ skill, project: ctx.cwd, originKey });
		} catch (error) {
			console.warn("pi-skill-stats write failed", error);
			notifyOnce(ctx, "write", `pi-skill-stats write failed: ${errorMessage(error)}`);
		}
	}
	async function recordTool(ctx: ExtensionContext, tool: string, originKey?: string) {
		const activeStore = await ensureStore(ctx);
		if (!activeStore) return;
		try {
			activeStore.insertTool({ tool, project: ctx.cwd, originKey });
		} catch (error) {
			console.warn("pi-skill-stats tool write failed", error);
			notifyOnce(ctx, "write", `pi-skill-stats tool write failed: ${errorMessage(error)}`);
		}
	}

	async function flushPendingInputSkills(ctx: ExtensionContext) {
		if (pendingInputSkills.length === 0) return;
		const skills = pendingInputSkills;
		pendingInputSkills = [];
		const origin = liveOrigin(ctx, "user");
		for (const skill of skills) {
			await record(ctx, skill, origin ? skillOriginKey(origin.fileKey, origin.entryId, skill) : undefined);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshRegistry();
		ensureStore(ctx);
	});

	pi.on("input", async (event, ctx) => {
		refreshRegistry();
		detector.startTurn();
		const detected = detector.detectInput(event.text);
		if (detected.length > 0 && await ensureStore(ctx)) {
			pendingInputSkills.push(...detected.map((usage) => usage.skill));
		}
		return { action: "continue" as const };
	});

	pi.on("message_start", async (event, ctx) => {
		// By the time the assistant message starts, the user message entry that
		// triggered this turn has been persisted; flush input skills against it.
		if (event.message.role === "assistant") await flushPendingInputSkills(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const origin = liveOrigin(ctx, "assistant");
		await recordTool(ctx, event.toolName, origin ? toolOriginKey(origin.fileKey, origin.entryId, event.toolName) : undefined);
		if (!isToolCallEventType("read", event)) return;
		refreshRegistry();
		const path = event.input.path;
		if (typeof path !== "string") return;
		const usage = detector.detectSkillRead(path);
		if (usage) await record(ctx, usage.skill, origin ? skillOriginKey(origin.fileKey, origin.entryId, usage.skill) : undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await flushPendingInputSkills(ctx);
		detector.endTurn();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await flushPendingInputSkills(ctx);
		store?.close();
		store = undefined;
	});

	pi.registerCommand("skill-stats", {
		description: "Show skill usage statistics",
		getArgumentCompletions: (prefix) => {
			const skillNames = [...new Set(pi.getCommands()
				.filter((command) => command.source === "skill")
				.map((command) => canonicalizeSkillName(command.name)))]
				.sort();
			return completeStatsArgs(prefix, skillNames);
		},
		handler: async (args, ctx) => {
			const activeStore = await ensureStore(ctx);
			if (!activeStore) {
				ctx.ui.notify("pi-skill-stats is disabled; check the earlier warning for details.", "warning");
				return;
			}
			try {
				const command = parseStatsCommand(args);
				if (command.action === "scan") {
					refreshRegistry();
					const sessionsRoot = dirname(ctx.sessionManager.getSessionDir());
					const progress = createScanProgressReporter(ctx, "skill");
					try {
						const result = await scanSessionHistoryWithProgress({
							sessionsRoot,
							registry,
							store: activeStore,
							defaultProject: ctx.cwd,
							onProgress: progress.update,
						});
						ctx.ui.notify(renderScanResult(result), "info");
					} finally {
						progress.clear();
					}
					return;
				}

				const rows = activeStore.queryTop({ project: command.scope === "all" ? undefined : ctx.cwd, limit: 1000 });
				await showStatsOverlay(ctx, activeStore, rows, command.scope, command.query, "skill");
			} catch (error) {
				ctx.ui.notify(`pi-skill-stats command failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tool-stats", {
		description: "Show tool call statistics",
		getArgumentCompletions: (prefix) => {
			let toolNames: string[] = [];
			try {
				toolNames = store ? store.queryTopTools({ limit: 1000 }).map((row) => row.tool).sort() : [];
			} catch {
				toolNames = [];
			}
			return completeStatsArgs(prefix, toolNames);
		},
		handler: async (args, ctx) => {
			const activeStore = await ensureStore(ctx);
			if (!activeStore) {
				ctx.ui.notify("pi-skill-stats is disabled; check the earlier warning for details.", "warning");
				return;
			}
			try {
				const command = parseStatsCommand(args);
				if (command.action === "scan") {
					const sessionsRoot = dirname(ctx.sessionManager.getSessionDir());
					const progress = createScanProgressReporter(ctx, "tool");
					try {
						const result = await scanToolSessionHistoryWithProgress({
							sessionsRoot,
							store: activeStore,
							defaultProject: ctx.cwd,
							onProgress: progress.update,
						});
						ctx.ui.notify(renderScanResult(result), "info");
					} finally {
						progress.clear();
					}
					return;
				}

				const rows = activeStore.queryTopTools({ project: command.scope === "all" ? undefined : ctx.cwd, limit: 1000 });
				await showStatsOverlay(ctx, activeStore, rows, command.scope, command.query, "tool");
			} catch (error) {
				ctx.ui.notify(`pi-skill-stats command failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}

type ParsedStatsCommand =
	| { action: "scan" }
	| { action: "show"; scope: "project" | "all"; query: string };

export function parseStatsCommand(args: string): ParsedStatsCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens[0] === "scan") return { action: "scan" };
	if (tokens[0] === "all") return { action: "show", scope: "all", query: tokens.slice(1).join(" ") };
	return { action: "show", scope: "project", query: tokens.join(" ") };
}

/**
 * Resolve the origin of the event being handled to the same (session file,
 * entry id) pair a later `scan` would derive for it, by walking up from the
 * session leaf to the nearest persisted message entry with the given role.
 * Returns undefined when the session is not persisted or no entry matches;
 * callers then record the event without an origin key.
 */
function liveOrigin(ctx: ExtensionContext, role: "user" | "assistant"): { fileKey: string; entryId: string } | undefined {
	try {
		const manager = ctx.sessionManager;
		const sessionFile = manager?.getSessionFile?.();
		if (!sessionFile) return undefined;
		let entry = manager.getLeafEntry?.();
		for (let depth = 0; entry && depth < 100; depth += 1) {
			if (entry.type === "message" && entry.message.role === role) {
				return { fileKey: sessionFileKey(sessionFile), entryId: entry.id };
			}
			entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
		}
	} catch {
		// Fall through: record without an origin key rather than dropping the event.
	}
	return undefined;
}

async function showStatsOverlay(
	ctx: ExtensionContext,
	store: SkillStatsStore,
	rows: UsageAggregate[] | ToolUsageAggregate[],
	scope: "project" | "all",
	query: string,
	kind: "skill" | "tool",
): Promise<void> {
	const project = scope === "all" ? undefined : ctx.cwd;
	const getTrend = (name: string) => kind === "tool"
		? store.queryToolTrend({ tool: name, project, limit: 30 })
		: store.querySkillTrend({ skill: name, project, limit: 30 });
	await ctx.ui.custom<null>(
		(tui, theme, _keybindings, done) => {
			const overlay = new SkillStatsOverlay(rows, scope, theme, query, () => done(null), kind, getTrend);
			return {
				get focused() {
					return overlay.focused;
				},
				set focused(value: boolean) {
					overlay.focused = value;
				},
				render: (width: number) => overlay.render(width),
				invalidate: () => overlay.invalidate(),
				handleInput: (data: string) => {
					overlay.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				minWidth: 72,
				maxHeight: "80%",
				anchor: "center",
				margin: 1,
			},
		},
	);
}

function createScanProgressReporter(ctx: ExtensionContext, kind: "skill" | "tool") {
	const widgetKey = `pi-skill-stats-${kind}-scan`;
	let lastRender = 0;

	const update = (progress: ScanSessionHistoryProgress) => {
		const now = Date.now();
		if (progress.phase === "scanning" && progress.files !== progress.totalFiles && now - lastRender < 100) return;
		lastRender = now;
		ctx.ui.setWidget(widgetKey, renderScanProgress(progress), { placement: "belowEditor" });
	};

	return {
		update,
		clear: () => ctx.ui.setWidget(widgetKey, undefined),
	};
}

function renderScanProgress(progress: ScanSessionHistoryProgress): string[] {
	const title = progress.kind === "tool" ? "Tool stats scan" : "Skill stats scan";
	if (progress.phase === "discovering") return [`${title}: discovering session files...`];

	const total = progress.totalFiles ?? 0;
	const percent = total > 0 ? Math.floor((progress.files / total) * 100) : 100;
	const bar = progressBar(progress.files, total);
	return [
		`${title}: ${bar} ${percent}% (${progress.files}/${total} files)`,
		`lines ${progress.lines} · inserted ${progress.inserted} · skipped ${progress.skipped} · errors ${progress.errors}`,
	];
}

function progressBar(done: number, total: number): string {
	const width = 20;
	const filled = total > 0 ? Math.min(width, Math.floor((done / total) * width)) : width;
	return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function completeStatsArgs(prefix: string, skillNames: string[]) {
	const trimmed = prefix.trim();
	if (trimmed.startsWith("all ")) {
		const query = trimmed.slice(4).trim();
		return skillNames
			.filter((value) => value.startsWith(query) || fuzzyIncludes(value, query))
			.slice(0, 20)
			.map((value) => ({ value: `all ${value}`, label: value }));
	}

	return ["all", "scan", ...skillNames]
		.filter((value) => value.startsWith(trimmed) || fuzzyIncludes(value, trimmed))
		.slice(0, 20)
		.map((value) => ({ value, label: value }));
}

function fuzzyIncludes(value: string, query: string): boolean {
	if (!query) return true;
	let index = 0;
	const normalizedValue = value.toLowerCase();
	const normalizedQuery = query.toLowerCase();
	for (const char of normalizedQuery) {
		index = normalizedValue.indexOf(char, index);
		if (index === -1) return false;
		index += 1;
	}
	return true;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
