import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CONFIG_DIR = "~/.pi/agent/pi-skill-stats";
export const DEFAULT_DB_PATH = `${DEFAULT_CONFIG_DIR}/stats.sqlite`;
export const DEFAULT_CONFIG_PATH = `${DEFAULT_CONFIG_DIR}/config.json`;

export interface SkillStatsConfig {
	dbPath: string;
	configPath: string;
}

export interface LoadConfigOptions {
	env?: NodeJS.ProcessEnv;
	configPath?: string;
	cwd?: string;
	ensureDir?: boolean;
}

interface ConfigFile {
	dbPath?: unknown;
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

export function loadConfig(options: LoadConfigOptions = {}): SkillStatsConfig {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const configPath = resolvePath(options.configPath ?? DEFAULT_CONFIG_PATH, cwd);
	let fileDbPath: string | undefined;

	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ConfigFile;
			if (typeof parsed.dbPath === "string" && parsed.dbPath.trim()) {
				fileDbPath = parsed.dbPath;
			}
		} catch (error) {
			console.warn(`pi-skill-stats: ignoring invalid config file ${configPath}`, error);
		}
	}

	const selected = env.PI_SKILL_STATS_DB?.trim() || fileDbPath || DEFAULT_DB_PATH;
	const dbPath = resolvePath(selected, cwd);

	if (options.ensureDir !== false) {
		mkdirSync(dirname(dbPath), { recursive: true });
	}

	return { dbPath, configPath };
}
