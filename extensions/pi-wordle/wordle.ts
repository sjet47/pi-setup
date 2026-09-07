// Pure Wordle game logic: no I/O, no side effects — easily unit-testable.
import { ANSWER_WORDS, VALID_GUESSES } from "./wordlist.ts";

export const GUESS_LEN = 5;
export const MAX_TRIES = 6;

export type LetterStatus = "correct" | "misplaced" | "absent";

/** Wordle-style evaluation that handles duplicated letters correctly. */
export function evaluateGuess(guess: string, answer: string): LetterStatus[] {
	const result: LetterStatus[] = [];
	const remaining: Record<string, number> = {};
	for (let i = 0; i < answer.length; i++) {
		const g = guess[i];
		if (g === answer[i]) result.push("correct");
		else {
			result.push("absent");
			remaining[answer[i]] = (remaining[answer[i]] ?? 0) + 1;
		}
	}
	for (let i = 0; i < answer.length; i++) {
		if (result[i] === "correct") continue;
		const g = guess[i];
		if ((remaining[g] ?? 0) > 0) {
			result[i] = "misplaced";
			remaining[g]--;
		}
	}
	return result;
}

/** Normalize a guess: trim, lowercase, strip anything that is not a-z. */
export function normalizeGuess(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z]/g, "");
}

export function isValidWord(word: string): boolean {
	return VALID_GUESSES.includes(word);
}

export function isValidAnswer(word: string): boolean {
	return ANSWER_WORDS.includes(word);
}

/** FNV-1a 32-bit — deterministic, dependency-free hash used to seed daily picks. */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Local YYYY-MM-DD for a Date (the "day" the puzzle belongs to). */
export function dateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function todayKey(now: Date = new Date()): string {
	return dateKey(now);
}

const WORDLE_EPOCH = new Date(2021, 5, 19); // 2021-06-19 local, Wordle puzzle #1

/** Zero-based day offset from the Wordle epoch (puzzle number = offset + 1). */
export function dayNumber(dateKeyStr: string): number {
	const [y, m, d] = dateKeyStr.split("-").map(Number);
	const day = new Date(y, m - 1, d);
	return Math.floor((day.getTime() - WORDLE_EPOCH.getTime()) / 86_400_000);
}

/** Deterministic answer for a given day. Same key → same word, everywhere. */
export function answerForDay(dateKeyStr: string): string {
	const idx = fnv1a(dateKeyStr) % ANSWER_WORDS.length;
	return ANSWER_WORDS[idx];
}

/** Cryptographically weak on purpose — fine for picking a casual puzzle word. */
export function randomAnswer(): string {
	return ANSWER_WORDS[Math.floor(Math.random() * ANSWER_WORDS.length)];
}

// ---------------------------------------------------------------------------
// All-time stats (only daily puzzles count, mirroring real Wordle).
// ---------------------------------------------------------------------------

export interface DailyResult {
	date: string; // YYYY-MM-DD the puzzle was played
	won: boolean;
	guesses: number; // 1..MAX_TRIES when won; MAX_TRIES when lost
}

export interface Stats {
	gamesPlayed: number;
	gamesWon: number;
	winRate: number; // 0..1, 0 when no games
	currentStreak: number; // consecutive daily wins ending at the latest played day
	maxStreak: number;
	distribution: number[]; // length MAX_TRIES, wins indexed by guess count
}

export function emptyStats(): Stats {
	return {
		gamesPlayed: 0,
		gamesWon: 0,
		winRate: 0,
		currentStreak: 0,
		maxStreak: 0,
		distribution: [0, 0, 0, 0, 0, 0],
	};
}

/**
 * Fold one finished daily puzzle into the history and recompute derived stats.
 * The caller is responsible for recording each date exactly once.
 */
export function computeStats(history: DailyResult[]): Stats {
	const stats = emptyStats();
	stats.gamesPlayed = history.length;
	const wins = history.filter((r) => r.won);
	stats.gamesWon = wins.length;
	stats.winRate = history.length > 0 ? wins.length / history.length : 0;

	// Streaks only count consecutive *calendar* days (mirrors real Wordle): a
	// win extends the run only when it lands on the day right after the last one.
	const entries = history
		.map((r) => ({ off: dayNumber(r.date), won: r.won }))
		.sort((a, b) => a.off - b.off);
	let cur = 0;
	let best = 0;
	let last = Number.NEGATIVE_INFINITY;
	for (const { off, won } of entries) {
		if (!won) {
			cur = 0; // a loss breaks the run
		} else if (off === last + 1) {
			cur++;
		} else {
			cur = 1; // gap in calendar days restarts the run
		}
		last = off;
		if (cur > best) best = cur;
	}
	stats.currentStreak = cur;
	stats.maxStreak = best;

	for (const w of wins) {
		const i = Math.max(1, Math.min(w.guesses, MAX_TRIES)) - 1;
		stats.distribution[i]++;
	}
	return stats;
}
