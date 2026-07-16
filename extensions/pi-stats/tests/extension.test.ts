import { describe, expect, test } from "bun:test";
import skillStatsExtension from "../src/index";

function createPi(commands: any[] = []) {
	const handlers = new Map<string, Function[]>();
	const registeredCommands = new Map<string, any>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: any) {
			registeredCommands.set(name, options);
		},
		getCommands() {
			return commands;
		},
	};
	return { pi: pi as any, handlers, registeredCommands };
}

function createCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		ctx: {
			cwd: "/project",
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		},
		notifications,
	};
}

describe("extension", () => {
	test("registers stats commands", () => {
		const { pi, registeredCommands } = createPi();
		skillStatsExtension(pi);
		expect(registeredCommands.has("skill-stats")).toBe(true);
		expect(registeredCommands.has("tool-stats")).toBe(true);
	});

	test("fails open when database init fails", async () => {
		const oldEnv = process.env.PI_SKILL_STATS_DB;
		process.env.PI_SKILL_STATS_DB = "/dev/null/stats.sqlite";
		try {
			const { pi, handlers } = createPi([
				{ name: "tdd", source: "skill", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
			]);
			const { ctx, notifications } = createCtx();
			skillStatsExtension(pi);
			await handlers.get("input")![0]({ source: "interactive", text: "/skill:tdd" }, ctx);
			expect(notifications[0].message).toContain("pi-skill-stats disabled");
		} finally {
			if (oldEnv === undefined) delete process.env.PI_SKILL_STATS_DB;
			else process.env.PI_SKILL_STATS_DB = oldEnv;
		}
	});

	test("attempts to record skill calls from extension-sourced expanded messages", async () => {
		const oldEnv = process.env.PI_SKILL_STATS_DB;
		process.env.PI_SKILL_STATS_DB = "/dev/null/stats.sqlite";
		try {
			const { pi, handlers } = createPi([
				{ name: "diagnose", source: "skill", sourceInfo: { path: "/skills/diagnose/SKILL.md" } },
			]);
			const { ctx, notifications } = createCtx();
			skillStatsExtension(pi);
			await handlers.get("input")![0]({
				source: "extension",
				text: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">',
			}, ctx);

			expect(notifications[0].message).toContain("pi-skill-stats disabled");
		} finally {
			if (oldEnv === undefined) delete process.env.PI_SKILL_STATS_DB;
			else process.env.PI_SKILL_STATS_DB = oldEnv;
		}
	});

	test("reports disabled store in command handlers", async () => {
		const oldEnv = process.env.PI_SKILL_STATS_DB;
		process.env.PI_SKILL_STATS_DB = "/dev/null/stats.sqlite";
		try {
			const { pi, registeredCommands } = createPi();
			const { ctx, notifications } = createCtx();
			skillStatsExtension(pi);
			await registeredCommands.get("skill-stats").handler("", ctx);

			expect(notifications.map((item) => item.message)).toContain(
				"pi-skill-stats is disabled; check the earlier warning for details.",
			);
		} finally {
			if (oldEnv === undefined) delete process.env.PI_SKILL_STATS_DB;
			else process.env.PI_SKILL_STATS_DB = oldEnv;
		}
	});

	test("reports disabled store in tool-stats command handlers", async () => {
		const oldEnv = process.env.PI_SKILL_STATS_DB;
		process.env.PI_SKILL_STATS_DB = "/dev/null/stats.sqlite";
		try {
			const { pi, registeredCommands } = createPi();
			const { ctx, notifications } = createCtx();
			skillStatsExtension(pi);
			await registeredCommands.get("tool-stats").handler("", ctx);

			expect(notifications.map((item) => item.message)).toContain(
				"pi-skill-stats is disabled; check the earlier warning for details.",
			);
		} finally {
			if (oldEnv === undefined) delete process.env.PI_SKILL_STATS_DB;
			else process.env.PI_SKILL_STATS_DB = oldEnv;
		}
	});
});
