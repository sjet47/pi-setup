// pi-note settings, read from the agent's `settings.json` the same way
// `readExternalEditorSetting` reads `externalEditor`. No pi imports: the
// normalization is pure and the file read is one JSON.parse, so both are
// unit-testable against a throwaway agent dir.
//
// Every failure mode (missing file, unreadable file, malformed JSON, wrong
// types) falls back to the defaults, and the default for the refresh switch is
// "on": a broken settings file must not silently disable a safety feature.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REFRESH_MAX_CHARS } from "./refresh.ts";

export interface NoteSettings {
	/** Announce MEMORY.md changes made between turns. Defaults to true. */
	memoryRefresh: boolean;
	/** Cap on the MEMORY.md content copied into one refresh message. */
	memoryRefreshMaxChars: number;
}

/** Defaults, also used when `settings.json` cannot be read. */
export const DEFAULT_NOTE_SETTINGS: NoteSettings = {
	memoryRefresh: true,
	memoryRefreshMaxChars: DEFAULT_REFRESH_MAX_CHARS,
};

/** Largest accepted cap, so a typo cannot put the whole index into every turn. */
const MAX_REFRESH_CHARS_LIMIT = 200_000;

/**
 * Normalize a parsed `settings.json` into pi-note's settings. Unknown and
 * mistyped values fall back to the defaults rather than throwing; only an
 * explicit `false` disables the refresh.
 * @param raw - parsed settings object, or anything a failed read produced.
 * @returns the settings to use.
 */
export function normalizeNoteSettings(raw: unknown): NoteSettings {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_NOTE_SETTINGS };
	const record = raw as { memoryRefresh?: unknown; memoryRefreshMaxChars?: unknown };
	const memoryRefresh = record.memoryRefresh === false ? false : true;
	const configured = record.memoryRefreshMaxChars;
	const memoryRefreshMaxChars =
		typeof configured === "number" && Number.isFinite(configured) && configured >= 1
			? Math.min(Math.floor(configured), MAX_REFRESH_CHARS_LIMIT)
			: DEFAULT_NOTE_SETTINGS.memoryRefreshMaxChars;
	return { memoryRefresh, memoryRefreshMaxChars };
}

/**
 * Read pi-note's settings from `<agentDir>/settings.json`. An unreadable or
 * malformed file yields the defaults (refresh on) instead of an error.
 * @param agentDir - pi's agent directory, as returned by `getAgentDir()`.
 * @returns the settings to use.
 */
export function readNoteSettings(agentDir: string): NoteSettings {
	try {
		return normalizeNoteSettings(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")));
	} catch {
		return { ...DEFAULT_NOTE_SETTINGS };
	}
}
