import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DEFAULT_CONFIG_DIR, expandHome, loadConfig } from "../src/config";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-stats-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("returns default data dir", () => {
		const config = loadConfig({ env: {}, configPath: join(dir, "missing.json"), ensureDir: false });
		expect(config.dataDir).toBe(DEFAULT_CONFIG_DIR);
	});

	test("applies config dataDir override", () => {
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ dataDir: "./custom" }));
		const config = loadConfig({ env: {}, configPath, cwd: dir, ensureDir: false });
		expect(config.dataDir).toBe(join(dir, "custom"));
	});

	test("applies environment override over config", () => {
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ dataDir: "./config" }));
		const config = loadConfig({
			env: { PI_STATS_DIR: "./env" },
			configPath,
			cwd: dir,
			ensureDir: false,
		});
		expect(config.dataDir).toBe(join(dir, "env"));
	});

	test("keeps PI_SKILL_STATS_DIR as a compatibility alias", () => {
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ dataDir: "./config" }));
		const config = loadConfig({
			env: { PI_SKILL_STATS_DIR: "./legacy" },
			configPath,
			cwd: dir,
			ensureDir: false,
		});
		expect(config.dataDir).toBe(join(dir, "legacy"));
	});

	test("expands home paths", () => {
		expect(expandHome("~/stats.sqlite")).toBe(join(homedir(), "stats.sqlite"));
	});
});
