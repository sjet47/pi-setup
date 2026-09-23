// Persistence tests for the /pi-footer config store. Every store is pointed at a
// temp directory, so the real ~/.pi/agent/pi-footer.json is never read or written.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DEFAULTS, CONFIG_FILE_NAME, FooterConfigStore, describeSaveOutcome, footerConfigPath } from "../config.ts";

function tempDir(prefix = "pi-footer-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// ── save outcome ─────────────────────────────────────────────────────────

test("a failed save is reported as an error, never as a success", () => {
	const failure = Object.assign(new Error("EACCES: permission denied, open '/x/pi-footer.json'"), {
		code: "EACCES",
	});
	const failed = describeSaveOutcome("showStats = off", { ok: false, error: failure });
	assert.equal(failed.level, "error");
	assert.match(failed.message, /^showStats = off — not saved: EACCES/);

	assert.deepEqual(describeSaveOutcome("showStats = off", { ok: true }), {
		message: "showStats = off",
		level: "info",
	});
});

test("a non-Error rejection still produces a readable error message", () => {
	const outcome = describeSaveOutcome("colorPreset = nord", { ok: false, error: "disk full" });
	assert.equal(outcome.level, "error");
	assert.equal(outcome.message, "colorPreset = nord — not saved: disk full");
});

// ── path resolution ──────────────────────────────────────────────────────

test("the config file lives in the agent dir, not in $HOME", () => {
	// `agentDir` is what index.ts feeds from pi's getAgentDir(), which returns
	// $PI_CODING_AGENT_DIR verbatim when it is set — so an override must land
	// here and the default ~/.pi/agent must never be baked in.
	const dir = tempDir();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		assert.equal(footerConfigPath(agentDir), join(dir, CONFIG_FILE_NAME));
		assert.equal(footerConfigPath(agentDir).startsWith(tmpdir()), true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writes go to the agent dir given at construction, creating it if missing", async () => {
	const dir = tempDir();
	const agentDir = join(dir, "agent"); // PI_CODING_AGENT_DIR may point at a fresh dir
	try {
		const store = new FooterConfigStore(footerConfigPath(agentDir));
		await store.set({ showStats: false });

		assert.deepEqual(readJson(join(agentDir, CONFIG_FILE_NAME)), { ...CONFIG_DEFAULTS, showStats: false });
		assert.deepEqual(readdirSync(agentDir), [CONFIG_FILE_NAME]); // no temp file left behind
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── loading ──────────────────────────────────────────────────────────────

test("a missing file falls back to defaults and is not written until a change", () => {
	const dir = tempDir();
	try {
		const store = new FooterConfigStore(footerConfigPath(dir));
		assert.deepEqual(store.current, CONFIG_DEFAULTS);
		assert.equal(store.unsaved, false);
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed JSON falls back to defaults", () => {
	const dir = tempDir();
	try {
		writeFileSync(join(dir, CONFIG_FILE_NAME), "{ not json", "utf8");
		const store = new FooterConfigStore(footerConfigPath(dir));
		assert.deepEqual(store.current, CONFIG_DEFAULTS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a partial file is merged over the defaults and unknown keys survive a write", async () => {
	const dir = tempDir();
	const path = footerConfigPath(dir);
	try {
		writeFileSync(path, JSON.stringify({ showTtft: false, handEdited: "keep me" }), "utf8");
		const store = new FooterConfigStore(path);
		assert.deepEqual(store.current, { ...CONFIG_DEFAULTS, showTtft: false, handEdited: "keep me" });

		await store.set({ colorPreset: "nord" });
		assert.deepEqual(readJson(path), {
			...CONFIG_DEFAULTS,
			showTtft: false,
			colorPreset: "nord",
			handEdited: "keep me",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── rapid successive changes ─────────────────────────────────────────────

test("three saves in the same tick all survive (no lost update)", async () => {
	const dir = tempDir();
	const path = footerConfigPath(dir);
	try {
		const store = new FooterConfigStore(path);

		// The old code re-read the file per save and merged one field, so each
		// save raced the previous (still unawaited) write and dropped it.
		const writes = [
			store.set({ showStats: false }),
			store.set({ showTtft: false }),
			store.set({ colorPreset: "nord" }),
		];
		assert.deepEqual(store.current, { showStats: false, showTtft: false, colorPreset: "nord" });

		await Promise.all(writes);
		assert.deepEqual(readJson(path), { showStats: false, showTtft: false, colorPreset: "nord" });
		assert.equal(store.unsaved, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("save order is preserved even when a write is slow", async () => {
	const dir = tempDir();
	const path = footerConfigPath(dir);
	try {
		const store = new FooterConfigStore(path);
		const first = store.set({ colorPreset: "morandi" });
		const second = store.set({ colorPreset: "ocean" });
		await Promise.all([first, second]);

		// Writes are serialized in call order, so the last one wins on disk.
		assert.equal(readJson(path).colorPreset, "ocean");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── write failures ───────────────────────────────────────────────────────

test("a failed write rejects, keeps the in-memory value and leaves no partial file", async () => {
	const dir = tempDir();
	const blocker = join(dir, "not-a-dir");
	writeFileSync(blocker, "", "utf8"); // mkdir(<blocker>, { recursive: true }) → EEXIST
	const path = join(blocker, CONFIG_FILE_NAME);
	try {
		const store = new FooterConfigStore(path);
		await assert.rejects(store.set({ showStats: false }), (error: NodeJS.ErrnoException) => {
			assert.equal(error.code, "EEXIST");
			return true;
		});

		// Session-effective value survives, and it is reported as not persisted.
		assert.equal(store.current.showStats, false);
		assert.equal(store.unsaved, true);
		assert.equal(readFileSync(blocker, "utf8"), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a write that fails at rename keeps the previous file and cleans up the temp file", async () => {
	const dir = tempDir();
	const path = footerConfigPath(dir);
	try {
		writeFileSync(path, JSON.stringify({ showStats: true, showTtft: true, colorPreset: "theme" }), "utf8");
		const store = new FooterConfigStore(path);

		// Turn the target into a non-empty directory: the temp file writes fine but
		// rename() cannot replace it.
		rmSync(path);
		mkdirSync(path);
		writeFileSync(join(path, "keep"), "", "utf8");

		await assert.rejects(store.set({ showStats: false }));
		assert.equal(store.unsaved, true);
		// The old config is untouched and the partial temp file is gone.
		assert.equal(readFileSync(join(path, "keep"), "utf8"), "");
		assert.deepEqual(
			readdirSync(dir).filter((entry) => entry.endsWith(".tmp")),
			[],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unwritable agent dir surfaces EACCES and keeps the change in memory", {
	skip: process.getuid?.() === 0 ? "read-only directories do not stop root" : false,
}, async () => {
	const dir = tempDir();
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	chmodSync(agentDir, 0o555); // the real-world EACCES/ENOSPC case
	try {
		const store = new FooterConfigStore(footerConfigPath(agentDir));
		await assert.rejects(store.set({ showStats: false }), (error: NodeJS.ErrnoException) => {
			assert.equal(error.code, "EACCES");
			return true;
		});
		assert.equal(store.current.showStats, false);
		assert.equal(store.unsaved, true);
	} finally {
		chmodSync(agentDir, 0o755);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed write does not block later writes, which retry the whole snapshot", async () => {
	const dir = tempDir();
	const blocker = join(dir, "not-a-dir");
	writeFileSync(blocker, "", "utf8");
	const path = join(blocker, CONFIG_FILE_NAME);
	try {
		const store = new FooterConfigStore(path);
		await assert.rejects(store.set({ showStats: false }));

		// The obstruction is gone; the next save must carry the unsaved change too.
		rmSync(blocker);
		await store.set({ colorPreset: "ice" });

		assert.deepEqual(readJson(path), { showStats: false, showTtft: true, colorPreset: "ice" });
		assert.equal(store.unsaved, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed writes keep the queue ordered and the following write still wins", async () => {
	const dir = tempDir();
	const blocker = join(dir, "not-a-dir");
	writeFileSync(blocker, "", "utf8");
	const path = join(blocker, CONFIG_FILE_NAME);
	try {
		const store = new FooterConfigStore(path);
		const failures = [store.set({ showStats: false }), store.set({ showTtft: false })];
		const results = await Promise.allSettled(failures);
		assert.deepEqual(
			results.map((result) => result.status),
			["rejected", "rejected"],
		);
		assert.deepEqual(store.current, { ...CONFIG_DEFAULTS, showStats: false, showTtft: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── reload ───────────────────────────────────────────────────────────────

test("reload picks up an external hand edit when everything is saved", async () => {
	const dir = tempDir();
	const path = footerConfigPath(dir);
	try {
		const store = new FooterConfigStore(path);
		await store.set({ showStats: false });

		writeFileSync(path, JSON.stringify({ ...CONFIG_DEFAULTS, colorPreset: "dusk" }), "utf8");
		assert.deepEqual(store.reload(), { ...CONFIG_DEFAULTS, colorPreset: "dusk" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload does not discard a change whose write failed", async () => {
	const dir = tempDir();
	const blocker = join(dir, "not-a-dir");
	writeFileSync(blocker, "", "utf8");
	const path = join(blocker, CONFIG_FILE_NAME);
	try {
		const store = new FooterConfigStore(path);
		await assert.rejects(store.set({ showStats: false }));

		// A session restart (/new, /resume) must not silently revert it.
		assert.equal(store.reload().showStats, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
