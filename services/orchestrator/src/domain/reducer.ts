import type {
  AgentRun,
  ApprovalRequest,
  Checkpoint,
  WorkItemStatus,
} from "@superman/shared-types";

function newest<T extends { createdAt?: string; updatedAt?: string }>(items: T[]) {
  return [...items].sort((left, right) => {
    const leftValue = left.updatedAt ?? left.createdAt ?? "";
    const rightValue = right.updatedAt ?? right.createdAt ?? "";
    return rightValue.localeCompare(leftValue);
  })[0] ?? null;
}

export interface DerivedSnapshot {
  status: WorkItemStatus;
  summary: string;
  blocker: string | null;
  nextHumanAction: string | null;
  latestCheckpointId: string | null;
}

export function deriveSnapshot(args: {
  runs: AgentRun[];
  approvals: ApprovalRequest[];
  checkpoints: Checkpoint[];
}): DerivedSnapshot {
  const pendingApprovals = args.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const latestCheckpoint = newest(args.checkpoints);
  const blockedRun = args.runs.find(
    (run) => run.status === "blocked" || run.status === "error",
  );
  const readyRun = args.runs.find(
    (run) => run.status === "ready" || run.status === "completed",
  );
  const runningRun = args.runs.find(
    (run) =>
      run.status === "running" ||
      run.status === "queued" ||
      run.status === "starting",
  );

  if (pendingApprovals.length > 0) {
    const approval = newest(pendingApprovals) ?? pendingApprovals[0];
    return {
      status: "needs_me",
      summary:
        approval.promptSummary || "Needs approval before the run can continue.",
      blocker: approval.reason ?? null,
      nextHumanAction: "Review the approval queue and approve or reject the request.",
      latestCheckpointId: latestCheckpoint?.id ?? null,
    };
  }

  if (blockedRun || latestCheckpoint?.type === "blocked") {
    return {
      status: "blocked",
      summary:
        latestCheckpoint?.summary ||
        "Blocked and waiting for clarification or a dependency to be resolved.",
      blocker: latestCheckpoint?.summary ?? "Execution is currently blocked.",
      nextHumanAction:
        "Open the work item detail, review the blocker, and steer the run with missing context.",
      latestCheckpointId: latestCheckpoint?.id ?? null,
    };
  }

  if (
    readyRun ||
    latestCheckpoint?.type === "ready_for_review" ||
    latestCheckpoint?.type === "completed"
  ) {
    return {
      status: "ready",
      summary:
        latestCheckpoint?.summary ||
        "Ready for review. Inspect changes, tests, and the suggested next step.",
      blocker: null,
      nextHumanAction: "Review the task artifacts and either mark it done or steer follow-up work.",
      latestCheckpointId: latestCheckpoint?.id ?? null,
    };
  }

  if (runningRun) {
    return {
      status: "running",
      summary:
        latestCheckpoint?.summary ||
        "Running in the background. No action needed right now.",
      blocker: null,
      nextHumanAction: null,
      latestCheckpointId: latestCheckpoint?.id ?? null,
    };
  }

  return {
    status: "running",
    summary:
      latestCheckpoint?.summary ||
      "Queued and waiting for its first meaningful update.",
    blocker: null,
    nextHumanAction: null,
    latestCheckpointId: latestCheckpoint?.id ?? null,
  };
}
