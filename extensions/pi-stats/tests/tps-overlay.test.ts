import { describe, expect, it } from "vitest";
import { TpsStatsOverlay } from "../src/tps/overlay";
import type { ModelTpsSummary } from "../src/tps/types";

const testTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function createOverlay(onClose: () => void) {
	const rows: ModelTpsSummary[] = [{
		provider: "provider-a",
		model: "model-1",
		samples: 1,
		lastSeen: 1_700_000_000,
		avgTtftMs: 500,
		avgTps: 10,
		avgThinkingTokens: 20,
	}];
	return new TpsStatsOverlay(rows, testTheme, onClose, () => ({ points: [], thinkingLevels: [] }));
}

function bucketLabel(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
}

describe("TpsStatsOverlay", () => {
	it("only allows Escape to close from the list", () => {
		const overlay = createOverlay(() => {});

		expect(overlay.shouldCloseOnEscape()).toBe(true);

		overlay.handleInput("\r");
		expect(overlay.shouldCloseOnEscape()).toBe(false);

		overlay.handleInput("\u001b");
		expect(overlay.shouldCloseOnEscape()).toBe(true);
	});

	it("closes from the list with escape", () => {
		let closeCount = 0;
		const overlay = createOverlay(() => closeCount += 1);

		overlay.handleInput("\u001b");

		expect(closeCount).toBe(1);
	});

	it("returns to the list from detail with escape instead of closing", () => {
		let closeCount = 0;
		const overlay = createOverlay(() => closeCount += 1);

		overlay.handleInput("\r");
		expect(overlay.render(100).join("\n")).toContain("TPS trend");

		overlay.handleInput("\u001b");

		expect(closeCount).toBe(0);
		expect(overlay.render(100).join("\n")).toContain("TPS stats");

		overlay.handleInput("\u001b");
		expect(closeCount).toBe(1);
	});

	it("renders the trend newest-first in detail", () => {
		const base = new Date(2026, 0, 1, 0, 0, 0).getTime();
		const points = [0, 1, 2, 3].map((hour) => ({
			bucketStart: base + hour * 3_600_000,
			samples: 1,
			avgTtftMs: 0,
			avgTps: 10,
			avgThinkingTokens: 0,
		}));
		const rows: ModelTpsSummary[] = [{
			provider: "provider-a",
			model: "model-1",
			samples: 1,
			lastSeen: 1_700_000_000,
			avgTtftMs: 0,
			avgTps: 10,
			avgThinkingTokens: 0,
		}];
		const overlay = new TpsStatsOverlay(rows, testTheme, () => {}, () => ({ points, thinkingLevels: [] }));
		overlay.handleInput("\r");
		const text = overlay.render(140).join("\n");
		const newest = bucketLabel(base + 3 * 3_600_000);
		const oldest = bucketLabel(base);
		expect(text).toContain(newest);
		expect(text.indexOf(newest)).toBeLessThan(text.indexOf(oldest));
	});
});
