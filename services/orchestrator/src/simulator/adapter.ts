import type {
  AgentRun,
  ApprovalRequest,
  HealthStatus,
  NormalizedEvent,
  Repo,
  ResolveApprovalInput,
  Settings,
  WorkItem,
} from "@superman/shared-types";
import type { AdapterRunContext, ExecutionAdapter } from "../codex/adapter.js";

type Scenario = "ready" | "approval" | "blocked";

export class SimulatorAdapter implements ExecutionAdapter {
  readonly kind = "simulator" as const;
  private eventHandler: ((event: NormalizedEvent) => void) | null = null;
  private runCount = 0;
  private pendingApprovals = new Map<string, { threadId: string; turnId: string; runId: string }>();

  onEvent(callback: (event: NormalizedEvent) => void) {
    this.eventHandler = callback;
  }

  async start() {
    return;
  }

  getHealth(): HealthStatus {
    return {
      ok: true,
      adapterKind: "simulator",
      codexConnected: false,
      simulatorActive: true,
      message: "Simulator mode is active for local development and demos.",
    };
  }

  async createRun(context: AdapterRunContext) {
    const threadId = `sim-thread-${crypto.randomUUID()}`;
    const turnId = `sim-turn-${crypto.randomUUID()}`;
    const scenario = this.pickScenario();
    this.emit({
      runId: context.run.id,
      source: "simulator",
      threadId,
      turnId,
      method: "thread/started",
      payload: { thread: { id: threadId, preview: context.workItem.title } },
    });
    this.emit({
      runId: context.run.id,
      source: "simulator",
      threadId,
      turnId,
      method: "turn/started",
      payload: { turn: { id: turnId } },
    });
    this.emitLater(600, {
      runId: context.run.id,
      source: "simulator",
      threadId,
      turnId,
      itemId: `item-${crypto.randomUUID()}`,
      method: "item/agentMessage/delta",
      payload: {
        delta: `Working on ${context.workItem.title}. No action needed yet.`,
      },
    });

    if (scenario === "approval") {
      const requestId = `approval-${crypto.randomUUID()}`;
      this.pendingApprovals.set(requestId, {
        threadId,
        turnId,
        runId: context.run.id,
      });
      this.emitLater(1_500, {
        id: requestId,
        runId: context.run.id,
        source: "simulator",
        threadId,
        turnId,
        method: "item/commandExecution/requestApproval",
        payload: {
          threadId,
          turnId,
          itemId: `item-${crypto.randomUUID()}`,
          requestId,
          reason: "Needs approval to install project dependencies.",
          command: "pnpm install",
          availableDecisions: ["accept", "decline"],
        },
      });
    } else if (scenario === "blocked") {
      this.emitLater(1_800, {
        runId: context.run.id,
        source: "simulator",
        threadId,
        turnId,
        method: "error",
        payload: {
          summary:
            "Blocked: the acceptance criteria for the export format are still ambiguous.",
        },
      });
    } else {
      this.emitLater(2_200, {
        runId: context.run.id,
        source: "simulator",
        threadId,
        turnId,
        method: "turn/completed",
        payload: {
          turn: { id: turnId, status: "completed" },
          summary:
            "Ready for review: implemented the main flow and captured the current artifacts.",
        },
      });
    }

    return { threadId, turnId };
  }

  async steerRun(run: AgentRun, instruction: string) {
    this.emit({
      runId: run.id,
      source: "simulator",
      threadId: run.codexThreadId ?? `sim-thread-${run.id}`,
      turnId: run.codexTurnId ?? `sim-turn-${run.id}`,
      method: "item/agentMessage/delta",
      payload: {
        delta: `Human steering applied: ${instruction}`,
      },
    });
  }

  async resolveApproval(
    approval: ApprovalRequest,
    input: ResolveApprovalInput,
  ) {
    if (!approval.requestId) {
      return;
    }
    const pending = this.pendingApprovals.get(approval.requestId);
    if (!pending) {
      return;
    }
    this.pendingApprovals.delete(approval.requestId);
    this.emit({
      id: `resolution-${crypto.randomUUID()}`,
      runId: pending.runId,
      source: "simulator",
      threadId: pending.threadId,
      turnId: pending.turnId,
      method: "serverRequest/resolved",
      payload: {
        requestId: approval.requestId,
        decision: input.decision,
      },
    });
    this.emitLater(1_100, {
      runId: pending.runId,
      source: "simulator",
      threadId: pending.threadId,
      turnId: pending.turnId,
      method: "turn/completed",
      payload: {
        turn: { id: pending.turnId, status: "completed" },
        summary:
          input.decision === "approved"
            ? "Ready for review: approval granted and the run finished successfully."
            : "Blocked: approval was rejected and the run cannot continue.",
      },
    });
  }

  private pickScenario(): Scenario {
    const scenarios: Scenario[] = ["ready", "approval", "blocked"];
    const scenario = scenarios[this.runCount % scenarios.length];
    this.runCount += 1;
    return scenario;
  }

  private emitLater(delay: number, event: Omit<NormalizedEvent, "id" | "timestamp"> & { id?: string }) {
    setTimeout(() => this.emit(event), delay);
  }

  private emit(
    event: Omit<NormalizedEvent, "id" | "timestamp"> & { id?: string },
  ) {
    this.eventHandler?.({
      id: event.id ?? crypto.randomUUID(),
      timestamp: Date.now(),
      ...event,
    });
  }
}
