// MEMORY.md refresh tests: the turn window, the change judge, and the rendered
// message. Real files in temp dirs — nothing touches ~/.pi/agent/pi-note — plus
// an injected probe for the "file moved under the read" case, which real fs
// cannot reproduce on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	baselineFromSnapshot,
	buildMemoryRefresh,
	deliveredRefreshIds,
	diffIndexLines,
	MEMORY_REFRESH_CUSTOM_TYPE,
	MemoryRefreshTracker,
	probeIndex,
	type IndexProbe,
	type IndexProbeFn,
	type IndexSnapshot,
} from "../refresh.ts";

const PREFIX = "- [Old](old.md) — the memory the session started with";

let tick = 0;

/** Write MEMORY.md and force a distinct mtime, so the fast path cannot hide it. */
function writeIndex(path: string, content: string): void {
	writeFileSync(path, content, "utf8");
	const stamp = new Date(Date.now() + 1000 * ++tick);
	utimesSync(path, stamp, stamp);
}

interface Fixture {
	indexPath: string;
	dir: string;
}

/** Temp memory dir with one MEMORY.md holding `content`, plus its baseline. */
function fixture(content: string): { paths: Fixture; baseline: IndexSnapshot } {
	const dir = mkdtempSync(join(tmpdir(), "pi-note-refresh-"));
	const indexPath = join(dir, "MEMORY.md");
	writeFileSync(indexPath, content, "utf8");
	const stat = statSync(indexPath, { bigint: true });
	return {
		paths: { indexPath, dir },
		baseline: baselineFromSnapshot(readFileSync(indexPath, "utf8"), {
			mtimeNs: stat.mtimeNs,
			size: Number(stat.size),
		}),
	};
}

function openTracker(paths: Fixture, baseline: IndexSnapshot, maxChars?: number, probe?: IndexProbeFn) {
	return new MemoryRefreshTracker({
		indexPath: paths.indexPath,
		baseline,
		...(maxChars === undefined ? {} : { maxChars }),
		...(probe === undefined ? {} : { probe }),
	});
}

// 1. An external write during the idle window is announced, with the new content.
test("a MEMORY.md change made while idle is announced on the next turn", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const tracker = openTracker(paths, baseline);
		const added = "- [Cli prefs](cli-prefs.md) — jq and glab";
		writeIndex(paths.indexPath, `${PREFIX}\n${added}\n`);

		const announcement = tracker.beginTurn();
		assert.ok(announcement);
		assert.equal(announcement.refreshId, "refresh-1");
		assert.match(announcement.text, /^Updated memory: .*MEMORY\.md$/m);
		assert.match(announcement.text, /stale — including the Memory index snapshot/);
		assert.match(announcement.text, /Added index lines:\n- \[Cli prefs\]\(cli-prefs\.md\) — jq and glab/);
		assert.match(announcement.text, new RegExp(`Current MEMORY\\.md at .*MEMORY\\.md:`));
		assert.ok(announcement.text.endsWith(`${PREFIX}\n${added}\n`));

		// Delivered, so the baseline moves on and the next turn is silent.
		tracker.endTurn(new Set([announcement.refreshId]));
		assert.equal(tracker.beginTurn(), undefined);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 2. No change: one stat, no message.
test("an unchanged index announces nothing", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const tracker = openTracker(paths, baseline);
		assert.equal(tracker.beginTurn(), undefined);
		assert.equal(tracker.beginTurn(), undefined);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 3. mtime moved but bytes are identical (`touch`, an editor saving in place).
test("a touch with identical content announces nothing", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const tracker = openTracker(paths, baseline);
		writeIndex(paths.indexPath, `${PREFIX}\n`); // new mtime, same bytes
		assert.notEqual(statSync(paths.indexPath, { bigint: true }).mtimeNs, baseline.kind === "present" ? baseline.mtimeNs : 0n);
		assert.equal(tracker.beginTurn(), undefined);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 4. Window semantics: the session's own write inside its turn is not echoed.
test("a write made during this session's own turn is adopted, not announced", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const tracker = openTracker(paths, baseline);
		assert.equal(tracker.beginTurn(), undefined); // turn starts, nothing stale

		// The agent writes a memory + its index line mid-turn (no tool hooks needed).
		const own = "- [Ours](ours.md) — written by this session";
		writeIndex(paths.indexPath, `${PREFIX}\n${own}\n`);
		tracker.endTurn(new Set()); // turn ends: closing baseline

		assert.equal(tracker.beginTurn(), undefined);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 5. An announcement that never reached the run is not adopted.
test("an undelivered announcement keeps the old baseline and is repeated", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const tracker = openTracker(paths, baseline);
		writeIndex(paths.indexPath, `${PREFIX}\n- [New](new.md) — x\n`);

		const first = tracker.beginTurn();
		assert.ok(first);
		// Aborted between the injection and the loop: the message never entered
		// the run, so `endTurn` sees no delivered id.
		tracker.endTurn(new Set());
		assert.equal(tracker.baseline, baseline);

		const second = tracker.beginTurn();
		assert.ok(second);
		assert.equal(second.text, first.text);
		assert.notEqual(second.refreshId, first.refreshId);

		tracker.endTurn(new Set([second.refreshId]));
		assert.equal(tracker.beginTurn(), undefined);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 6. Removal and re-creation.
test("a deleted index is announced as removed, a new one as created", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const tracker = openTracker(paths, baseline);
		rmSync(paths.indexPath);
		const removed = tracker.beginTurn();
		assert.ok(removed);
		assert.match(removed.text, /^Memory index removed: /);
		assert.match(removed.text, /was deleted while this session was idle/);
		tracker.endTurn(new Set([removed.refreshId]));
		assert.equal(tracker.beginTurn(), undefined); // still gone: nothing new

		writeIndex(paths.indexPath, "- [Back](back.md) — recreated\n");
		const created = tracker.beginTurn();
		assert.ok(created);
		assert.match(created.text, /^Memory index created: /);
		assert.match(created.text, /- \[Back\]\(back\.md\) — recreated/);
		tracker.endTurn(new Set([created.refreshId]));
		assert.equal(tracker.beginTurn(), undefined);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 7. Budgets: per-line length, lines per side, and total content.
test("the announcement is bounded: line length, line count, content budget", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const longHook = `- [Long](long.md) — ${"x".repeat(400)}`;
		const added = Array.from({ length: 25 }, (_unused, index) => `- [M${index}](m${index}.md) — hook ${index}`);
		const body = [PREFIX, longHook, ...added].join("\n");
		const tracker = openTracker(paths, baseline, 120);
		writeIndex(paths.indexPath, `${body}\n`);

		const announcement = tracker.beginTurn();
		assert.ok(announcement);
		const text = announcement.text;
		// 20 lines are listed (the long one first, in file order) and 6 are hidden.
		assert.match(text, /… and 6 more/);
		assert.ok(!text.includes(`- [M19](m19.md)`));
		// A 400-character hook is cut at the 160-character line budget.
		const longLine = text.split("\n").find((line) => line.startsWith("- [Long]"));
		assert.ok(longLine);
		assert.equal(longLine.length, 160);
		assert.ok(longLine.endsWith("…"));
		// Content is capped and says where the rest is.
		assert.match(text, /\(index truncated at 120 characters; read .*MEMORY\.md for the rest\)/);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// 8. A read that races a write is skipped, not half-adopted.
test("an unstable read skips this turn and leaves the baseline alone", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		writeIndex(paths.indexPath, `${PREFIX}\n- [New](new.md) — x\n`);
		let calls = 0;
		const fake: IndexProbeFn = (indexPath, previous): IndexProbe => {
			calls += 1;
			return calls === 1 ? { kind: "unstable" } : probeIndex(indexPath, previous);
		};
		const tracker = openTracker(paths, baseline, undefined, fake);

		assert.equal(tracker.beginTurn(), undefined); // unstable: nothing announced
		assert.equal(tracker.baseline, baseline); // and nothing adopted
		const second = tracker.beginTurn();
		assert.ok(second); // the change is still there next turn
		assert.match(second.text, /Added index lines:/);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

// The pure helpers behind the announcement, exercised directly.
test("diffIndexLines keeps file order and ignores non-entry lines", () => {
	const diff = diffIndexLines(
		"- [A](a.md) — a\nsome prose\n- [B](b.md) — b\n",
		"- [B](b.md) — b\n- [C](c.md) — c\nsome prose\n",
	);
	assert.deepEqual(diff.added, ["- [C](c.md) — c"]);
	assert.deepEqual(diff.removed, ["- [A](a.md) — a"]);
	assert.equal(diff.addedHidden, 0);
	assert.equal(diff.removedHidden, 0);
});

test("buildMemoryRefresh reports in-place wording changes", () => {
	const text = buildMemoryRefresh({
		indexPath: "/mem/MEMORY.md",
		previous: baselineFromSnapshot("Intro one.\n- [A](a.md) — same hook\n"),
		current: baselineFromSnapshot("Intro two.\n- [A](a.md) — same hook\n"),
	});
	assert.match(text, /No index lines were added or removed; the wording changed in place\./);
});

test("buildMemoryRefresh renders an empty index without copying anything", () => {
	const text = buildMemoryRefresh({
		indexPath: "/mem/MEMORY.md",
		previous: baselineFromSnapshot("- [A](a.md) — a\n"),
		current: baselineFromSnapshot(""),
	});
	assert.match(text, /\(the index is empty\)/);
});

test("deliveredRefreshIds only counts this plugin's custom messages", () => {
	const ids = deliveredRefreshIds([
		{ role: "user", content: "hi" },
		{ role: "custom", customType: "other", details: { refreshId: "nope" } },
		{ role: "custom", customType: MEMORY_REFRESH_CUSTOM_TYPE, details: { refreshId: "refresh-3" } },
		{ role: "custom", customType: MEMORY_REFRESH_CUSTOM_TYPE, details: undefined },
		"not a message",
		null,
	]);
	assert.deepEqual([...ids], ["refresh-3"]);
});

test("the baseline built from a snapshot matches a probe of the same bytes", () => {
	const { paths, baseline } = fixture(`${PREFIX}\n`);
	try {
		const probe = probeIndex(paths.indexPath, baseline);
		assert.equal(probe.kind, "present");
		if (probe.kind === "present" && baseline.kind === "present") {
			assert.equal(probe.digest, baseline.digest);
			assert.equal(probe.content, baseline.content);
		}
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});
