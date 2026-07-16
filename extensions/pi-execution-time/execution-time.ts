import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	ExecutionTracker,
	type ClockReading,
	type CompletedStep,
	type CompletedTask,
	type StopReason,
	type TaskOutcome,
	type TrackerEffect,
} from "./execution-tracker.ts";

const TASK_STATUS_KEY = "execution-time";
const TOTAL_STATUS_KEY = "zz-execution-time-total";
const STEP_ENTRY_TYPE = "execution-time-step";
const TASK_UPDATE_INTERVAL_MS = 250;
const TOTAL_UPDATE_INTERVAL_MS = 1000;

export type ExecutionTimeClock = {
	now(): ClockReading;
};

type LegacyCompletedStep = {
	step: number;
	elapsedMs: number;
	completedAt: string;
};

const systemClock: ExecutionTimeClock = {
	now: () => ({ monotonicMs: performance.now(), wallMs: Date.now() }),
};

export function createExecutionTimeExtension(options: { clock?: ExecutionTimeClock } = {}) {
	const clock = options.clock ?? systemClock;

	return function executionTimeExtension(pi: ExtensionAPI) {
		const tracker = new ExecutionTracker();
		let totalInterval: ReturnType<typeof setInterval> | undefined;
		let taskInterval: ReturnType<typeof setInterval> | undefined;

		function stopTaskUpdates() {
			if (!taskInterval) return;
			clearInterval(taskInterval);
			taskInterval = undefined;
		}

		function startTaskUpdates(ctx: ExtensionContext) {
			if (taskInterval || !hasUi(ctx)) return;
			taskInterval = setInterval(() => {
				try {
					renderTaskRunning(ctx, tracker.snapshot(clock.now()).taskElapsedMs);
				} catch {
					stopTaskUpdates();
				}
			}, TASK_UPDATE_INTERVAL_MS);
			renderTaskRunning(ctx, tracker.snapshot(clock.now()).taskElapsedMs);
		}

		function stopTotalUpdates() {
			if (!totalInterval) return;
			clearInterval(totalInterval);
			totalInterval = undefined;
		}

		function startTotalUpdates(ctx: ExtensionContext) {
			if (!hasUi(ctx)) return;
			stopTotalUpdates();
			totalInterval = setInterval(() => {
				try {
					renderRuntime(ctx, tracker.snapshot(clock.now()).sessionRuntimeMs);
				} catch {
					stopTotalUpdates();
				}
			}, TOTAL_UPDATE_INTERVAL_MS);
			renderRuntime(ctx, tracker.snapshot(clock.now()).sessionRuntimeMs);
		}

		function applyEffects(effects: TrackerEffect[], ctx: ExtensionContext, renderTask = true) {
			for (const effect of effects) {
				if (effect.type === "step_completed") {
					const anchorEntryId = ctx.sessionManager.getLeafId();
					pi.appendEntry(STEP_ENTRY_TYPE, {
						...effect.step,
						...(anchorEntryId ? { anchorEntryId } : {}),
					});
				} else if (effect.type === "task_completed" && renderTask && hasUi(ctx)) {
					renderTaskDone(ctx, effect.task);
				}
			}
		}

		pi.registerEntryRenderer<CompletedStep>(STEP_ENTRY_TYPE, (entry, options, theme) => {
			const step = entry.data;
			if (!step) return new Text(theme.fg("muted", "? step"), 0, 0);

			let text = renderStepText(step, theme);
			if (options.expanded && step.queueWaitMs > 0) {
				text += theme.fg("dim", ` · queued ${formatElapsed(step.queueWaitMs)}`);
			}
			return new Text(text, 0, 0);
		});

		// Keep old sessions readable while new records use context-free custom entries.
		pi.registerMessageRenderer<LegacyCompletedStep>(STEP_ENTRY_TYPE, (message, _options, theme) => {
			const details = message.details;
			if (!details) return new Text(theme.fg("muted", "? step"), 0, 0);
			return new Text(
				renderStepText(
					{
						version: 1,
						step: details.step,
						elapsedMs: details.elapsedMs,
						queueWaitMs: 0,
						completedAtWallMs: new Date(details.completedAt).getTime(),
						outcome: "success",
					},
					theme,
				),
				0,
				0,
			);
		});

		pi.on("session_start", async (_event, ctx) => {
			const reading = clock.now();
			tracker.observe({ type: "session_started", at: reading, nextStep: getNextStep(ctx) });
			stopTaskUpdates();
			startTotalUpdates(ctx);
		});

		pi.on("session_tree", async (_event, ctx) => {
			tracker.observe({ type: "branch_changed", nextStep: getNextStep(ctx) });
		});

		pi.on("context", async (event) => ({
			messages: event.messages.filter(
				(message) => message.role !== "custom" || message.customType !== STEP_ENTRY_TYPE,
			),
		}));

		pi.on("input", async (event) => {
			tracker.observe({
				type: "input_received",
				at: clock.now(),
				source: event.source,
				delivery: event.streamingBehavior ?? "idle",
				text: event.text,
			});
		});

		pi.on("before_agent_start", async (event) => {
			tracker.observe({ type: "input_accepted", at: clock.now(), text: event.prompt });
		});

		pi.on("agent_start", async (_event, ctx) => {
			const reading = clock.now();
			applyEffects(tracker.observe({ type: "agent_started", at: reading }), ctx);
			if (tracker.snapshot(reading).taskElapsedMs !== undefined) startTaskUpdates(ctx);
		});

		pi.on("message_start", async (event, ctx) => {
			if (event.message.role !== "user") return;
			applyEffects(
				tracker.observe({
					type: "user_message_started",
					at: clock.now(),
					text: getUserText(event.message),
					messageWallMs: event.message.timestamp,
				}),
				ctx,
			);
		});

		pi.on("message_end", async (event) => {
			if (event.message.role === "assistant") {
				tracker.observe({ type: "agent_outcome", stopReason: event.message.stopReason });
			}
		});

		pi.on("agent_end", async (event) => {
			const stopReason = getLastStopReason(event.messages);
			if (stopReason) tracker.observe({ type: "agent_outcome", stopReason });
		});

		pi.on("agent_settled", async (_event, ctx) => {
			const effects = tracker.observe({ type: "agent_settled", at: clock.now() });
			stopTaskUpdates();
			applyEffects(effects, ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			const effects = tracker.observe({ type: "session_ended", at: clock.now() });
			applyEffects(effects, ctx, false);
			stopTaskUpdates();
			stopTotalUpdates();
			if (hasUi(ctx)) {
				ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
				ctx.ui.setStatus(TOTAL_STATUS_KEY, undefined);
			}
		});
	};
}

export default createExecutionTimeExtension();

function renderTaskRunning(ctx: ExtensionContext, elapsedMs: number | undefined) {
	if (elapsedMs === undefined) return;
	const icon = ctx.ui.theme.fg("accent", "⏱");
	const text = ctx.ui.theme.fg("dim", ` ${formatElapsed(elapsedMs)}`);
	ctx.ui.setStatus(TASK_STATUS_KEY, icon + text);
}

function renderTaskDone(ctx: ExtensionContext, task: CompletedTask) {
	const style = outcomeStyle(task.outcome);
	const icon = ctx.ui.theme.fg(style.color, style.icon);
	const label = ctx.ui.theme.fg("dim", " task ");
	const duration = ctx.ui.theme.fg("muted", formatElapsed(task.elapsedMs));
	const separator = ctx.ui.theme.fg("dim", " · ");
	const completedTime = ctx.ui.theme.fg("muted", formatCompletedAt(new Date(task.completedAtWallMs)));
	ctx.ui.setStatus(TASK_STATUS_KEY, icon + label + duration + separator + completedTime);
}

function renderRuntime(ctx: ExtensionContext, elapsedMs: number) {
	const icon = ctx.ui.theme.fg("accent", "Σ");
	const label = ctx.ui.theme.fg("dim", " runtime ");
	const elapsed = ctx.ui.theme.fg("muted", formatElapsed(elapsedMs));
	ctx.ui.setStatus(TOTAL_STATUS_KEY, icon + label + elapsed);
}

function renderStepText(
	step: CompletedStep,
	theme: ExtensionContext["ui"]["theme"],
) {
	const style = outcomeStyle(step.outcome === "continued" ? "success" : step.outcome);
	return `${theme.fg(style.color, style.icon)} ${theme.fg("dim", `step ${step.step}`)} ${theme.fg("muted", formatElapsed(step.elapsedMs))} ${theme.fg("dim", "·")} ${theme.fg("muted", formatCompletedAt(new Date(step.completedAtWallMs)))}`;
}

function outcomeStyle(outcome: TaskOutcome) {
	switch (outcome) {
		case "success":
			return { icon: "✓", color: "success" as const };
		case "error":
			return { icon: "✗", color: "error" as const };
		case "cancelled":
			return { icon: "■", color: "warning" as const };
		case "truncated":
			return { icon: "…", color: "warning" as const };
		case "interrupted":
			return { icon: "!", color: "warning" as const };
		default:
			return { icon: "?", color: "muted" as const };
	}
}

function getUserText(message: { content: string | Array<{ type: string; text?: string }> }) {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

function getLastStopReason(messages: Array<{ role: string; stopReason?: StopReason }>) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && message.stopReason) return message.stopReason;
	}
	return undefined;
}

function getNextStep(ctx: ExtensionContext) {
	let maxStep = 0;
	const branch = ctx.sessionManager.getBranch();
	const branchIds = new Set(branch.map((entry) => entry.id));

	for (const entry of ctx.sessionManager.getEntries()) {
		let step: unknown;
		let anchorEntryId: unknown;
		if (entry.type === "custom" && entry.customType === STEP_ENTRY_TYPE) {
			const data = entry.data as { step?: unknown; anchorEntryId?: unknown } | undefined;
			step = data?.step;
			anchorEntryId = data?.anchorEntryId ?? entry.parentId;
		} else if (entry.type === "custom_message" && entry.customType === STEP_ENTRY_TYPE) {
			step = (entry.details as { step?: unknown } | undefined)?.step;
			anchorEntryId = entry.parentId;
		} else {
			continue;
		}

		const belongsToBranch = typeof anchorEntryId === "string"
			? branchIds.has(anchorEntryId)
			: branchIds.has(entry.id);
		if (!belongsToBranch) continue;
		if (typeof step === "number" && Number.isInteger(step) && step > 0) maxStep = Math.max(maxStep, step);
	}
	return maxStep + 1;
}

function hasUi(ctx: ExtensionContext) {
	return ctx.hasUI !== false;
}

function formatElapsed(ms: number) {
	const totalSeconds = Math.max(0, ms / 1000);
	if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;

	const roundedSeconds = Math.floor(totalSeconds);
	const seconds = roundedSeconds % 60;
	const totalMinutes = Math.floor(roundedSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
	if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
	return `${roundedSeconds}s`;
}

function formatCompletedAt(date: Date) {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number) {
	return value.toString().padStart(2, "0");
}
