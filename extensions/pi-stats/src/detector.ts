import type { SkillRegistry } from "./registry";

export interface DetectedUsage {
	skill: string;
}

interface SkillReference {
	commandName: string;
	index: number;
}

export class UsageDetector {
	private recordedSkills = new Set<string>();

	constructor(private registry: SkillRegistry) {}

	setRegistry(registry: SkillRegistry): void {
		this.registry = registry;
	}

	startTurn(): void {
		this.recordedSkills.clear();
	}

	endTurn(): void {
		this.startTurn();
	}

	detectInput(text: string): DetectedUsage[] {
		const detected: DetectedUsage[] = [];
		const seen = new Set<string>();

		for (const commandName of extractInputSkillReferences(text)) {
			const skill = this.registry.canonicalForCommand(commandName);
			if (!skill || seen.has(skill)) continue;
			seen.add(skill);
			if (this.markRecorded(skill)) {
				detected.push({ skill });
			}
		}

		return detected;
	}

	detectSkillRead(path: string): DetectedUsage | undefined {
		const skill = this.registry.canonicalForSkillPath(path);
		if (!skill) return undefined;
		if (!this.markRecorded(skill)) return undefined;
		return { skill };
	}

	private markRecorded(skill: string): boolean {
		if (this.recordedSkills.has(skill)) return false;
		this.recordedSkills.add(skill);
		return true;
	}
}

function extractInputSkillReferences(text: string): string[] {
	const references: SkillReference[] = [];
	let match: RegExpExecArray | null;

	const slashCommandRegex = /(?:^|\s)\/skill:([^\s]+)/g;
	while ((match = slashCommandRegex.exec(text)) !== null) {
		references.push({ commandName: match[1], index: match.index });
	}

	const expandedSkillRegex = /<skill\b[^>]*\bname\s*=\s*(["'])(.*?)\1/gi;
	while ((match = expandedSkillRegex.exec(text)) !== null) {
		references.push({ commandName: match[2], index: match.index });
	}

	return references
		.sort((left, right) => left.index - right.index)
		.map((reference) => reference.commandName);
}
