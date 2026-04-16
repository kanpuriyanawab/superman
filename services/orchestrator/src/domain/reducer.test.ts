import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRun, ApprovalRequest, Checkpoint } from "@superman/shared-types";
import { deriveSnapshot } from "./reducer.js";

const baseRun: AgentRun = {
  id: "run-1",
  workItemId: "work-1",
  label: "Primary",
  variant: "primary",
  codexThreadId: null,
  codexTurnId: null,
  cwd: "/tmp/repo",
  model: "gpt-5.4",
  sandboxPolicy: "workspace-write",
  approvalPolicy: "on-request",
  status: "running",
  adapterKind: "simulator",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastEventAt: null,
  branchName: null,
  worktreePath: null,
};

test("deriveSnapshot prioritizes pending approvals", () => {
  const approval: ApprovalRequest = {
    id: "approval-1",
    workItemId: "work-1",
    agentRunId: "run-1",
    codexThreadId: null,
    codexTurnId: null,
    requestId: "request-1",
    itemId: null,
    kind: "command",
    promptSummary: "Needs approval to install dependencies.",
    reason: "Network access required.",
    riskSummary: "May download dependencies from the network.",
    targetSummary: "pnpm install",
    availableDecisions: ["accept", "decline"],
    rawPayload: {},
    status: "pending",
    createdAt: "2026-01-01T00:01:00.000Z",
    resolvedAt: null,
  };

  const snapshot = deriveSnapshot({
    runs: [baseRun],
    approvals: [approval],
    checkpoints: [],
  });

  assert.equal(snapshot.status, "needs_me");
  assert.match(snapshot.summary, /approval/i);
});

test("deriveSnapshot marks ready items correctly", () => {
  const checkpoints: Checkpoint[] = [
    {
      id: "cp-1",
      workItemId: "work-1",
      agentRunId: "run-1",
      type: "ready_for_review",
      summary: "Ready for review: implementation completed.",
      evidence: null,
      rawEventRefs: ["raw-1"],
      createdAt: "2026-01-01T00:05:00.000Z",
    },
  ];

  const snapshot = deriveSnapshot({
    runs: [{ ...baseRun, status: "ready" }],
    approvals: [],
    checkpoints,
  });

  assert.equal(snapshot.status, "ready");
  assert.match(snapshot.summary, /ready/i);
});
