// Session + persistence layer for pi-wordle. Keeps the daily board and the
// optional random board, rolls the daily puzzle over at midnight, and records
// exactly one stats entry per finished daily puzzle.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	answerForDay,
	dayNumber,
	evaluateGuess,
	isValidWord,
	MAX_TRIES,
	randomAnswer,
	todayKey,
	type DailyResult,
	type LetterStatus,
	type Stats,
	computeStats,
} from "./wordle.ts";

export const DEFAULT_DATA_DIR = join(homedir(), ".pi", "agent", "pi-wordle");

export interface DailyBoard {
	date: string; // YYYY-MM-DD this board belongs to
	guesses: string[];
	done: boolean; // finished: win/lose recorded in history
}

export interface RandomBoard {
	answer: string;
	guesses: string[];
	done: boolean;
}

export interface PersistedState {
	history: DailyResult[];
	daily: DailyBoard | null;
	random: RandomBoard | null;
}

export function emptyState(): PersistedState {
	return { history: [], daily: null, random: null };
}

// ---------------------------------------------------------------------------
// Structured results the tool layer renders into text.
// ---------------------------------------------------------------------------

export type PlayOutcome =
	| {
			kind: "feedback";
			guess: string;
			statuses: LetterStatus[];
			guesses: string[];
			remaining: number;
			puzzle: number;
			mode: "daily" | "random";
	  }
	| {
			kind: "win";
			guess: string;
			statuses: LetterStatus[];
			guesses: string[];
			used: number;
			answer: string;
			puzzle: number;
			mode: "daily" | "random";
			stats: Stats;
	  }
	| {
			kind: "lose";
			guess: string;
			statuses: LetterStatus[];
			guesses: string[];
			answer: string;
			puzzle: number;
			mode: "daily" | "random";
			stats: Stats;
	  }
	| { kind: "invalid"; guess: string; reason: "empty" | "length" | "not-a-word"; message: string };

export interface GuessRejected {
	kind: "rejected";
	message: string;
}

export type GuessResult = PlayOutcome | GuessRejected;

/** Load persisted state, defaulting to the pi home data dir. */
export function loadState(dataDir: string = DEFAULT_DATA_DIR): PersistedState {
	const file = join(dataDir, "state.json");
	if (!existsSync(file)) return emptyState();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const state = emptyState();
		if (Array.isArray(raw.history)) state.history = raw.history;
		if (raw.daily && typeof raw.daily.date === "string") {
			state.daily = {
				date: raw.daily.date,
				guesses: Array.isArray(raw.daily.guesses) ? raw.daily.guesses : [],
				done: Boolean(raw.daily.done),
			};
		}
		if (raw.random && typeof raw.random.answer === "string") {
			state.random = {
				answer: raw.random.answer,
				guesses: Array.isArray(raw.random.guesses) ? raw.random.guesses : [],
				done: Boolean(raw.random.done),
			};
		}
		return state;
	} catch {
		return emptyState();
	}
}

export function saveState(state: PersistedState, dataDir: string = DEFAULT_DATA_DIR): void {
	mkdirSync(dataDir, { recursive: true });
	const file = join(dataDir, "state.json");
	const tmp = join(dataDir, `state.json.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
	renameSync(tmp, file); // atomic-ish replace
}

export function puzzleNumberFor(dateKeyStr: string): number {
	return dayNumber(dateKeyStr) + 1;
}

/**
 * Mutable in-process game facade backed by a JSON file. `now` is injectable so
 * tests can pin the "today" boundary without touching the system clock.
 */
export class WordleGame {
	private state: PersistedState;
	constructor(
		private dataDir: string = DEFAULT_DATA_DIR,
		private now: () => Date = () => new Date(),
	) {
		this.state = loadState(dataDir);
	}

	private persist(): void {
		saveState(this.state, this.dataDir);
	}

	private key(): string {
		return todayKey(this.now());
	}

	/** Make sure `state.daily` points at today's puzzle (rolls stale boards over). */
	private ensureDaily(): DailyBoard {
		const key = this.key();
		if (!this.state.daily || this.state.daily.date !== key) {
			this.state.daily = { date: key, guesses: [], done: false };
			this.persist();
		}
		return this.state.daily;
	}

	puzzle(): number {
		return puzzleNumberFor(this.key());
	}

	stats(): Stats {
		return computeStats(this.state.history);
	}

	/** True when today's daily puzzle is already finished. */
	dailyDone(): boolean {
		return this.ensureDaily().done;
	}

	/** Current daily board (may be empty/new). Never throws. */
	dailyBoard(): DailyBoard {
		return this.ensureDaily();
	}

	/** Abandon today's unfinished board and start over (same answer). */
	resetDaily(): DailyBoard {
		const board = this.ensureDaily();
		if (board.done) {
			// Do not allow re-playing (would double-count stats): leave as-is.
			return board;
		}
		board.guesses = [];
		this.persist();
		return board;
	}

	guessDaily(rawGuess: string): GuessResult {
		const board = this.ensureDaily();
		const answer = answerForDay(board.date);
		const puzzle = puzzleNumberFor(board.date);
		const mode = "daily" as const;

		if (board.done) {
			return {
				kind: "rejected",
				message: `Today's puzzle (#${puzzle}) is already finished. Start a random game or wait for tomorrow.`,
			};
		}
		const check = validateGuess(rawGuess);
		if (!check.ok) return check.outcome(puzzle, mode);
		const guess = check.word;

		const statuses = evaluateGuess(guess, answer);
		board.guesses.push(guess);

		if (statuses.every((s) => s === "correct")) {
			board.done = true;
			this.state.history.push({
				date: board.date,
				won: true,
				guesses: board.guesses.length,
			});
			this.persist();
			return {
				kind: "win",
				guess,
				statuses,
				guesses: board.guesses,
				used: board.guesses.length,
				answer,
				puzzle,
				mode,
				stats: this.stats(),
			};
		}
		if (board.guesses.length >= MAX_TRIES) {
			board.done = true;
			this.state.history.push({ date: board.date, won: false, guesses: MAX_TRIES });
			this.persist();
			return {
				kind: "lose",
				guess,
				statuses,
				guesses: board.guesses,
				answer,
				puzzle,
				mode,
				stats: this.stats(),
			};
		}
		this.persist();
		return {
			kind: "feedback",
			guess,
			statuses,
			guesses: board.guesses,
			remaining: MAX_TRIES - board.guesses.length,
			puzzle,
			mode,
		};
	}

	/** Start a brand-new random puzzle (replaces any previous random board). */
	newRandom(): RandomBoard {
		this.state.random = { answer: randomAnswer(), guesses: [], done: false };
		this.persist();
		return this.state.random;
	}

	randomBoard(): RandomBoard | null {
		return this.state.random;
	}

	/**
	 * Re-evaluate an earlier guess against the active board's answer. Used to
	 * render the whole board without ever exposing the secret word. Returns null
	 * when there is no board for the requested mode.
	 */
	statusesFor(mode: "daily" | "random", guess: string): LetterStatus[] | null {
		if (mode === "daily") {
			const board = this.ensureDaily();
			return evaluateGuess(guess, answerForDay(board.date));
		}
		const board = this.state.random;
		return board ? evaluateGuess(guess, board.answer) : null;
	}

	guessRandom(rawGuess: string): GuessResult {
		const board = this.state.random;
		if (!board) {
			return {
				kind: "rejected",
				message: "No random game in progress. Call new with mode=random to start one.",
			};
		}
		const mode = "random" as const;
		if (board.done) {
			return {
				kind: "rejected",
				message: `That random game is finished (answer was ${board.answer}). Start a new random game to play again.`,
			};
		}
		const check = validateGuess(rawGuess);
		if (!check.ok) return check.outcome(this.puzzle(), mode);
		const guess = check.word;

		const statuses = evaluateGuess(guess, board.answer);
		board.guesses.push(guess);

		if (statuses.every((s) => s === "correct")) {
			board.done = true;
			this.persist();
			return {
				kind: "win",
				guess,
				statuses,
				guesses: board.guesses,
				used: board.guesses.length,
				answer: board.answer,
				puzzle: this.puzzle(),
				mode,
				stats: this.stats(),
			};
		}
		if (board.guesses.length >= MAX_TRIES) {
			board.done = true;
			this.persist();
			return {
				kind: "lose",
				guess,
				statuses,
				guesses: board.guesses,
				answer: board.answer,
				puzzle: this.puzzle(),
				mode,
				stats: this.stats(),
			};
		}
		this.persist();
		return {
			kind: "feedback",
			guess,
			statuses,
			guesses: board.guesses,
			remaining: MAX_TRIES - board.guesses.length,
			puzzle: this.puzzle(),
			mode,
		};
	}
}

interface GuessCheck {
	ok: true;
	word: string;
}
interface GuessCheckBad {
	ok: false;
	outcome: (puzzle: number, mode: "daily" | "random") => GuessResult;
}

function validateGuess(rawGuess: string): GuessCheck | GuessCheckBad {
	const word = rawGuess.trim().toLowerCase();
	if (!/^[a-z]+$/.test(word)) {
		return {
			ok: false,
			outcome: (_p, _m) => ({
				kind: "invalid",
				guess: rawGuess,
				reason: "empty",
				message: `"${rawGuess}" is not a word — guesses must be 5 letters (a–z only).`,
			}),
		};
	}
	if (word.length !== 5) {
		return {
			ok: false,
			outcome: (_p, _m) => ({
				kind: "invalid",
				guess: word,
				reason: "length",
				message: `"${word}" has ${word.length} letters; a Wordle guess must be exactly 5 letters.`,
			}),
		};
	}
	if (!isValidWord(word)) {
		return {
			ok: false,
			outcome: (_p, _m) => ({
				kind: "invalid",
				guess: word,
				reason: "not-a-word",
				message: `"${word}" is not in the accepted word list (14,855 words). Try a different real English 5-letter word.`,
			}),
		};
	}
	return { ok: true, word };
}
