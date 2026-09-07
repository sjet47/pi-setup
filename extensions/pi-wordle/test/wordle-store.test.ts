// WordleGame session/persistence tests: use a throwaway data dir + a pinned
// clock, so nothing touches ~/.pi/agent/pi-wordle.
// Run: cd extensions/pi-wordle && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { answerForDay, isValidWord, MAX_TRIES } from "../wordle.ts";
import { WordleGame, type PersistedState } from "../wordle-store.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-wordle-"));
}

function pinned(isoDate: string): () => Date {
	return () => new Date(`${isoDate}T12:00:00`);
}

// Some common valid words that will almost surely not be the daily answer.
const GUESS_POOL = ["crane", "slate", "audio", "motel", "plier", "nymph"];

test("daily game: first-guess win records stats exactly once and locks the day", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const game = new WordleGame(dir, pinned(date));
		const answer = answerForDay(date);
		assert.ok(isValidWord(answer));

		const res = game.guessDaily(answer);
		assert.equal(res.kind, "win");
		if (res.kind !== "win") return;
		assert.equal(res.used, 1);
		assert.equal(res.puzzle, dayPuzzle(date));
		const s1 = game.stats();
		assert.equal(s1.gamesPlayed, 1);
		assert.equal(s1.gamesWon, 1);
		assert.equal(s1.currentStreak, 1);

		// Day is locked: another instance (restart) sees it finished, no double count.
		const again = new WordleGame(dir, pinned(date));
		assert.equal(again.dailyDone(), true);
		const blocked = again.guessDaily("crane");
		assert.equal(blocked.kind, "rejected");
		assert.equal(again.stats().gamesPlayed, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("daily game: rolls over to the next day, keeping all-time stats", () => {
	const dir = tmpDir();
	try {
		const game1 = new WordleGame(dir, pinned("2026-01-05"));
		game1.guessDaily(answerForDay("2026-01-05"));
		assert.equal(game1.stats().gamesPlayed, 1);

		const game2 = new WordleGame(dir, pinned("2026-01-06"));
		assert.equal(game2.dailyDone(), false);
		assert.deepEqual(game2.dailyBoard().guesses, []);
		assert.equal(game2.stats().gamesPlayed, 1); // history survives rollover
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("daily game: six wrong guesses lose and record a loss", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const answer = answerForDay(date);
		const guesses = GUESS_POOL.filter((w) => w !== answer).slice(0, MAX_TRIES);
		assert.equal(guesses.length, MAX_TRIES);

		const game = new WordleGame(dir, pinned(date));
		for (let i = 0; i < MAX_TRIES - 1; i++) {
			const r = game.guessDaily(guesses[i]);
			assert.equal(r.kind, "feedback");
		}
		const last = game.guessDaily(guesses[MAX_TRIES - 1]);
		assert.equal(last.kind, "lose");
		const stats = game.stats();
		assert.equal(stats.gamesPlayed, 1);
		assert.equal(stats.gamesWon, 0);
		assert.equal(stats.currentStreak, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("daily game: invalid guess is rejected and does not consume a try", () => {
	const dir = tmpDir();
	try {
		const game = new WordleGame(dir, pinned("2026-01-05"));
		const bad = game.guessDaily("zzzzz");
		assert.equal(bad.kind, "invalid");
		if (bad.kind !== "invalid") return;
		assert.equal(bad.reason, "not-a-word");
		assert.equal(game.dailyBoard().guesses.length, 0);
		assert.equal(game.dailyDone(), false);

		const short = game.guessDaily("cat");
		assert.equal(short.kind, "invalid");
		if (short.kind !== "invalid") return;
		assert.equal(short.reason, "length");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("daily game: resetDaily clears an unfinished board but not a finished one", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const game = new WordleGame(dir, pinned(date));
		game.guessDaily("crane");
		game.resetDaily();
		assert.equal(game.dailyBoard().guesses.length, 0);

		game.guessDaily(answerForDay(date));
		assert.equal(game.dailyDone(), true);
		game.resetDaily(); // must NOT clear a done day
		assert.equal(game.dailyDone(), true);
		assert.equal(game.stats().gamesPlayed, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("daily in-progress board survives an instance restart (same day)", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const answer = answerForDay(date);
		const pool = GUESS_POOL.filter((w) => w !== answer);
		const game = new WordleGame(dir, pinned(date));
		game.guessDaily(pool[0]);
		game.guessDaily(pool[1]);

		const resumed = new WordleGame(dir, pinned(date));
		assert.equal(resumed.dailyBoard().guesses.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("random game: win works and leaves daily stats untouched", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const game = new WordleGame(dir, pinned(date));
		game.guessDaily(answerForDay(date)); // one daily win for baseline
		const before = game.stats();

		const board = game.newRandom();
		const res = game.guessRandom(board.answer);
		assert.equal(res.kind, "win");
		assert.equal(game.randomBoard()?.done, true);

		// random games never touch daily stats
		assert.deepEqual(game.stats(), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("statusesFor re-evaluates rows against the secret without leaking it", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const answer = answerForDay(date);
		const game = new WordleGame(dir, pinned(date));
		const st = game.statusesFor("daily", answer);
		assert.ok(st && st.every((s) => s === "correct"));

		const partial = game.statusesFor("daily", "crane");
		assert.ok(partial && partial.length === 5);

		// random board absent → null
		assert.equal(game.statusesFor("random", "crane"), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("persisted state shape round-trips through loadState", () => {
	const dir = tmpDir();
	try {
		const date = "2026-01-05";
		const game = new WordleGame(dir, pinned(date));
		game.guessDaily("crane");
		game.guessDaily(answerForDay(date));

		const raw = readFileSync(join(dir, "state.json"), "utf8");
		const state: PersistedState = JSON.parse(raw);
		assert.equal(state.history.length, 1);
		assert.equal(state.daily?.date, date);
		assert.equal(state.daily?.done, true);
		assert.equal(state.daily?.guesses.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function dayPuzzle(date: string): number {
	// Wordle #1 == 2021-06-19
	const start = new Date(2021, 5, 19);
	const [y, m, d] = date.split("-").map(Number);
	const day = new Date(y, m - 1, d);
	return Math.floor((day.getTime() - start.getTime()) / 86_400_000) + 1;
}
