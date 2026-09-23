/**
 * Persisted pi-footer settings.
 *
 * The file lives in pi's agent dir and callers pass that dir in (index.ts uses
 * `getAgentDir()`, so `PI_CODING_AGENT_DIR` is honoured). Keeping the pi runtime
 * out of this module lets the store run against a temp directory in tests.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CONFIG_FILE_NAME = "pi-footer.json";

export type FooterConfig = {
	/** Show the live TPS stats line in the border. */
	showStats: boolean;
	/** Include the TTFT segment. */
	showTtft: boolean;
	/** "theme" follows the pi theme; otherwise one of the inherited presets. */
	colorPreset: string;
};

export const CONFIG_DEFAULTS: FooterConfig = { showStats: true, showTtft: true, colorPreset: "theme" };

export function footerConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

/** Result of a save attempt, as `FooterConfigStore.set()` reports it. */
export type SaveOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Notification for a finished save. A failed write must never be announced as a
 * success: the caller shows `message` at `level`, and an `error` level keeps the
 * failure visible with the errno/reason (EACCES, ENOSPC, …).
 */
export function describeSaveOutcome(
	label: string,
	outcome: SaveOutcome,
): { message: string; level: "info" | "error" } {
	if (outcome.ok) return { message: label, level: "info" };
	const { error } = outcome;
	const reason = error instanceof Error && error.message ? error.message : String(error);
	return { message: `${label} — not saved: ${reason}`, level: "error" };
}

/** The file's own keys, tolerating a missing, unreadable or malformed file. */
function readRecord(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		/* missing, unreadable or malformed → defaults */
	}
	return {};
}

/**
 * In-memory config with serialized, atomic persistence.
 *
 * - The in-memory value is the source of truth and updates synchronously, so the
 *   border repaints without waiting for the disk.
 * - Every `set()` queues a write; writes run in call order and each one writes the
 *   whole current snapshot. Rapid successive toggles therefore cannot clobber each
 *   other — unlike re-reading the file per save and merging a single field.
 * - A failed write rejects its own promise but neither blocks later writes nor
 *   reverts the in-memory value; the next `set()` retries the whole snapshot.
 * - Writes land in a sibling temp file and are renamed into place, so a reader
 *   never sees a half-written config (a crash can at most leave a stale .tmp).
 */
export class FooterConfigStore {
	private record: Record<string, unknown>;
	private queue: Promise<void> = Promise.resolve();
	/** Bumped on every in-memory change; `persistedRevision` tracks what the file holds. */
	private revision = 0;
	private persistedRevision = 0;

	constructor(private readonly path: string) {
		this.record = { ...CONFIG_DEFAULTS, ...readRecord(path) };
	}

	get current(): FooterConfig {
		return { ...this.record } as FooterConfig;
	}

	/** True while the in-memory config holds changes the file does not have yet. */
	get unsaved(): boolean {
		return this.persistedRevision !== this.revision;
	}

	/** Apply `update` in memory and queue a write of the full snapshot. */
	set(update: Partial<FooterConfig>): Promise<void> {
		this.record = { ...this.record, ...update };
		this.revision += 1;

		const write = this.queue.then(() => this.writeSnapshot());
		// Keep the queue alive after a failure so later writes still run (and carry
		// whatever the failed one missed); the caller gets the failure via `write`.
		this.queue = write.then(
			() => undefined,
			() => undefined,
		);
		return write;
	}

	/**
	 * Re-read the file (session start, or after a hand edit) and return the config.
	 * Unsaved in-memory changes win: a change that failed to persist must not vanish.
	 */
	reload(): FooterConfig {
		if (!this.unsaved) this.record = { ...CONFIG_DEFAULTS, ...readRecord(this.path) };
		return this.current;
	}

	private async writeSnapshot(): Promise<void> {
		// Snapshot synchronously: the memory can change during the awaits below, and
		// this write must record exactly the state it serialized.
		const revision = this.revision;
		const text = JSON.stringify(this.record, null, 2) + "\n";
		const tmp = `${this.path}.${process.pid}.tmp`;

		await mkdir(dirname(this.path), { recursive: true });
		try {
			await writeFile(tmp, text, "utf8");
			await rename(tmp, this.path);
		} catch (error) {
			await rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
		this.persistedRevision = Math.max(this.persistedRevision, revision);
	}
}
