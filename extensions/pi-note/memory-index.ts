// Pure model for the `/memory` browser: turn MEMORY.md plus a listing of the
// memory dir into the topic rows the overlay renders. No fs, no pi imports —
// unit-testable in isolation, like paths.ts / prompt.ts.
//
// The index is the only thing the model ever sees, so it is the source of
// truth for order and titles; files on disk that the index does not mention
// ("orphans") are appended, because a memory file with no index line is
// invisible to every future session and showing it is the only way to notice.
import { MEMORY_INDEX_NAME } from "./paths.ts";

export interface MemoryTopic {
	/** Link text from MEMORY.md; the file name for an unindexed file. */
	title: string;
	/** File name relative to the memory dir, e.g. `cli-preferences.md`. */
	file: string;
	/** One-line hook after the link; "" when the index line has none. */
	hook: string;
	/** false when the file exists but MEMORY.md has no line pointing at it. */
	indexed: boolean;
	/** false when the index points at a file that is not on disk. */
	exists: boolean;
}

/** `- [Title](file.md) — hook`; bullet or numbered list item. */
const INDEX_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]\(([^)]+)\)\s*(.*)$/;
/** Separator between the link and the hook text: `— hook`, `- hook`, `: hook`. */
const HOOK_SEPARATOR = /^\s*[—–\-:·|]+\s*/;
/** `scheme:` prefixes (http:, mailto:, …) and bare anchors are not memory files. */
const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|#)/i;
/** Markdown link titles: `[t](file.md "Title")` — keep only the target. */
const LINK_TITLE = /^(\S+)\s+["']/;

/** Strip the separator that follows the link: `— hook` -> `hook`. */
export function stripHook(raw: string): string {
	return raw.replace(HOOK_SEPARATOR, "").trim();
}

/**
 * Normalize a markdown link target to a file name relative to the memory dir,
 * or undefined when it is not a memory file (`<file.md>`, `./file.md`,
 * `file.md "Title"` and percent-encoding are all accepted).
 */
export function normalizeLink(raw: string): string | undefined {
	let link = raw.trim();
	const angle = /^<(.*)>$/.exec(link);
	if (angle) link = angle[1].trim();
	const title = LINK_TITLE.exec(link);
	if (title) link = title[1];
	try {
		link = decodeURIComponent(link);
	} catch {
		// Malformed escapes: keep the raw target rather than dropping the line.
	}
	link = link.replace(/^\.\//, "");
	if (link === "" || EXTERNAL_LINK.test(link)) return undefined;
	return link;
}

/** Index lines in file order, deduplicated by target file. */
export function parseIndex(indexText: string): MemoryTopic[] {
	const topics: MemoryTopic[] = [];
	const seen = new Set<string>();
	for (const line of indexText.split("\n")) {
		const match = INDEX_LINE.exec(line);
		if (!match) continue;
		const file = normalizeLink(match[2]);
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		topics.push({
			title: match[1].trim() || file,
			file,
			hook: stripHook(match[3]),
			indexed: true,
			exists: true,
		});
	}
	return topics;
}

/**
 * Topic rows for the browser: index entries (order preserved) followed by
 * memory files the index does not mention, sorted by name.
 *
 * `fileNames` is a flat listing of the memory dir; pass undefined when the
 * listing is unavailable, in which case nothing is marked missing. Only
 * names without a separator are checked against the listing — a nested
 * `sub/x.md` target is assumed fine rather than reported missing.
 */
export function buildTopics(indexText: string, fileNames?: string[]): MemoryTopic[] {
	const indexed = parseIndex(indexText);
	const listed = fileNames === undefined ? undefined : new Set(fileNames);
	for (const topic of indexed) {
		if (listed === undefined || topic.file.includes("/")) continue;
		topic.exists = listed.has(topic.file);
	}
	const indexedFiles = new Set(indexed.map((topic) => topic.file));
	const orphans = (fileNames ?? [])
		.filter(
			(name) =>
				name.toLowerCase().endsWith(".md") &&
				name !== MEMORY_INDEX_NAME &&
				!indexedFiles.has(name),
		)
		.sort((a, b) => a.localeCompare(b))
		.map<MemoryTopic>((name) => ({
			title: name,
			file: name,
			hook: "",
			indexed: false,
			exists: true,
		}));
	return [...indexed, ...orphans];
}

/** Text a topic is searched by (title, file name and hook). */
export function topicMatchText(topic: MemoryTopic): string {
	return topic.indexed
		? `${topic.title} ${topic.file} ${topic.hook}`
		: topic.file;
}
