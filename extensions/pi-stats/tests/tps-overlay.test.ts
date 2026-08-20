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
});
