import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { UsageDetector } from "./detector";
import type { SkillRegistry } from "./registry";
import type { SkillStatsStore } from "./store";

export interface ScanSessionHistoryOptions {
	sessionsRoot: string;
	store: SkillStatsStore;
	defaultProject?: string;
}

export interface SkillScanSessionHistoryOptions extends ScanSessionHistoryOptions {
	registry: SkillRegistry;
}

export interface ScanSessionHistoryProgress {
	phase: "discovering" | "scanning";
	files: number;
	totalFiles?: number;
	lines: number;
	inserted: number;
	skipped: number;
	errors: number;
	kind: ScanSessionHistoryKind;
}

interface AsyncScanOptionsMixin {
	onProgress?: (progress: ScanSessionHistoryProgress) => void;
	yieldEveryFiles?: number;
}

export interface AsyncScanSessionHistoryOptions extends ScanSessionHistoryOptions, AsyncScanOptionsMixin {}

export interface AsyncSkillScanSessionHistoryOptions extends SkillScanSessionHistoryOptions, AsyncScanOptionsMixin {}

export type ScanSessionHistoryKind = "skill" | "tool";

export interface ScanSessionHistoryResult {
	files: number;
	lines: number;
	inserted: number;
	skipped: number;
	errors: number;
	kind: ScanSessionHistoryKind;
}

type InternalScanOptions = ScanSessionHistoryOptions & {
	registry?: SkillRegistry;
	kind: ScanSessionHistoryKind;
};

interface SessionEntryLike {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		timestamp?: unknown;
	};
}

export function scanSessionHistory(options: SkillScanSessionHistoryOptions): ScanSessionHistoryResult {
	return scanSessionHistoryByKind({ ...options, kind: "skill" });
}

export function scanToolSessionHistory(options: ScanSessionHistoryOptions): ScanSessionHistoryResult {
	return scanSessionHistoryByKind({ ...options, kind: "tool" });
}

export async function scanSessionHistoryWithProgress(options: AsyncSkillScanSessionHistoryOptions): Promise<ScanSessionHistoryResult> {
	return scanSessionHistoryByKindWithProgress({ ...options, kind: "skill" });
}

export async function scanToolSessionHistoryWithProgress(options: AsyncScanSessionHistoryOptions): Promise<ScanSessionHistoryResult> {
	return scanSessionHistoryByKindWithProgress({ ...options, kind: "tool" });
}

function createDetector(options: InternalScanOptions): UsageDetector | undefined {
	return options.kind === "skill" && options.registry ? new UsageDetector(options.registry) : undefined;
}

function scanSessionHistoryByKind(options: InternalScanOptions): ScanSessionHistoryResult {
	const detector = createDetector(options);
	const result: ScanSessionHistoryResult = { files: 0, lines: 0, inserted: 0, skipped: 0, errors: 0, kind: options.kind };

	for (const filePath of listJsonlFiles(options.sessionsRoot, () => (result.errors += 1))) {
		result.files += 1;
		scanSessionFile(filePath, detector, options, result);
	}

	return result;
}

async function scanSessionHistoryByKindWithProgress(
	options: InternalScanOptions & AsyncScanOptionsMixin,
): Promise<ScanSessionHistoryResult> {
	const detector = createDetector(options);
	const result: ScanSessionHistoryResult = { files: 0, lines: 0, inserted: 0, skipped: 0, errors: 0, kind: options.kind };
	const yieldEveryFiles = options.yieldEveryFiles ?? 10;

	options.onProgress?.(progressSnapshot(result, "discovering"));
	const filePaths = listJsonlFiles(options.sessionsRoot, () => (result.errors += 1));
	options.onProgress?.(progressSnapshot(result, "scanning", filePaths.length));

	for (const filePath of filePaths) {
		result.files += 1;
		scanSessionFile(filePath, detector, options, result);
		options.onProgress?.(progressSnapshot(result, "scanning", filePaths.length));
		if (yieldEveryFiles > 0 && result.files % yieldEveryFiles === 0) await nextTick();
	}

	return result;
}

function scanSessionFile(
	filePath: string,
	detector: UsageDetector | undefined,
	options: InternalScanOptions,
	result: ScanSessionHistoryResult,
): void {
	let project = options.defaultProject ?? "unknown";
	const fileKey = sessionFileKey(filePath);
	let content: string;
	let fallbackSeconds: number;
	try {
		fallbackSeconds = Math.floor(statSync(filePath).mtimeMs / 1000);
		content = readFileSync(filePath, "utf8");
	} catch {
		result.errors += 1;
		return;
	}
	const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

	detector?.endTurn();
	for (let index = 0; index < lines.length; index += 1) {
		result.lines += 1;
		let entry: SessionEntryLike;
		try {
			entry = JSON.parse(lines[index]) as SessionEntryLike;
		} catch {
			result.errors += 1;
			continue;
		}

		if (entry.type === "session") {
			if (typeof entry.cwd === "string" && entry.cwd.length > 0) project = entry.cwd;
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;
		const role = message.role;
		if (role === "user") {
			detector?.startTurn();
			if (options.kind === "skill" && detector) {
				const text = contentToText(message.content);
				if (!text) continue;
				const createdAt = timestampSeconds(entry, fallbackSeconds);
				for (const usage of detector.detectInput(text)) {
					const inserted = options.store.insert({
						skill: usage.skill,
						project,
						createdAt,
						originKey: skillOriginKey(fileKey, entryIdOf(entry, index), usage.skill),
					});
					if (inserted) result.inserted += 1;
					else result.skipped += 1;
				}
			}
			continue;
		}

		if (role !== "assistant") continue;
		const createdAt = timestampSeconds(entry, fallbackSeconds);
		if (options.kind === "skill" && detector) {
			for (const readPath of readToolCallPaths(message.content)) {
				const usage = detector.detectSkillRead(readPath);
				if (!usage) continue;
				const inserted = options.store.insert({
					skill: usage.skill,
					project,
					createdAt,
					originKey: skillOriginKey(fileKey, entryIdOf(entry, index), usage.skill),
				});
				if (inserted) result.inserted += 1;
				else result.skipped += 1;
			}
		} else if (options.kind === "tool") {
			for (const tool of toolCallNames(message.content)) {
				const inserted = options.store.insertTool({
					tool,
					project,
					createdAt,
					originKey: toolOriginKey(fileKey, entryIdOf(entry, index), tool),
				});
				if (inserted) result.inserted += 1;
				else result.skipped += 1;
			}
		}
	}
}

function listJsonlFiles(root: string, onError?: () => void): string[] {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		onError?.();
		return files;
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...listJsonlFiles(path, onError));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files.sort();
}

function progressSnapshot(
	result: ScanSessionHistoryResult,
	phase: ScanSessionHistoryProgress["phase"],
	totalFiles?: number,
): ScanSessionHistoryProgress {
	return {
		phase,
		files: result.files,
		totalFiles,
		lines: result.lines,
		inserted: result.inserted,
		skipped: result.skipped,
		errors: result.errors,
		kind: result.kind,
	};
}

function nextTick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function contentToText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content
		.filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function readToolCallPaths(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const paths: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.name !== "read") continue;
		const args = parseArguments(block.arguments);
		if (typeof args.path === "string") paths.push(args.path);
	}
	return paths;
}

function toolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
		names.push(block.name);
	}
	return names;
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function timestampSeconds(entry: SessionEntryLike, fallbackSeconds: number): number {
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
	}
	const messageTimestamp = entry.message?.timestamp;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
		return messageTimestamp > 10_000_000_000 ? Math.floor(messageTimestamp / 1000) : Math.floor(messageTimestamp);
	}
	return fallbackSeconds;
}

function entryIdOf(entry: SessionEntryLike, lineIndex: number): string {
	return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : String(lineIndex + 1);
}

/**
 * Deterministic key for a session file, shared between live recording and scan
 * so that both derive identical origin keys for the same session entry.
 */
export function sessionFileKey(filePath: string): string {
	return createHash("sha1").update(resolve(filePath)).digest("hex").slice(0, 16);
}

export function skillOriginKey(fileKey: string, entryId: string, skill: string): string {
	return `scan:${fileKey}:${entryId}:${skill}`;
}

export function toolOriginKey(fileKey: string, entryId: string, tool: string): string {
	return `scan:${fileKey}:${entryId}:tool:${tool}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function renderScanResult(result: ScanSessionHistoryResult): string {
	const subject = result.kind === "tool" ? "Tool stats" : "Skill stats";
	return [
		`${subject} scan complete`,
		`Files: ${result.files}`,
		`Lines: ${result.lines}`,
		`Inserted: ${result.inserted}`,
		`Skipped duplicates: ${result.skipped}`,
		`Parse errors: ${result.errors}`,
	].join("\n");
}
