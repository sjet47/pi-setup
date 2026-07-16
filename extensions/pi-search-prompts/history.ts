import { readFile } from "node:fs/promises";
import { parseSessionEntries, SessionManager, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";

export interface PromptHistoryEntry {
	id: string;
	text: string;
	timestamp: number;
	cwd?: string;
}

export function currentSessionPrompts(sessionManager: { getEntries(): SessionEntry[]; getCwd(): string }): PromptHistoryEntry[] {
	return promptsFromEntries(sessionManager.getEntries(), sessionManager.getCwd());
}

export async function globalPrompts(): Promise<PromptHistoryEntry[]> {
	const sessions = await SessionManager.listAll();
	const prompts: PromptHistoryEntry[] = [];
	const batchSize = 16;
	for (let start = 0; start < sessions.length; start += batchSize) {
		const batch = sessions.slice(start, start + batchSize);
		const promptLists = await Promise.all(batch.map(async (session) => {
			try {
				const content = await readFile(session.path, "utf8");
				return promptsFromEntries(parseSessionEntries(content), session.cwd);
			} catch {
				// A concurrently deleted or malformed session must not disable search.
				return [];
			}
		}));
		prompts.push(...promptLists.flat());
	}
	return sortAndDedupe(prompts);
}

export function promptsFromEntries(entries: FileEntry[], cwd?: string): PromptHistoryEntry[] {
	const prompts: PromptHistoryEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = userContentToText(entry.message.content).trim();
		if (!text) continue;
		prompts.push({
			id: entry.id,
			text,
			timestamp: timestampOf(entry.timestamp, entry.message.timestamp),
			cwd,
		});
	}
	return sortAndDedupe(prompts);
}

function userContentToText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function timestampOf(entryTimestamp: string, messageTimestamp: number): number {
	if (Number.isFinite(messageTimestamp)) return messageTimestamp;
	const parsed = Date.parse(entryTimestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function sortAndDedupe(prompts: PromptHistoryEntry[]): PromptHistoryEntry[] {
	const unique = new Map<string, PromptHistoryEntry>();
	for (const prompt of prompts) {
		const key = `${prompt.id}\u0000${prompt.text}`;
		const existing = unique.get(key);
		if (!existing || prompt.timestamp > existing.timestamp) unique.set(key, prompt);
	}
	return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp);
}
