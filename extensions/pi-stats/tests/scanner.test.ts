import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PiSkillRegistry } from "../src/registry";
import {
	renderScanResult,
	scanSessionHistory,
	scanSessionHistoryWithProgress,
	scanToolSessionHistory,
	scanToolSessionHistoryWithProgress,
} from "../src/scanner";
import type { SkillStatsStore, ToolUsageEvent, UsageEvent } from "../src/store";

class MemoryStore implements SkillStatsStore {
	events: UsageEvent[] = [];
	toolEvents: ToolUsageEvent[] = [];
	seen = new Set<string>();

	insert(event: UsageEvent): boolean {
		if (event.originKey && this.seen.has(event.originKey)) return false;
		if (event.originKey) this.seen.add(event.originKey);
		this.events.push(event);
		return true;
	}

	insertTool(event: ToolUsageEvent): boolean {
		if (event.originKey && this.seen.has(event.originKey)) return false;
		if (event.originKey) this.seen.add(event.originKey);
		this.toolEvents.push(event);
		return true;
	}

	queryTop() {
		return [];
	}

	queryTopTools() {
		return [];
	}

	querySkillTrend() {
		return [];
	}

	queryToolTrend() {
		return [];
	}

	close() {}
}

function registry() {
	return PiSkillRegistry.fromCommands([
		{ name: "tdd", source: "skill", sourceInfo: { path: "/skills/tdd/SKILL.md" } } as any,
		{ name: "diagnose", source: "skill", sourceInfo: { path: "/skills/diagnose/SKILL.md" } } as any,
	]);
}

function sessionLine(value: unknown): string {
	return JSON.stringify(value);
}

describe("scanSessionHistory", () => {
	test("scans skill calls from session files", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-scan-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		writeFileSync(join(dir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({
				type: "message",
				id: "u1",
				timestamp: "2026-05-19T00:00:00.000Z",
				message: { role: "user", content: "/skill:tdd please help" },
			}),
			sessionLine({
				type: "message",
				id: "a1",
				timestamp: "2026-05-19T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/skills/diagnose/SKILL.md" } }],
				},
			}),
		].join("\n"));

		const store = new MemoryStore();
		const result = scanSessionHistory({ sessionsRoot: root, registry: registry(), store });

		expect(result.inserted).toBe(2);
		expect(store.events.map((event) => [event.skill, event.project])).toEqual([
			["tdd", "/project"],
			["diagnose", "/project"],
		]);
	});

	test("scans expanded XML-style skill usage", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-scan-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		writeFileSync(join(dir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({
				type: "message",
				id: "u1",
				message: {
					role: "user",
					content: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">\n# Diagnose\n</skill>',
				},
			}),
		].join("\n"));

		const store = new MemoryStore();
		const result = scanSessionHistory({ sessionsRoot: root, registry: registry(), store });

		expect(result.inserted).toBe(1);
		expect(store.events.map((event) => [event.skill, event.project])).toEqual([
			["diagnose", "/project"],
		]);
	});

	test("suppresses same-turn duplicate skill reads and is idempotent", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-scan-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		writeFileSync(join(dir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({ type: "message", id: "u1", message: { role: "user", content: "/skill:tdd" } }),
			sessionLine({
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/skills/tdd/SKILL.md" } }],
				},
			}),
		].join("\n"));

		const store = new MemoryStore();
		const first = scanSessionHistory({ sessionsRoot: root, registry: registry(), store });
		const second = scanSessionHistory({ sessionsRoot: root, registry: registry(), store });

		expect(first.inserted).toBe(1);
		expect(second.inserted).toBe(0);
		expect(second.skipped).toBe(1);
		expect(store.events.map((event) => event.skill)).toEqual(["tdd"]);
	});

	test("scans tool calls from session files idempotently", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-tool-scan-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		writeFileSync(join(dir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({
				type: "message",
				id: "a1",
				timestamp: "2026-05-19T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "read", arguments: { path: "/skills/diagnose/SKILL.md" } },
						{ type: "toolCall", name: "bash", arguments: { command: "bun test" } },
					],
				},
			}),
		].join("\n"));

		const store = new MemoryStore();
		const first = scanToolSessionHistory({ sessionsRoot: root, store });
		const second = scanToolSessionHistory({ sessionsRoot: root, store });

		expect(first.inserted).toBe(2);
		expect(second.inserted).toBe(0);
		expect(second.skipped).toBe(2);
		expect(store.toolEvents.map((event) => [event.tool, event.project])).toEqual([
			["read", "/project"],
			["bash", "/project"],
		]);
	});

	test("reports progress while scanning skill calls", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-scan-progress-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		writeFileSync(join(dir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({ type: "message", id: "u1", message: { role: "user", content: "/skill:tdd" } }),
		].join("\n"));

		const store = new MemoryStore();
		const progress: Array<{ phase: string; files: number; totalFiles?: number; inserted: number }> = [];
		const result = await scanSessionHistoryWithProgress({
			sessionsRoot: root,
			registry: registry(),
			store,
			yieldEveryFiles: 1,
			onProgress: (snapshot) => progress.push({
				phase: snapshot.phase,
				files: snapshot.files,
				totalFiles: snapshot.totalFiles,
				inserted: snapshot.inserted,
			}),
		});

		expect(result.inserted).toBe(1);
		expect(progress[0]).toEqual({ phase: "discovering", files: 0, totalFiles: undefined, inserted: 0 });
		expect(progress.at(-1)).toEqual({ phase: "scanning", files: 1, totalFiles: 1, inserted: 1 });
	});


	test("reports progress while scanning tool calls", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-tool-scan-progress-"));
		const firstDir = join(root, "--project-a--");
		const secondDir = join(root, "--project-b--");
		mkdirSync(firstDir);
		mkdirSync(secondDir);
		writeFileSync(join(firstDir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project-a" }),
			sessionLine({
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
			}),
		].join("\n"));
		writeFileSync(join(secondDir, "session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project-b" }),
			sessionLine({
				type: "message",
				id: "a2",
				message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
			}),
		].join("\n"));

		const store = new MemoryStore();
		const progress: Array<{ phase: string; files: number; totalFiles?: number; inserted: number }> = [];
		const result = await scanToolSessionHistoryWithProgress({
			sessionsRoot: root,
			store,
			yieldEveryFiles: 1,
			onProgress: (snapshot) => progress.push({
				phase: snapshot.phase,
				files: snapshot.files,
				totalFiles: snapshot.totalFiles,
				inserted: snapshot.inserted,
			}),
		});

		expect(result.inserted).toBe(2);
		expect(progress[0]).toEqual({ phase: "discovering", files: 0, totalFiles: undefined, inserted: 0 });
		expect(progress.at(-1)).toEqual({ phase: "scanning", files: 2, totalFiles: 2, inserted: 2 });
		expect(progress.map((item) => item.files)).toEqual([0, 0, 1, 2]);
	});

	test("continues scanning when a session file cannot be read", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // chmod has no effect for root
		const root = mkdtempSync(join(tmpdir(), "pi-skill-scan-error-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		const blockedPath = join(dir, "a-blocked.jsonl");
		writeFileSync(blockedPath, sessionLine({ type: "session", cwd: "/project" }));
		chmodSync(blockedPath, 0o000);
		writeFileSync(join(dir, "b-session.jsonl"), [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({ type: "message", id: "u1", message: { role: "user", content: "/skill:tdd" } }),
		].join("\n"));

		const store = new MemoryStore();
		try {
			const result = scanSessionHistory({ sessionsRoot: root, registry: registry(), store });
			expect(result.errors).toBe(1);
			expect(result.inserted).toBe(1);
			expect(result.files).toBe(2);
		} finally {
			chmodSync(blockedPath, 0o600);
		}
	});

	test("falls back to the session file mtime for entries without timestamps", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-scan-mtime-"));
		const dir = join(root, "--project--");
		mkdirSync(dir);
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, [
			sessionLine({ type: "session", cwd: "/project" }),
			sessionLine({ type: "message", id: "u1", message: { role: "user", content: "/skill:tdd" } }),
		].join("\n"));
		const mtimeSeconds = 1_700_000_000;
		utimesSync(filePath, mtimeSeconds, mtimeSeconds);

		const store = new MemoryStore();
		scanSessionHistory({ sessionsRoot: root, registry: registry(), store });

		expect(store.events.map((event) => event.createdAt)).toEqual([mtimeSeconds]);
	});

	test("renders tool scan result title", () => {
		expect(renderScanResult({ files: 1, lines: 2, inserted: 3, skipped: 4, errors: 0, kind: "tool" })).toContain(
			"Tool stats scan complete",
		);
	});
});
