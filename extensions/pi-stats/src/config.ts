import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".pi", "agent", "pi-skill-stats");

export interface SkillStatsConfig {
	dataDir: string;
	configPath: string;
}

export interface LoadConfigOptions {
	env?: NodeJS.ProcessEnv;
	configPath?: string;
	cwd?: string;
	ensureDir?: boolean;
}

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function resolvePath(input: string, cwd = process.cwd()): string {
	const expanded = expandHome(input);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Load config. Supports a config.json with an optional `dataDir` field.
 * Falls back to ~/.pi/agent/pi-skill-stats/.
 */
export function loadConfig(options: LoadConfigOptions = {}): SkillStatsConfig {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const configPath = resolvePath(
		options.configPath ?? join(DEFAULT_CONFIG_DIR, "config.json"),
		cwd,
	);
	let fileDataDir: string | undefined;

	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
			if (typeof parsed.dataDir === "string" && parsed.dataDir.trim()) {
				fileDataDir = parsed.dataDir;
			}
		} catch (error) {
			console.warn(`pi-skill-stats: ignoring invalid config file ${configPath}`, error);
		}
	}

	const selected = env.PI_SKILL_STATS_DIR?.trim() || fileDataDir || DEFAULT_CONFIG_DIR;
	const dataDir = resolvePath(selected, cwd);

	if (options.ensureDir !== false) {
		mkdirSync(dataDir, { recursive: true });
	}

	return { dataDir, configPath };
}
