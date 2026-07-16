import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DEFAULT_DB_PATH, expandHome, loadConfig } from "../src/config";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-skill-stats-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("returns default database path", () => {
		const config = loadConfig({ env: {}, configPath: join(dir, "missing.json"), ensureDir: false });
		expect(config.dbPath).toBe(expandHome(DEFAULT_DB_PATH));
	});

	test("applies config dbPath override", () => {
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ dbPath: "./custom.sqlite" }));
		const config = loadConfig({ env: {}, configPath, cwd: dir, ensureDir: false });
		expect(config.dbPath).toBe(join(dir, "custom.sqlite"));
	});

	test("applies environment override over config", () => {
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ dbPath: "./config.sqlite" }));
		const config = loadConfig({
			env: { PI_SKILL_STATS_DB: "./env.sqlite" },
			configPath,
			cwd: dir,
			ensureDir: false,
		});
		expect(config.dbPath).toBe(join(dir, "env.sqlite"));
	});

	test("expands home paths", () => {
		expect(expandHome("~/stats.sqlite")).toBe(join(homedir(), "stats.sqlite"));
	});
});
