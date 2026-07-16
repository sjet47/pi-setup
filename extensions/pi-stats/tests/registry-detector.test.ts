import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { UsageDetector } from "../src/detector";
import { canonicalizeSkillName, PiSkillRegistry } from "../src/registry";

const commands = [
	{ name: "tdd", source: "skill", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
	{ name: "diagnose", source: "skill", sourceInfo: { path: "/skills/diagnose/SKILL.md" } },
	{ name: "review:1", source: "skill", sourceInfo: { path: "/skills/review/SKILL.md" } },
	{ name: "hello", source: "extension", sourceInfo: { path: "/ext/hello.ts" } },
] as any;

describe("PiSkillRegistry", () => {
	test("maps command names to canonical skill names", () => {
		const registry = new PiSkillRegistry(commands);
		expect(registry.canonicalForCommand("tdd")).toBe("tdd");
		expect(registry.canonicalForCommand("review:1")).toBe("review");
		expect(registry.canonicalForCommand("review")).toBe("review");
		expect(registry.canonicalForCommand("hello")).toBeUndefined();
	});

	test("maps bare names for pi's prefixed skill commands", () => {
		// pi registers skill commands as `skill:<name>` (see agent-session `skill:${skill.name}`),
		// while `/skill:tdd` input and expanded <skill name="tdd"> blocks carry the bare name.
		const prefixed = [
			{ name: "skill:tdd", source: "skill", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
			{ name: "skill:review:1", source: "skill", sourceInfo: { path: "/skills/review/SKILL.md" } },
		] as any;
		const registry = new PiSkillRegistry(prefixed);
		expect(registry.canonicalForCommand("tdd")).toBe("skill:tdd");
		expect(registry.canonicalForCommand("skill:tdd")).toBe("skill:tdd");
		expect(registry.canonicalForCommand("skill:review:1")).toBe("skill:review");
		expect(registry.canonicalForCommand("review")).toBe("skill:review");
		expect(registry.canonicalForSkillPath(resolve("/skills/tdd/SKILL.md"))).toBe("skill:tdd");

		const detector = new UsageDetector(registry);
		detector.startTurn();
		expect(detector.detectInput("/skill:tdd go")).toEqual([{ skill: "skill:tdd" }]);
		// Same skill referenced by input then read in the same turn stays deduplicated.
		expect(detector.detectSkillRead("/skills/tdd/SKILL.md")).toBeUndefined();
		expect(detector.detectInput('<skill name="review" location="/skills/review/SKILL.md">')).toEqual([
			{ skill: "skill:review" },
		]);
	});

	test("strips conflict suffixes", () => {
		expect(canonicalizeSkillName("review:12")).toBe("review");
	});

	test("maps discovered skill paths only", () => {
		const registry = new PiSkillRegistry(commands);
		expect(registry.canonicalForSkillPath(resolve("/skills/tdd/SKILL.md"))).toBe("tdd");
		expect(registry.canonicalForSkillPath("/other/SKILL.md")).toBeUndefined();
	});
});

describe("UsageDetector", () => {
	test("detects and deduplicates slash skill invocations", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		expect(detector.detectInput("/skill:tdd do it /skill:tdd and /skill:missing")).toEqual([
			{ skill: "tdd" },
		]);
	});

	test("detects multiple skill invocations", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		expect(detector.detectInput("/skill:tdd /skill:review:1")).toEqual([
			{ skill: "tdd" },
			{ skill: "review" },
		]);
	});

	test("detects expanded XML-style skill blocks", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		expect(detector.detectInput(`<skill name="diagnose" location="/skills/diagnose/SKILL.md">
# Diagnose
</skill>
Please use it.`)).toEqual([
			{ skill: "diagnose" },
		]);
	});

	test("deduplicates slash and expanded XML mentions", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		expect(detector.detectInput('/skill:diagnose <skill name="diagnose" location="/skills/diagnose/SKILL.md">')).toEqual([
			{ skill: "diagnose" },
		]);
	});

	test("detects read-tool usage and ignores arbitrary skill files", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		expect(detector.detectSkillRead("/skills/tdd/SKILL.md")).toEqual({ skill: "tdd" });
		expect(detector.detectSkillRead("/unknown/SKILL.md")).toBeUndefined();
	});

	test("suppresses same-skill read after same-turn input", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		detector.detectInput("/skill:tdd");
		expect(detector.detectSkillRead("/skills/tdd/SKILL.md")).toBeUndefined();
		expect(detector.detectSkillRead("/skills/review/SKILL.md")).toEqual({ skill: "review" });
	});

	test("suppresses same-skill read after XML mention", () => {
		const detector = new UsageDetector(new PiSkillRegistry(commands));
		detector.startTurn();
		detector.detectInput('<skill name="diagnose" location="/skills/diagnose/SKILL.md">');
		expect(detector.detectSkillRead("/skills/diagnose/SKILL.md")).toBeUndefined();
	});
});
