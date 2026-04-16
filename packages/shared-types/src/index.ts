export type WorkItemStatus =
  | "running"
  | "needs_me"
  | "blocked"
  | "ready"
  | "done"
  | "error";

export type SessionStatus = WorkItemStatus | "idle";

export type SessionSource = "supervised" | "discovered";

export type SessionProvider = "codex" | "claude";

export type CheckpointType =
  | "progress"
  | "approval_needed"
  | "blocked"
  | "ready_for_review"
  | "completed"
  | "error";

export type ApprovalKind =
  | "command"
  | "network"
  | "file_change"
  | "tool_input"
  | "permissions";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "needs_me"
  | "blocked"
  | "ready"
  | "completed"
  | "error";

export type ExecutionMode = "single" | "parallel_compare" | "parallel_explore";

export type RunVariant =
  | "primary"
  | "variant_a"
  | "variant_b"
  | "validator"
  | "investigator";

export type OwnerType = "human" | "agent" | "mixed";

export type Priority = "low" | "medium" | "high" | "urgent";

export type RiskLevel = "low" | "medium" | "high";

export interface Repo {
  id: string;
  name: string;
  absolutePath: string;
  gitRoot: string;
  defaultBranch: string | null;
  lastUsedAt: string;
  createdAt: string;
}

export interface WorkItem {
  id: string;
  repoId: string;
  title: string;
  description: string;
  objective: string;
  doneCriteria: string;
  constraints: string | null;
  status: WorkItemStatus;
  priority: Priority;
  riskLevel: RiskLevel;
  ownerType: OwnerType;
  executionMode: ExecutionMode;
  currentSummary: string;
  currentBlocker: string | null;
  nextHumanAction: string | null;
  latestCheckpointId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  workItemId: string;
  label: string;
  variant: RunVariant;
  codexThreadId: string | null;
  codexTurnId: string | null;
  cwd: string;
  model: string;
  sandboxPolicy: string;
  approvalPolicy: string;
  status: RunStatus;
  adapterKind: "codex" | "simulator";
  startedAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  branchName: string | null;
  worktreePath: string | null;
}

export interface Checkpoint {
  id: string;
  workItemId: string;
  agentRunId: string;
  type: CheckpointType;
  summary: string;
  evidence: string | null;
  rawEventRefs: string[];
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  workItemId: string;
  agentRunId: string;
  codexThreadId: string | null;
  codexTurnId: string | null;
  requestId: string | null;
  itemId: string | null;
  kind: ApprovalKind;
  promptSummary: string;
  reason: string | null;
  riskSummary: string | null;
  targetSummary: string | null;
  availableDecisions: string[];
  rawPayload: unknown;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApprovalRisk {
  level: RiskLevel;
  summary: string;
  scope: string | null;
}

export interface WorkItemArtifacts {
  changedFiles: string[];
  testsStatus: string | null;
  unresolvedIssues: string[];
  branchNames: string[];
  worktreePaths: string[];
  recentRawMethods: string[];
}

export interface HandoffBundle {
  workItem: WorkItem;
  repoPath: string;
  currentStatus: WorkItemStatus;
  currentSummary: string;
  goals: string[];
  constraints: string[];
  decisionsMade: string[];
  blockers: string[];
  changedFiles: string[];
  suggestedNextPrompt: string;
  artifactReferences: string[];
  generatedAt: string;
}

export interface SessionRecord {
  id: string;
  threadId: string;
  turnId: string | null;
  runId: string | null;
  workItemId: string | null;
  source: SessionSource;
  provider: SessionProvider;
  isArchived: boolean;
  title: string;
  objective: string | null;
  repoName: string | null;
  repoPath: string | null;
  status: SessionStatus;
  summary: string;
  blocker: string | null;
  nextHumanAction: string | null;
  approvalCount: number;
  updatedAt: string;
  createdAt: string;
  lastEventAt: string | null;
  branchName: string | null;
  worktreePath: string | null;
  model: string | null;
}

export interface SessionInsight {
  source: "ollama" | "fallback";
  generatedAt: string;
  headline: string;
  overview: string;
  latestUpdate: string;
  nextAction: string;
  changedFilesSummary: string | null;
  riskSummary: string | null;
}

export interface SessionArtifacts {
  changedFiles: string[];
  commandHighlights: string[];
  testsStatus: string | null;
  unresolvedIssues: string[];
  branchName: string | null;
  worktreePath: string | null;
  recentMessages: string[];
}

export interface SessionTimelineEntry {
  id: string;
  type:
    | CheckpointType
    | "user_message"
    | "assistant_message"
    | "reasoning"
    | "tool_call"
    | "tool_output";
  summary: string;
  evidence: string | null;
  createdAt: string;
}

export interface SessionDetail {
  session: SessionRecord;
  repo: Repo | null;
  approvals: ApprovalRequest[];
  insight: SessionInsight;
  timeline: SessionTimelineEntry[];
  artifacts: SessionArtifacts;
  latestUserMessage: string | null;
  sourcePath: string | null;
}

export interface QueueEntity {
  id: string;
  title: string;
  repoName: string;
  repoPath: string | null;
  status: SessionStatus;
  summary: string;
  problem: string | null;
  nextHumanAction: string | null;
  sessionCount: number;
  updatedAt: string;
  lastEventAt: string | null;
  continueSessionId: string | null;
  branchName: string | null;
}

export interface QueueInsight {
  source: "ollama" | "fallback";
  generatedAt: string;
  goalSummary: string;
  problemSummary: string | null;
  latestUpdate: string;
  nextAction: string;
}

export interface QueueEntityDetail {
  entity: QueueEntity;
  repo: Repo | null;
  insight: QueueInsight;
  sessions: SessionRecord[];
  continueSession: SessionRecord | null;
  providerLabels: SessionProvider[];
  timeline: SessionTimelineEntry[];
  changedFilesSummary: string | null;
  testsStatus: string | null;
  riskSummary: string | null;
  branchNames: string[];
}

export interface SessionHandoffBundle {
  session: SessionRecord;
  repoPath: string | null;
  currentStatus: SessionStatus;
  currentSummary: string;
  goals: string[];
  blockers: string[];
  changedFiles: string[];
  suggestedNextPrompt: string;
  artifactReferences: string[];
  generatedAt: string;
}

export interface NormalizedEvent {
  id: string;
  source: "codex" | "simulator";
  threadId: string;
  turnId?: string;
  itemId?: string;
  runId?: string;
  method: string;
  timestamp: number;
  payload: unknown;
}

export interface TrayState {
  activeCount: number;
  runningCount: number;
  needsMeCount: number;
  blockedCount: number;
  readyCount: number;
}

export interface Settings {
  defaultModel: string;
  defaultSandboxPolicy: string;
  defaultApprovalPolicy: string;
  defaultNetworkEnabled: boolean;
  defaultParallelRuns: number;
  trayNotificationStyle: "urgent_only" | "all";
  codexEndpoint: string;
  simulatorFallback: boolean;
}

export interface CreateRepoInput {
  absolutePath: string;
}

export interface CreateWorkItemInput {
  repoId: string;
  title: string;
  objective: string;
  doneCriteria: string;
  description?: string;
  constraints?: string;
  priority: Priority;
  riskLevel: RiskLevel;
  executionMode: ExecutionMode;
}

export interface SteerWorkItemInput {
  instruction: string;
}

export interface ResolveApprovalInput {
  decision: "approved" | "rejected";
  responseText?: string;
}

export interface WorkItemDetail {
  workItem: WorkItem;
  repo: Repo;
  runs: AgentRun[];
  checkpoints: Checkpoint[];
  approvals: ApprovalRequest[];
  artifacts: WorkItemArtifacts;
}

export interface RepoValidationResult {
  ok: boolean;
  reason?: string;
  repo?: Omit<Repo, "id" | "createdAt" | "lastUsedAt">;
}

export interface EventEnvelope<TPayload = unknown> {
  type: string;
  payload: TPayload;
}

export interface HealthStatus {
  ok: boolean;
  adapterKind: "codex" | "simulator";
  codexConnected: boolean;
  simulatorActive: boolean;
  message: string;
}
