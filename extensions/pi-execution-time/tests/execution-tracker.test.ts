import assert from "node:assert/strict";
import test from "node:test";
import {
	ExecutionTracker,
	type ClockReading,
	type CompletedStep,
	type TrackerEffect,
} from "../extensions/execution-tracker.ts";

function at(monotonicMs: number, wallMs = 10_000 + monotonicMs): ClockReading {
	return { monotonicMs, wallMs };
}

function completedSteps(effects: TrackerEffect[]) {
	return effects
		.filter((effect): effect is Extract<TrackerEffect, { type: "step_completed" }> => effect.type === "step_completed")
		.map((effect) => effect.step);
}

function startStandardPrompt(tracker: ExecutionTracker, startedAt = 10) {
	tracker.observe({ type: "input_received", at: at(0), source: "interactive", delivery: "idle", text: "initial" });
	tracker.observe({ type: "input_accepted", at: at(1), text: "initial" });
	tracker.observe({ type: "agent_started", at: at(startedAt) });
	tracker.observe({ type: "user_message_started", at: at(startedAt + 1), text: "initial" });
}

test("follow-up records queue wait separately from step execution", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	startStandardPrompt(tracker);

	tracker.observe({ type: "input_received", at: at(100), source: "interactive", delivery: "followUp", text: "second" });
	const boundaryEffects = tracker.observe({ type: "user_message_started", at: at(150), text: "second" });
	assert.deepEqual(completedSteps(boundaryEffects), [
		{
			version: 1,
			step: 1,
			elapsedMs: 140,
			queueWaitMs: 0,
			completedAtWallMs: 10_150,
			outcome: "continued",
			stopReason: undefined,
		},
	]);

	tracker.observe({ type: "agent_outcome", stopReason: "stop" });
	const settledEffects = tracker.observe({ type: "agent_settled", at: at(200, 9_000) });
	const finalStep = completedSteps(settledEffects)[0];
	assert.deepEqual(finalStep, {
		version: 1,
		step: 2,
		elapsedMs: 50,
		queueWaitMs: 50,
		completedAtWallMs: 9_000,
		outcome: "success",
		stopReason: "stop",
	});
	assert.deepEqual(settledEffects.at(-1), {
		type: "task_completed",
		task: {
			elapsedMs: 190,
			completedAtWallMs: 9_000,
			outcome: "success",
			stopReason: "stop",
		},
	});
});

test("steering is delivered before follow-up without splitting the active step", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 3 });
	startStandardPrompt(tracker);

	tracker.observe({ type: "input_received", at: at(20), source: "interactive", delivery: "followUp", text: "later" });
	tracker.observe({ type: "input_received", at: at(30), source: "interactive", delivery: "steer", text: "steer" });
	assert.deepEqual(tracker.observe({ type: "user_message_started", at: at(40), text: "steer" }), []);

	const effects = tracker.observe({ type: "user_message_started", at: at(60), text: "later" });
	assert.equal(completedSteps(effects)[0]?.step, 3);
	assert.equal(completedSteps(effects)[0]?.elapsedMs, 50);
	assert.equal(tracker.snapshot(at(70)).activeStep, 4);
});

test("extension inputs consume their message boundary without creating steps", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	tracker.observe({ type: "input_received", at: at(1), source: "extension", delivery: "idle", text: "extension" });
	tracker.observe({ type: "input_accepted", at: at(2), text: "extension" });
	tracker.observe({ type: "agent_started", at: at(3) });

	assert.deepEqual(tracker.observe({ type: "user_message_started", at: at(4), text: "extension" }), []);
	assert.equal(tracker.snapshot(at(5)).activeStep, undefined);
	assert.equal(tracker.snapshot(at(5)).taskElapsedMs, undefined);
});

test("terminal stop reasons map to explicit outcomes", () => {
	const cases: Array<["stop" | "error" | "aborted" | "length" | "toolUse", CompletedStep["outcome"]]> = [
		["stop", "success"],
		["error", "error"],
		["aborted", "cancelled"],
		["length", "truncated"],
		["toolUse", "unknown"],
	];

	for (const [stopReason, outcome] of cases) {
		const tracker = new ExecutionTracker();
		tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
		startStandardPrompt(tracker);
		tracker.observe({ type: "agent_outcome", stopReason });
		const effects = tracker.observe({ type: "agent_settled", at: at(20) });
		assert.equal(completedSteps(effects)[0]?.outcome, outcome);
	}
});


test("custom-triggered agent runs do not start a standard task", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	tracker.observe({ type: "agent_started", at: at(10) });
	assert.equal(tracker.snapshot(at(20)).taskElapsedMs, undefined);
});

test("transformed queued input is matched by the message timestamp", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	startStandardPrompt(tracker);
	tracker.observe({
		type: "input_received",
		at: at(20, 20_000),
		source: "interactive",
		delivery: "followUp",
		text: "/template",
	});

	const effects = tracker.observe({
		type: "user_message_started",
		at: at(40_020, 60_020),
		text: "expanded prompt",
		messageWallMs: 60_000,
	});
	assert.equal(completedSteps(effects).length, 1);
	assert.equal(tracker.snapshot(at(31)).activeStep, 2);
});


test("timestamp wins when steer and follow-up expand to the same text", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	startStandardPrompt(tracker);
	tracker.observe({ type: "input_received", at: at(20, 20_000), source: "interactive", delivery: "followUp", text: "expanded" });
	tracker.observe({ type: "input_received", at: at(50, 50_000), source: "interactive", delivery: "steer", text: "/template" });

	const steerEffects = tracker.observe({
		type: "user_message_started",
		at: at(60, 50_010),
		text: "expanded",
		messageWallMs: 50_000,
	});
	assert.deepEqual(steerEffects, []);
	assert.equal(tracker.snapshot(at(61)).activeStep, 1);

	const followUpEffects = tracker.observe({
		type: "user_message_started",
		at: at(70, 50_020),
		text: "expanded",
		messageWallMs: 20_000,
	});
	assert.equal(completedSteps(followUpEffects).length, 1);
	assert.equal(tracker.snapshot(at(71)).activeStep, 2);
});

test("duplicate text uses the closest message timestamp", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	startStandardPrompt(tracker);
	tracker.observe({ type: "input_received", at: at(20, 20_000), source: "interactive", delivery: "followUp", text: "same" });
	tracker.observe({ type: "input_received", at: at(50, 50_000), source: "interactive", delivery: "followUp", text: "same" });
	tracker.observe({ type: "user_message_started", at: at(60, 50_010), text: "same", messageWallMs: 50_000 });
	tracker.observe({ type: "agent_outcome", stopReason: "stop" });

	const effects = tracker.observe({ type: "agent_settled", at: at(70) });
	assert.equal(completedSteps(effects)[0]?.queueWaitMs, 10);
});

test("an unobserved message without candidates leaves the active step unchanged", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(0), nextStep: 1 });
	startStandardPrompt(tracker);

	const effects = tracker.observe({
		type: "user_message_started",
		at: at(50_000, 100_000),
		text: "compaction-direct",
		messageWallMs: 100_000,
	});
	assert.deepEqual(effects, [{ type: "diagnostic", code: "unmatched_user_message" }]);
	assert.equal(tracker.snapshot(at(50_001)).activeStep, 1);
});

test("durations use monotonic time when the wall clock moves backwards", () => {
	const tracker = new ExecutionTracker();
	tracker.observe({ type: "session_started", at: at(100, 50_000), nextStep: 1 });
	tracker.observe({ type: "input_received", at: at(105, 50_005), source: "interactive", delivery: "idle", text: "initial" });
	tracker.observe({ type: "input_accepted", at: at(106, 50_006), text: "initial" });
	tracker.observe({ type: "agent_started", at: at(110, 50_010) });

	assert.equal(tracker.snapshot(at(160, 1_000)).sessionRuntimeMs, 60);
	assert.equal(tracker.snapshot(at(160, 1_000)).taskElapsedMs, 50);
});
