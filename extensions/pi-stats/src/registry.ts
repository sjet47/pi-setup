import { resolve } from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export interface SkillRegistry {
	canonicalForCommand(commandName: string): string | undefined;
	canonicalForSkillPath(path: string): string | undefined;
	hasSkill(canonicalName: string): boolean;
}

export function canonicalizeSkillName(name: string): string {
	return name.replace(/:\d+$/, "");
}

function normalizePath(path: string): string {
	return resolve(path);
}

export class PiSkillRegistry implements SkillRegistry {
	private byCommand = new Map<string, string>();
	private byPath = new Map<string, string>();
	private canonicalNames = new Set<string>();

	static fromCommands(commands: SlashCommandInfo[]): PiSkillRegistry {
		return new PiSkillRegistry(commands);
	}

	constructor(commands: Pick<SlashCommandInfo, "name" | "source" | "sourceInfo">[]) {
		for (const command of commands) {
			if (command.source !== "skill") continue;

			const canonical = canonicalizeSkillName(command.name);
			this.byCommand.set(command.name, canonical);
			this.byCommand.set(canonical, canonical);
			// pi registers skill commands as `skill:<name>`, but user input and
			// expanded <skill name="..."> blocks reference the bare name.
			if (canonical.startsWith("skill:")) {
				this.byCommand.set(canonical.slice("skill:".length), canonical);
			}
			this.canonicalNames.add(canonical);

			const path = command.sourceInfo?.path;
			if (path) {
				this.byPath.set(normalizePath(path), canonical);
			}
		}
	}

	canonicalForCommand(commandName: string): string | undefined {
		const trimmed = commandName.trim();
		return this.byCommand.get(trimmed) ?? this.byCommand.get(canonicalizeSkillName(trimmed));
	}

	canonicalForSkillPath(path: string): string | undefined {
		return this.byPath.get(normalizePath(path));
	}

	hasSkill(canonicalName: string): boolean {
		return this.canonicalNames.has(canonicalizeSkillName(canonicalName));
	}
}
