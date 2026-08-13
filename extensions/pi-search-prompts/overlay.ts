import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { mergePrompts, type PromptHistoryEntry } from "./history";

const VISIBLE_ROWS = 7;
const PREVIEW_LINES = 7;

type PromptScope = "project" | "global";

export class PromptSearchOverlay implements Component, Focusable {
	private readonly searchInput = new Input();
	private cachedWidth?: number;
	private cachedLines?: string[];
	private projectEntries: PromptHistoryEntry[] = [];
	private projectLoaded = false;
	private projectLoading = false;
	private projectError?: string;
	private globalEntries?: PromptHistoryEntry[];
	private globalLoading = false;
	private globalError?: string;
	private selectedIndex = 0;
	private windowStart = 0;
	private scope: PromptScope = "project";
	private _focused = false;

	constructor(
		private readonly sessionEntries: PromptHistoryEntry[],
		private readonly theme: Theme,
		private readonly onDone: (prompt?: string) => void,
		private readonly loadProject: () => Promise<PromptHistoryEntry[]>,
		private readonly loadGlobal: () => Promise<PromptHistoryEntry[]>,
		private readonly requestRender: () => void,
		private readonly keybindings: KeybindingsManager,
	) {
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.searchInput.onEscape = () => this.onDone();
		this.projectEntries = sessionEntries;
		this.selectNewest();
		this.ensureLoaded("project");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.onDone();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.toggleScope();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-VISIBLE_ROWS);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(VISIBLE_ROWS);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
			this.selectCurrent();
			return;
		}

		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (before !== this.searchInput.getValue()) {
			this.selectNewest();
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Search prompts", Math.max(0, width), "")];
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const contentWidth = Math.max(1, width - 2);
		const prompts = this.prompts();
		this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, prompts.length - 1));
		this.windowStart = clamp(this.windowStart, Math.max(0, this.selectedIndex - VISIBLE_ROWS + 1), this.selectedIndex);
		this.windowStart = clamp(this.windowStart, 0, Math.max(0, prompts.length - VISIBLE_ROWS));

		const scopeLabel = this.scope === "global" ? "everywhere" : "this project";
		const visiblePrompts = prompts.slice(this.windowStart, this.windowStart + VISIBLE_ROWS);
		const lines = [
			this.border("top", width),
			this.line(`${this.theme.fg("accent", this.theme.bold(` Search prompts - ${scopeLabel} `))}${this.theme.fg("dim", this.summary(prompts.length))}`, contentWidth),
			this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
		];

		if (contentWidth >= 78) lines.push(...this.renderWide(visiblePrompts, contentWidth));
		else lines.push(...this.renderCompact(visiblePrompts, contentWidth));

		lines.push(
			this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
			this.line(this.renderSearch(contentWidth), contentWidth),
			this.line(this.theme.fg("dim", "Up/Down navigate | Enter use | Esc cancel | Tab scope"), contentWidth),
			this.border("bottom", width),
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.searchInput.invalidate();
	}

	private renderWide(prompts: PromptHistoryEntry[], contentWidth: number): string[] {
		const listWidth = Math.max(28, Math.floor((contentWidth - 3) * 0.42));
		const previewWidth = Math.max(1, contentWidth - listWidth - 3);
		const preview = this.previewLines(previewWidth);
		const lines: string[] = [];
		const rowCount = Math.max(VISIBLE_ROWS, preview.length);
		for (let index = 0; index < rowCount; index += 1) {
			const prompt = prompts[index];
			const absoluteIndex = this.windowStart + index;
			const list = prompt
				? this.renderPromptRow(prompt, absoluteIndex === this.selectedIndex, listWidth)
				: "";
			const previewLine = preview[index] ?? "";
			lines.push(this.line(`${this.cell(list, listWidth)} ${this.theme.fg("borderMuted", "│")} ${this.cell(previewLine, previewWidth)}`, contentWidth));
		}
		return lines;
	}

	private renderCompact(prompts: PromptHistoryEntry[], contentWidth: number): string[] {
		if (this.scopeLoading() && prompts.length === 0) return [this.line(this.theme.fg("muted", " Loading prompt history..."), contentWidth)];
		if (this.scopeError() && prompts.length === 0) return [this.line(this.theme.fg("warning", ` ${this.scopeError()}`), contentWidth)];
		if (prompts.length === 0) return [this.line(this.theme.fg("muted", " No matching prompts."), contentWidth)];
		return prompts.map((prompt, index) => {
			const absoluteIndex = this.windowStart + index;
			return this.line(this.renderPromptRow(prompt, absoluteIndex === this.selectedIndex, contentWidth), contentWidth);
		});
	}

	private previewLines(width: number): string[] {
		if (this.scopeLoading() && !this.selectedPrompt()) return [this.theme.fg("muted", "Loading prompt history...")];
		if (this.scopeError() && !this.selectedPrompt()) return [this.theme.fg("warning", this.scopeError() ?? "")];
		const selected = this.selectedPrompt();
		if (!selected) return [this.theme.fg("muted", "No matching prompts.")];

		const lines = wrapTextWithAnsi(selected.text, Math.max(1, width)).slice(0, PREVIEW_LINES);
		if (selected.cwd && lines.length < PREVIEW_LINES) lines.push(this.theme.fg("dim", selected.cwd));
		return lines;
	}

	private renderPromptRow(prompt: PromptHistoryEntry, selected: boolean, width: number): string {
		const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
		const age = this.theme.fg("dim", `${formatAge(prompt.timestamp).padStart(6)} `);
		const textWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(age));
		return `${prefix}${age}${truncateToWidth(singleLine(prompt.text), textWidth, "...")}`;
	}

	private renderSearch(contentWidth: number): string {
		const label = this.theme.fg("muted", " Search: ");
		const inputWidth = Math.max(1, contentWidth - visibleWidth(" Search: "));
		return label + (this.searchInput.render(inputWidth)[0] ?? "");
	}

	private summary(count: number): string {
		const total = this.entries().length;
		const query = this.searchInput.getValue().trim();
		const counts = query ? `  ${count}/${total} matches` : `  ${total} prompts`;
		return this.scopeLoading() ? `${counts}  loading...` : counts;
	}

	private prompts(): PromptHistoryEntry[] {
		const entries = this.entries();
		const query = this.searchInput.getValue().trim();
		return query ? fuzzyFilter(entries, query, (entry) => entry.text) : entries;
	}

	private entries(): PromptHistoryEntry[] {
		return this.scope === "project" ? this.projectEntries : (this.globalEntries ?? this.sessionEntries);
	}

	private selectedPrompt(): PromptHistoryEntry | undefined {
		return this.prompts()[this.selectedIndex];
	}

	private selectNewest(): void {
		this.selectedIndex = Math.max(0, this.prompts().length - 1);
		this.windowStart = Math.max(0, this.selectedIndex - VISIBLE_ROWS + 1);
	}

	private moveSelection(delta: number): void {
		const prompts = this.prompts();
		if (prompts.length === 0) return;
		this.selectedIndex = clamp(this.selectedIndex + delta, 0, prompts.length - 1);
		if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex;
		if (this.selectedIndex >= this.windowStart + VISIBLE_ROWS) this.windowStart = this.selectedIndex - VISIBLE_ROWS + 1;
		this.invalidate();
	}

	private selectCurrent(): void {
		const prompt = this.selectedPrompt();
		if (prompt) this.onDone(prompt.text);
	}

	private toggleScope(): void {
		this.scope = this.scope === "project" ? "global" : "project";
		this.selectNewest();
		this.invalidate();
		this.requestRender();
		this.ensureLoaded(this.scope);
	}

	private ensureLoaded(scope: PromptScope): void {
		if (scope === "project") {
			if (this.projectLoaded || this.projectLoading) return;
			this.projectLoading = true;
			void this.loadProject()
				.then((entries) => {
					this.projectEntries = mergePrompts(this.sessionEntries, entries);
					this.projectError = undefined;
					this.projectLoaded = true;
					if (this.scope === "project") this.selectNewest();
				})
				.catch(() => {
					this.projectError = "Could not load prompt history.";
				})
				.finally(() => {
					this.projectLoading = false;
					this.invalidate();
					this.requestRender();
				});
			return;
		}

		if (this.globalEntries || this.globalLoading) return;
		this.globalLoading = true;
		void this.loadGlobal()
			.then((entries) => {
				this.globalEntries = mergePrompts(this.sessionEntries, entries);
				this.globalError = undefined;
				if (this.scope === "global") this.selectNewest();
			})
			.catch(() => {
				this.globalError = "Could not load prompt history.";
			})
			.finally(() => {
				this.globalLoading = false;
				this.invalidate();
				this.requestRender();
			});
	}

	private scopeLoading(): boolean {
		return this.scope === "project" ? this.projectLoading : this.globalLoading;
	}

	private scopeError(): string | undefined {
		return this.scope === "project" ? this.projectError : this.globalError;
	}

	private cell(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, "...");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	}

	private line(content: string, contentWidth: number): string {
		const clipped = truncateToWidth(content, contentWidth, "...");
		return this.theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped))) + this.theme.fg("border", "│");
	}

	private border(position: "top" | "bottom", width: number): string {
		const [left, right] = position === "top" ? ["╭", "╮"] : ["╰", "╯"];
		return this.theme.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
}
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function formatAge(timestamp: number): string {
	const elapsed = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return new Date(timestamp).toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
