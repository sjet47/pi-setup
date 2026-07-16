export type ClockReading = {
	monotonicMs: number;
	wallMs: number;
};

export type InputSource = "interactive" | "rpc" | "extension";
export type InputDelivery = "idle" | "steer" | "followUp";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type TaskOutcome = "success" | "error" | "cancelled" | "truncated" | "interrupted" | "unknown";

export type ExecutionEvent =
	| { type: "session_started"; at: ClockReading; nextStep: number }
	| { type: "branch_changed"; nextStep: number }
	| { type: "input_received"; at: ClockReading; source: InputSource; delivery: InputDelivery; text: string }
	| { type: "input_accepted"; at: ClockReading; text: string }
	| { type: "agent_started"; at: ClockReading }
	| { type: "user_message_started"; at: ClockReading; text: string; messageWallMs?: number }
	| { type: "agent_outcome"; stopReason: StopReason }
	| { type: "agent_settled"; at: ClockReading }
	| { type: "session_ended"; at: ClockReading };

export type CompletedStep = {
	version: 1;
	anchorEntryId?: string;
	step: number;
	elapsedMs: number;
	queueWaitMs: number;
	completedAtWallMs: number;
	outcome: TaskOutcome | "continued";
	stopReason?: StopReason;
};

export type CompletedTask = {
	elapsedMs: number;
	completedAtWallMs: number;
	outcome: TaskOutcome;
	stopReason?: StopReason;
};

export type TrackerEffect =
	| { type: "step_completed"; step: CompletedStep }
	| { type: "task_completed"; task: CompletedTask }
	| { type: "diagnostic"; code: "unmatched_user_message" | "missing_agent_start" };

export type ExecutionSnapshot = {
	sessionRuntimeMs: number;
	taskElapsedMs?: number;
	activeStep?: number;
};

type PendingInput = {
	source: InputSource;
	delivery: InputDelivery;
	text: string;
	queuedAtMonotonicMs: number;
	queuedAtWallMs: number;
};

type ActiveTask = {
	startedAtMonotonicMs: number;
	lastStopReason?: StopReason;
};

type ActiveStep = {
	step: number;
	startedAtMonotonicMs: number;
	queueWaitMs: number;
};

export class ExecutionTracker {
	private sessionStartedAtMonotonicMs: number | undefined;
	private nextStep = 1;
	private task: ActiveTask | undefined;
	private activeStep: ActiveStep | undefined;
	private idleInput: PendingInput | undefined;
	private readonly acceptedInputs: PendingInput[] = [];
	private readonly steeringInputs: PendingInput[] = [];
	private readonly followUpInputs: PendingInput[] = [];

	observe(event: ExecutionEvent): TrackerEffect[] {
		switch (event.type) {
			case "session_started":
				this.resetSession(event.at.monotonicMs, event.nextStep);
				return [];

			case "branch_changed":
				this.nextStep = event.nextStep;
				this.clearPendingInputs();
				return [];

			case "input_received": {
				const input: PendingInput = {
					source: event.source,
					delivery: event.delivery,
					text: event.text,
					queuedAtMonotonicMs: event.at.monotonicMs,
					queuedAtWallMs: event.at.wallMs,
				};

				if (event.delivery === "idle") this.idleInput = input;
				else if (event.delivery === "steer") this.steeringInputs.push(input);
				else this.followUpInputs.push(input);
				return [];
			}

			case "input_accepted": {
				if (this.idleInput) {
					this.acceptedInputs.push({ ...this.idleInput, text: event.text });
				}
				this.idleInput = undefined;
				return [];
			}

			case "agent_started":
				if (!this.task && this.acceptedInputs[0] && this.acceptedInputs[0].source !== "extension") {
					this.task = { startedAtMonotonicMs: event.at.monotonicMs };
				}
				return [];

			case "user_message_started":
				return this.startUserMessage(event);

			case "agent_outcome":
				if (this.task) this.task.lastStopReason = event.stopReason;
				return [];

			case "agent_settled":
				return this.completeTask(event.at, outcomeFor(this.task?.lastStopReason));

			case "session_ended":
				return this.completeTask(event.at, "interrupted");
		}
	}

	snapshot(now: ClockReading): ExecutionSnapshot {
		return {
			sessionRuntimeMs: elapsed(this.sessionStartedAtMonotonicMs, now.monotonicMs),
			taskElapsedMs: this.task ? elapsed(this.task.startedAtMonotonicMs, now.monotonicMs) : undefined,
			activeStep: this.activeStep?.step,
		};
	}
	private startUserMessage(event: Extract<ExecutionEvent, { type: "user_message_started" }>): TrackerEffect[] {
		const input = this.takeMatchingInput(event.text, event.messageWallMs);
		if (!input) return [{ type: "diagnostic", code: "unmatched_user_message" }];
		if (input.source === "extension" || input.delivery === "steer") return [];
		const at = event.at;
		const effects: TrackerEffect[] = [];
		if (!this.task) {
			this.task = { startedAtMonotonicMs: at.monotonicMs };
			effects.push({ type: "diagnostic", code: "missing_agent_start" });
		}

		const previousStep = this.activeStep;
		if (previousStep) {
			effects.push({ type: "step_completed", step: this.completeStep(at, "continued") });
		}

		this.activeStep = {
			step: this.nextStep++,
			startedAtMonotonicMs: previousStep ? at.monotonicMs : this.task.startedAtMonotonicMs,
			queueWaitMs: input.delivery === "followUp" ? elapsed(input.queuedAtMonotonicMs, at.monotonicMs) : 0,
		};
		return effects;
	}

	private completeTask(at: ClockReading, outcome: TaskOutcome): TrackerEffect[] {
		if (!this.task) return [];

		const stopReason = this.task.lastStopReason;
		const effects: TrackerEffect[] = [];
		if (this.activeStep) {
			effects.push({ type: "step_completed", step: this.completeStep(at, outcome, stopReason) });
		}

		effects.push({
			type: "task_completed",
			task: {
				elapsedMs: elapsed(this.task.startedAtMonotonicMs, at.monotonicMs),
				completedAtWallMs: at.wallMs,
				outcome,
				stopReason,
			},
		});

		this.task = undefined;
		this.activeStep = undefined;
		this.clearPendingInputs();
		return effects;
	}

	private completeStep(
		at: ClockReading,
		outcome: CompletedStep["outcome"],
		stopReason?: StopReason,
	): CompletedStep {
		const step = this.activeStep!;
		return {
			version: 1,
			step: step.step,
			elapsedMs: elapsed(step.startedAtMonotonicMs, at.monotonicMs),
			queueWaitMs: step.queueWaitMs,
			completedAtWallMs: at.wallMs,
			outcome,
			stopReason,
		};
	}

	private takeMatchingInput(text: string, messageWallMs: number | undefined) {
		const queues = [this.acceptedInputs, this.steeringInputs, this.followUpInputs];
		if (messageWallMs === undefined) {
			for (const queue of queues) {
				const index = queue.findIndex((input) => input.text === text);
				if (index >= 0) return queue.splice(index, 1)[0];
			}
			return undefined;
		}

		let best: {
			queue: PendingInput[];
			index: number;
			distance: number;
			queuePriority: number;
			textMatches: boolean;
		} | undefined;

		for (let queuePriority = 0; queuePriority < queues.length; queuePriority++) {
			const queue = queues[queuePriority]!;
			for (let index = 0; index < queue.length; index++) {
				const input = queue[index]!;
				const candidate = {
					queue,
					index,
					distance: Math.abs(input.queuedAtWallMs - messageWallMs),
					queuePriority,
					textMatches: input.text === text,
				};
				if (!best || compareMatches(candidate, best) < 0) best = candidate;
			}
		}

		if (!best) return undefined;
		return best.queue.splice(best.index, 1)[0];
	}

	private resetSession(startedAtMonotonicMs: number, nextStep: number) {
		this.sessionStartedAtMonotonicMs = startedAtMonotonicMs;
		this.nextStep = nextStep;
		this.task = undefined;
		this.activeStep = undefined;
		this.clearPendingInputs();
	}

	private clearPendingInputs() {
		this.idleInput = undefined;
		this.acceptedInputs.length = 0;
		this.steeringInputs.length = 0;
		this.followUpInputs.length = 0;
}
}

type MatchOrder = {
	distance: number;
	queuePriority: number;
	textMatches: boolean;
	index: number;
};

function compareMatches(left: MatchOrder, right: MatchOrder) {
	return left.distance - right.distance
		|| left.queuePriority - right.queuePriority
		|| Number(right.textMatches) - Number(left.textMatches)
		|| left.index - right.index;
}

function outcomeFor(stopReason: StopReason | undefined): TaskOutcome {
	switch (stopReason) {
		case "stop":
			return "success";
		case "error":
			return "error";
		case "aborted":
			return "cancelled";
		case "length":
			return "truncated";
		default:
			return "unknown";
	}
}

function elapsed(start: number | undefined, end: number) {
	return start === undefined ? 0 : Math.max(0, end - start);
}
