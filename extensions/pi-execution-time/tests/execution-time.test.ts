import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createExecutionTimeExtension,
	type ExecutionTimeClock,
} from "../extensions/execution-time.ts";
import type { CompletedStep, StopReason } from "../extensions/execution-tracker.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
type SessionEntryBase = { id: string; parentId: string | null };
type StepEntry = SessionEntryBase & {
	type: "custom";
	customType: "execution-time-step";
	data: CompletedStep;
};
type LegacyStepEntry = SessionEntryBase & {
	type: "custom_message";
	customType: "execution-time-step";
	details: { step: number; elapsedMs: number; completedAt: string };
};
type SessionEntry = StepEntry | LegacyStepEntry | (SessionEntryBase & { type: string; [key: string]: unknown });

function installIntervals(t: TestContext) {
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const active = new Set<number>();
	let nextIntervalId = 1;
	globalThis.setInterval = (() => {
		const id = nextIntervalId++;
		active.add(id);
		return id;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((id: number) => {
		active.delete(id);
	}) as unknown as typeof clearInterval;
	t.after(() => {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	});
	return { active };
}

function createClock(initialMonotonicMs = 1_000, initialWallMs = 10_000) {
	let monotonicMs = initialMonotonicMs;
	let wallMs = initialWallMs;
	const clock: ExecutionTimeClock = {
		now: () => ({ monotonicMs, wallMs }),
	};
	return {
		clock,
		advance(ms: number) {
			monotonicMs += ms;
			wallMs += ms;
		},
		setWall(nextWallMs: number) {
			wallMs = nextWallMs;
		},
	};
}

function createHarness(
	clock: ExecutionTimeClock,
	branchEntries: SessionEntry[] = [],
	allEntries: SessionEntry[] = branchEntries,
) {
	const handlers = new Map<string, EventHandler[]>();
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const appendedEntries: StepEntry[] = [];
	let nextEntryId = 1;

	const pi = {
		on(event: string, handler: EventHandler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		appendEntry(customType: string, data: unknown) {
			const entry: SessionEntry = {
				type: "custom",
				customType,
				data,
				id: `entry-${nextEntryId++}`,
				parentId: branchEntries.at(-1)?.id ?? null,
			};
			if (customType === "execution-time-step") appendedEntries.push(entry as StepEntry);
			branchEntries.push(entry);
			if (allEntries !== branchEntries) allEntries.push(entry);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
		},
		sessionManager: {
			getBranch: () => branchEntries,
			getEntries: () => allEntries,
			getLeafId: () => branchEntries.at(-1)?.id ?? null,
		},
	} as unknown as ExtensionContext;

	createExecutionTimeExtension({ clock })(pi);

	return {
		appendedEntries,
		branchEntries,
		statuses,
		async fire(event: string, payload: Record<string, unknown> = {}) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler({ type: event, ...payload }, ctx));
			}
			return results;
		},
		latestTaskStatus() {
			for (let index = statuses.length - 1; index >= 0; index--) {
				if (statuses[index]?.key === "execution-time") return statuses[index]?.value;
			}
			return undefined;
		},
	};
}

async function startStandardPrompt(harness: ReturnType<typeof createHarness>) {
	await harness.fire("input", { source: "interactive", streamingBehavior: undefined, text: "prompt" });
	await harness.fire("before_agent_start", { prompt: "prompt" });
	await harness.fire("agent_start");
	await harness.fire("message_start", { message: { role: "user", content: "prompt", timestamp: 10_000 } });
}

async function settle(harness: ReturnType<typeof createHarness>, stopReason: StopReason = "stop") {
	await harness.fire("agent_end", { messages: [{ role: "assistant", stopReason }] });
	await harness.fire("agent_settled");
}

test("steering keeps the task timer alive until the agent settles", async (t) => {
	const intervals = installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);

	await harness.fire("session_start");
	await startStandardPrompt(harness);
	fake.advance(1_000);
	await harness.fire("input", { source: "interactive", streamingBehavior: "steer", text: "steer" });
	await harness.fire("message_start", { message: { role: "user", content: "steer", timestamp: 11_000 } });
	fake.advance(1_000);
	await settle(harness);

	assert.match(harness.latestTaskStatus() ?? "", /^✓ task /);
	assert.equal(harness.appendedEntries.length, 1);
	assert.equal(harness.appendedEntries[0]?.data.elapsedMs, 2_000);
	assert.equal(harness.appendedEntries[0]?.data.outcome, "success");

	await harness.fire("session_shutdown");
	assert.equal(intervals.active.size, 0);
});

test("follow-up steps persist immediately with execution and queue durations", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);

	await harness.fire("session_start");
	await startStandardPrompt(harness);
	fake.advance(3_000);
	await harness.fire("input", { source: "interactive", streamingBehavior: "followUp", text: "second" });
	fake.advance(100);
	await harness.fire("message_start", { message: { role: "user", content: "second", timestamp: 13_100 } });
	assert.equal(harness.appendedEntries.length, 1);

	fake.advance(500);
	await harness.fire("input", { source: "interactive", streamingBehavior: "followUp", text: "third" });
	await harness.fire("message_start", { message: { role: "user", content: "third", timestamp: 13_600 } });
	assert.equal(harness.appendedEntries.length, 2);

	fake.advance(250);
	await settle(harness);

	assert.deepEqual(
		harness.appendedEntries.map(({ data }) => ({
			step: data.step,
			elapsedMs: data.elapsedMs,
			queueWaitMs: data.queueWaitMs,
		})),
		[
			{ step: 1, elapsedMs: 3_100, queueWaitMs: 0 },
			{ step: 2, elapsedMs: 500, queueWaitMs: 100 },
			{ step: 3, elapsedMs: 250, queueWaitMs: 0 },
		],
	);

	await harness.fire("session_shutdown");
});

test("session shutdown persists an interrupted step and resume continues numbering", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);

	await harness.fire("session_start");
	await startStandardPrompt(harness);
	fake.advance(750);
	await harness.fire("session_shutdown");
	assert.equal(harness.appendedEntries[0]?.data.outcome, "interrupted");

	await harness.fire("session_start");
	await startStandardPrompt(harness);
	fake.advance(250);
	await settle(harness);

	assert.deepEqual(harness.appendedEntries.map(({ data }) => data.step), [1, 2]);
	await harness.fire("session_shutdown");
});


test("a nonstandard active reload closes the observed segment as interrupted", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);
	await harness.fire("session_start", { reason: "startup" });
	await startStandardPrompt(harness);
	fake.advance(500);
	await harness.fire("session_shutdown", { reason: "reload" });

	assert.equal(harness.appendedEntries[0]?.data.elapsedMs, 500);
	assert.equal(harness.appendedEntries[0]?.data.outcome, "interrupted");
});

test("step numbering is restored from the active branch only", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const assistant2 = messageEntry("assistant-2");
	const assistant7 = messageEntry("assistant-7");
	const assistant99 = messageEntry("assistant-99");
	const branchEntries: SessionEntry[] = [assistant2, stepEntry(2, assistant2.id)];
	const allEntries: SessionEntry[] = [
		...branchEntries,
		assistant7,
		stepEntry(7, assistant7.id),
		assistant99,
		stepEntry(99, assistant99.id),
	];
	const harness = createHarness(fake.clock, branchEntries, allEntries);

	await harness.fire("session_start");
	branchEntries.splice(0, branchEntries.length, assistant7);
	await harness.fire("session_tree");
	await startStandardPrompt(harness);
	fake.advance(100);
	await settle(harness);

	assert.equal(harness.appendedEntries[0]?.data.step, 8);
	await harness.fire("session_shutdown");
});

test("task status reflects error, cancellation, and truncation", async (t) => {
	installIntervals(t);
	const cases: Array<[StopReason, RegExp, CompletedStep["outcome"]]> = [
		["error", /^✗ task /, "error"],
		["aborted", /^■ task /, "cancelled"],
		["length", /^… task /, "truncated"],
	];

	for (const [stopReason, status, outcome] of cases) {
		const fake = createClock();
		const harness = createHarness(fake.clock);
		await harness.fire("session_start");
		await startStandardPrompt(harness);
		fake.advance(100);
		await settle(harness, stopReason);
		assert.match(harness.latestTaskStatus() ?? "", status);
		assert.equal(harness.appendedEntries[0]?.data.outcome, outcome);
		await harness.fire("session_shutdown");
	}
});


test("message_end captures cancellation when no final agent_end follows", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);
	await harness.fire("session_start");
	await startStandardPrompt(harness);
	fake.advance(100);
	await harness.fire("message_end", { message: { role: "assistant", stopReason: "aborted" } });
	await harness.fire("agent_settled");

	assert.match(harness.latestTaskStatus() ?? "", /^■ task /);
	assert.equal(harness.appendedEntries[0]?.data.outcome, "cancelled");
	await harness.fire("session_shutdown");
});

test("legacy step messages are filtered while new entries never enter context", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);
	const legacy = { role: "custom", customType: "execution-time-step", content: "" };
	const other = { role: "custom", customType: "other", content: "keep" };

	const [result] = await harness.fire("context", { messages: [legacy, other] });
	assert.deepEqual((result as { messages: unknown[] }).messages, [other]);
});

test("monotonic duration survives a wall clock rollback", async (t) => {
	installIntervals(t);
	const fake = createClock();
	const harness = createHarness(fake.clock);
	await harness.fire("session_start");
	await startStandardPrompt(harness);
	fake.advance(500);
	fake.setWall(100);
	await settle(harness);

	assert.equal(harness.appendedEntries[0]?.data.elapsedMs, 500);
	assert.equal(harness.appendedEntries[0]?.data.completedAtWallMs, 100);
	await harness.fire("session_shutdown");
});

function stepEntry(step: number, anchorEntryId = `anchor-${step}`): StepEntry {
	return {
		type: "custom",
		customType: "execution-time-step",
		id: `step-${step}`,
		parentId: anchorEntryId,
		data: {
			version: 1,
			step,
			anchorEntryId,
			elapsedMs: 100,
			queueWaitMs: 0,
			completedAtWallMs: 10_000,
			outcome: "success",
		},
	};
}

function messageEntry(id: string): SessionEntry {
	return { type: "message", id, parentId: null };
}
