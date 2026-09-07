// pi-wordle: a Wordle extension for pi. The model (or you, through chat) plays
// by calling the tools below; every guess returns letter-by-letter feedback and
// the current board. The daily puzzle is shared across sessions on the same
// machine, and all-time stats are kept under ~/.pi/agent/pi-wordle/state.json.
// The wordle tools stay invisible to the model until you run `/wordle`, which
// activates them for the session and tells the model to start playing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MAX_TRIES, type LetterStatus, type Stats } from "./wordle.ts";
import { WordleGame, type GuessResult, type PlayOutcome } from "./wordle-store.ts";

// Wordle tools are hidden from the model by default. `/wordle` activates them
// for the rest of the session and kicks off a game.
const WORDLE_TOOL_NAMES = ["wordle_guess", "wordle_new", "wordle_status"];

const GLYPH: Record<LetterStatus, string> = {
	correct: "✓",
	misplaced: "~",
	absent: "✗",
};
const EMOJI: Record<LetterStatus, string> = {
	correct: "🟩",
	misplaced: "🟨",
	absent: "⬜",
};
const LEGEND = "Legend: ✓ = in the word, right spot · ~ = in the word, wrong spot · ✗ = not in the word.";

function row(guess: string, statuses: LetterStatus[]): string {
	return guess
		.split("")
		.map((ch, i) => `${ch}${statuses[i] ? GLYPH[statuses[i]] : "?"}`)
		.join(" ");
}

function boardText(guesses: string[], statusesFor: (g: string) => LetterStatus[]): string {
	return guesses
		.map((g, i) => `${String(i + 1).padStart(2)}. ${g.toUpperCase()}   ${row(g, statusesFor(g))}`)
		.join("\n");
}

function emojiGrid(guesses: string[], statusesFor: (g: string) => LetterStatus[]): string {
	return guesses.map((g) => statusesFor(g).map((s) => EMOJI[s]).join("")).join("\n");
}

function titleOf(mode: "daily" | "random", puzzle: number): string {
	return mode === "daily" ? `Wordle #${puzzle}` : "Random game";
}

function statsText(stats: Stats): string {
	const dist = stats.distribution.map((n, i) => `${i + 1}:${n}`).join("  ");
	return (
		`All-time (daily only): ${stats.gamesPlayed} played · ${stats.gamesWon} won ` +
		`(${Math.round(stats.winRate * 100)}%) · current streak ${stats.currentStreak} · ` +
		`best streak ${stats.maxStreak} · wins by guess count: ${dist}`
	);
}

/** Format a finished game's shareable grid + all-time stats trailer. */
function endingText(out: Extract<PlayOutcome, { kind: "win" | "lose" }>, game: WordleGame): string {
	const mode = out.mode;
	const statusesFor = (g: string) => game.statusesFor(mode, g) ?? [];
	const used = out.kind === "win" ? out.used : MAX_TRIES;
	const grid = emojiGrid(out.guesses, statusesFor);
	const parts = [
		`${titleOf(mode, out.puzzle)} ${used}/${MAX_TRIES}`,
		grid,
		"",
	];
	if (mode === "daily") parts.push(statsText(out.stats));
	else parts.push("Random games don't affect the all-time stats above.");
	return parts.join("\n");
}

function guessResultText(result: GuessResult, game: WordleGame): string {
	if (result.kind === "rejected" || result.kind === "invalid") {
		return result.message;
	}

	const mode = result.mode;
	const statusesFor = (g: string) => game.statusesFor(mode, g) ?? [];
	const lines: string[] = [];

	if (result.kind === "feedback") {
		lines.push(
			`${titleOf(mode, result.puzzle)} · ${result.guesses.length}/${MAX_TRIES} guessed · ${result.remaining} left`,
		);
		lines.push(LEGEND);
		lines.push("");
		lines.push(boardText(result.guesses, statusesFor));
		lines.push("");
		lines.push(
			result.remaining > 1
				? `${result.guesses.length} guess${result.guesses.length === 1 ? "" : "es"} used, ${result.remaining} remaining.`
				: `${result.guesses.length} guesses used — one last try!`,
		);
		return lines.join("\n");
	}

	// win / lose
	if (result.kind === "win") {
		lines.push(`🎉 Solved ${titleOf(mode, result.puzzle)} in ${result.used}/${MAX_TRIES}!`);
	} else {
		lines.push(
			`😵 Out of guesses on ${titleOf(mode, result.puzzle)} — the word was “${result.answer.toUpperCase()}”.`,
		);
	}
	lines.push("");
	lines.push(boardText(result.guesses, statusesFor));
	lines.push("");
	lines.push(endingText(result, game));
	return lines.join("\n");
}

const MODE_ENUM = StringEnum(["daily", "random"], {
	description: '"daily" is today\'s shared puzzle (one per day). "random" is an extra practice game you started with wordle_new.',
});

export default function (pi: ExtensionAPI) {
	const game = new WordleGame();

	pi.registerTool({
		name: "wordle_guess",
		label: "Wordle: make a guess",
		description:
			"Submit a 5-letter English word to the Wordle game and get back letter-by-letter feedback " +
			"(✓ = in the word at the right spot, ~ = in the word at the wrong spot, ✗ = not in the word) " +
			"plus the current board. You get 6 guesses per puzzle. Keep calling with a fresh real word until you " +
			"solve it or run out of guesses. Omit mode (or pass mode=daily) to play today's shared puzzle; " +
			"mode=random plays the practice game you started with wordle_new.",
		parameters: Type.Object({
			guess: Type.String({
				description: "A 5-letter English word (letters a–z).",
			}),
			mode: Type.Optional(MODE_ENUM),
		}),
		async execute(_id, params) {
			const mode = (params.mode ?? "daily") as "daily" | "random";
			const guess = (params.guess ?? "").trim();
			const result = mode === "random" ? game.guessRandom(guess) : game.guessDaily(guess);
			return { content: [{ type: "text", text: guessResultText(result, game) }], details: {} };
		},
	});

	pi.registerTool({
		name: "wordle_new",
		label: "Wordle: start a game",
		description:
			"Start a fresh Wordle game. mode=daily abandons today's unfinished board and starts over with the same " +
			"daily answer (useful after a bad start); if today's puzzle is already finished it says so. " +
			"mode=random deals a brand-new random answer for unlimited extra practice — random games never touch the " +
			"all-time stats.",
		parameters: Type.Object({
			mode: Type.Optional(MODE_ENUM),
		}),
		async execute(_id, params) {
			const mode = (params.mode ?? "daily") as "daily" | "random";
			if (mode === "random") {
				const board = game.newRandom();
				return {
					content: [
						{
							type: "text",
							text:
								`🎲 New random game started. ${board.guesses.length}/${MAX_TRIES} guessed. ` +
								`Guess with wordle_guess (mode=random). The daily puzzle (Wordle #${game.puzzle()}) is ` +
								`still available with wordle_guess (mode=daily).`,
						},
					],
				details: {},
				};
			}
			if (game.dailyDone()) {
				return {
					content: [
						{
							type: "text",
							text:
								`Today's Wordle #${game.puzzle()} is already finished — it can't be replayed (stats are recorded ` +
								`once per day). Deal a random practice game with wordle_new (mode=random) or come back tomorrow.`,
						},
					],
				details: {},
				};
			}
			game.resetDaily();
			return {
				content: [
					{
						type: "text",
						text:
							`↺ Reset today's board. Wordle #${game.puzzle()}, 0/${MAX_TRIES} guessed — the answer is unchanged. ` +
							`Start with any real 5-letter word via wordle_guess (mode=daily).`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "wordle_status",
		label: "Wordle: show board & stats",
		description:
			"Show the current state: today's puzzle number, the daily board with all feedback so far (or that it " +
			"hasn't been started / is already finished), whether a random practice game is in progress, and the " +
			"all-time stats. Call this whenever you are unsure where the game stands.",
		parameters: Type.Object({}),
		async execute() {
			const lines: string[] = [];
			const puzzle = game.puzzle();
			const daily = game.dailyBoard();
			const random = game.randomBoard();
			const statusesFor = (g: string) => game.statusesFor("daily", g) ?? [];

			lines.push(`Wordle #${puzzle} · daily`);
			if (daily.done) {
				lines.push("Today's puzzle is finished.");
			} else if (daily.guesses.length === 0) {
				lines.push("Not started yet — 6 guesses available.");
			}
			if (daily.guesses.length > 0) {
				lines.push("");
				lines.push(boardText(daily.guesses, statusesFor));
				lines.push("");
				const dailyWon =
					(daily.guesses.length > 0 &&
						(game.statusesFor("daily", daily.guesses[daily.guesses.length - 1]) ?? []).every(
							(s) => s === "correct",
						));
				lines.push(
					daily.done
						? `${daily.guesses.length}/6 · ${dailyWon ? "solved" : "failed"}`
						: `${daily.guesses.length}/6 guessed · ${MAX_TRIES - daily.guesses.length} remaining`,
				);
			}

			lines.push("");
			if (random) {
				const rsf = (g: string) => game.statusesFor("random", g) ?? [];
				lines.push("Random practice game:");
				if (random.guesses.length > 0) {
					lines.push(boardText(random.guesses, rsf));
					lines.push(
						random.done
							? `${random.guesses.length}/6 · finished`
							: `${random.guesses.length}/6 guessed · ${MAX_TRIES - random.guesses.length} remaining`,
					);
				} else {
					lines.push("Started, no guesses yet.");
				}
			} else {
				lines.push("No random practice game in progress.");
			}

			lines.push("");
			lines.push(statsText(game.stats()));
			lines.push("");
			lines.push("To play: wordle_guess (mode=daily|random). To deal a fresh practice word: wordle_new (mode=random).");
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});
	pi.registerCommand("wordle", {
		description: "Activate the Wordle tools and have the model play a round",
		handler: async (_args) => {
			const active = pi.getActiveTools();
			const missing = WORDLE_TOOL_NAMES.filter((n) => !active.includes(n));
			if (missing.length > 0) {
				pi.setActiveTools([...new Set([...active, ...missing])]);
			}
			pi.sendUserMessage(
				"你刚召唤了 /wordle，现在开玩。规则：先调用 wordle_status 看今天的盘面（或随机局的进度），" +
					"然后用 wordle_guess 一个一个猜词——每次提交一个真实的英文 5 字母单词，工具会返回每个字母的反馈 " +
					"(✓ = 位置正确、~ = 在答案里但位置不对、✗ = 不在答案里)。每局限 6 次。" +
					"如果今天的每日词已经结束，就调用 wordle_new (mode=random) 开一局随机的继续玩。" +
					"结束后给用户简短交代战绩（第几次猜中 / 失败、答案），并贴出可分享的 emoji 网格。",
				{ deliverAs: "steer" },
			);
		},
	});

	// Keep the Wordle tools registered but invisible unless /wordle activates them.
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		pi.setActiveTools(active.filter((name) => !WORDLE_TOOL_NAMES.includes(name)));
	});
}
