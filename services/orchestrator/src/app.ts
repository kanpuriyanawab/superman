import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRun,
  ApprovalRequest,
  Checkpoint,
  CreateRepoInput,
  CreateWorkItemInput,
  HealthStatus,
  NormalizedEvent,
  RepoValidationResult,
  QueueEntity,
  QueueEntityDetail,
  ResolveApprovalInput,
  SessionDetail,
  SessionRecord,
  SessionStatus,
  SessionTimelineEntry,
  Settings,
  WorkItemDetail,
} from "@superman/shared-types";
import { buildRunPlan } from "./domain/defaults.js";
import { deriveSnapshot } from "./domain/reducer.js";
import { compareSessions, isArchivedSession } from "./domain/sessions.js";
import { SupermanDatabase } from "./db/database.js";
import { discoverClaudeSessionDetails } from "./discovery/claude-sessions.js";
import { discoverLocalSessionDetails } from "./discovery/local-sessions.js";
import { EventBus } from "./events/bus.js";
import { writeHandoffFiles, writeSessionHandoffFiles } from "./exports/handoff.js";
import { QueueInsightService } from "./summaries/queue-insights.js";
import { SessionInsightService } from "./summaries/session-insights.js";
import { CodexAdapter, type ExecutionAdapter } from "./codex/adapter.js";
import { SimulatorAdapter } from "./simulator/adapter.js";

function nowIso() {
  return new Date().toISOString();
}

function titleForRun(workItemTitle: string, run: AgentRun, runCount: number) {
  return runCount > 1 ? `${workItemTitle} · ${run.label}` : workItemTitle;
}

function codexSessionId(nativeId: string) {
  return `codex:${nativeId}`;
}

function safeGit(args: string[], cwd: string) {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function summarizeApproval(payload: any) {
  if (payload.command) {
    return `Needs approval to run: ${payload.command}`;
  }
  if (payload.questions?.length) {
    return `Needs input on ${payload.questions.length} question${payload.questions.length === 1 ? "" : "s"}.`;
  }
  if (payload.grantRoot) {
    return `Needs approval to expand file write access under ${payload.grantRoot}.`;
  }
  if (payload.reason) {
    return payload.reason as string;
  }
  return "Needs approval before the run can continue.";
}

function summarizeApprovalRisk(payload: Record<string, unknown>) {
  if (payload.networkApprovalContext) {
    return "Requests network access beyond the default offline policy.";
  }
  if (typeof payload.command === "string") {
    const command = payload.command.toLowerCase();
    if (command.includes("install") || command.includes("add ")) {
      return "May change local dependencies or download remote packages.";
    }
    if (command.includes("git")) {
      return "Can mutate repository state or inspect external refs.";
    }
    return "Executes a shell command inside the connected repository.";
  }
  if (typeof payload.grantRoot === "string") {
    return "Expands the writable file scope for the active session.";
  }
  if (Array.isArray(payload.questions)) {
    return "Blocks execution until a human answers the requested tool input.";
  }
  return "Requires a human review before the run can continue.";
}

function summarizeApprovalTarget(payload: Record<string, unknown>) {
  if (typeof payload.cwd === "string") {
    return payload.cwd;
  }
  if (typeof payload.grantRoot === "string") {
    return payload.grantRoot;
  }
  if (typeof payload.command === "string") {
    return payload.command;
  }
  return null;
}

function summarizeCompletion(payload: Record<string, unknown>) {
  const summary = typeof payload.summary === "string" ? payload.summary : null;
  if (summary) return summary;
  const turnStatus =
    typeof payload.turn === "object" &&
    payload.turn !== null &&
    typeof (payload.turn as { status?: unknown }).status === "string"
      ? String((payload.turn as { status: string }).status)
      : null;
  if (turnStatus === "failed" || turnStatus === "cancelled") {
    return "Blocked: the turn did not complete successfully.";
  }
  return "Ready for review: the run completed without pending approvals.";
}

function buildCheckpointEvidence(payload: Record<string, unknown>) {
  const fragments: string[] = [];
  const delta = typeof payload.delta === "string" ? payload.delta : null;
  if (delta) fragments.push(delta);
  const command = typeof payload.command === "string" ? payload.command : null;
  if (command) fragments.push(`command: ${command}`);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  if (cwd) fragments.push(`cwd: ${cwd}`);
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  if (reason) fragments.push(`reason: ${reason}`);
  if (Array.isArray(payload.questions)) {
    const prompts = payload.questions
      .map((question) =>
        typeof question === "object" &&
        question !== null &&
        typeof (question as { question?: unknown }).question === "string"
          ? String((question as { question: string }).question)
          : null,
      )
      .filter((value): value is string => Boolean(value));
    fragments.push(...prompts);
  }
  return fragments.length > 0 ? fragments.join("\n") : JSON.stringify(payload, null, 2);
}

function mapApprovalKind(method: string, payload: any): ApprovalRequest["kind"] {
  if (method.includes("fileChange")) return "file_change";
  if (method.includes("permissions")) return "permissions";
  if (method.includes("tool/requestUserInput")) return "tool_input";
  if (payload.networkApprovalContext) return "network";
  return "command";
}

export class SupermanApp {
  readonly bus = new EventBus();
  readonly db: SupermanDatabase;
  private adapter: ExecutionAdapter | null = null;
  private readonly insightService: SessionInsightService;
  private readonly queueInsightService: QueueInsightService;

  constructor(
    private readonly rootDir =
      process.env.SUPERMAN_HOME ?? path.join(os.homedir(), ".superman"),
  ) {
    this.db = new SupermanDatabase(rootDir);
    this.insightService = new SessionInsightService(rootDir);
    this.queueInsightService = new QueueInsightService(rootDir);
  }

  async start() {
    this.db.init();
    this.adapter = await this.buildAdapter();
    this.adapter.onEvent((event) => {
      void this.handleEvent(event);
    });
    this.broadcastRefreshes();
    void this.warmSessionInsights();
    void this.warmQueueInsights();
  }

  async shutdown() {
    return;
  }

  getHealth(): HealthStatus {
    return (
      this.adapter?.getHealth() ?? {
        ok: false,
        adapterKind: "simulator",
        codexConnected: false,
        simulatorActive: true,
        message: "Superman has not finished starting yet.",
      }
    );
  }

  getSettings() {
    return this.db.getSettings();
  }

  patchSettings(input: Partial<Settings>) {
    const settings = this.db.patchSettings(input);
    this.bus.broadcast("settings.updated", settings);
    return settings;
  }

  validateRepo(input: CreateRepoInput): RepoValidationResult {
    if (!existsSync(input.absolutePath)) {
      return { ok: false, reason: "The selected folder does not exist." };
    }
    const gitRoot = safeGit(["rev-parse", "--show-toplevel"], input.absolutePath);
    if (!gitRoot) {
      return { ok: false, reason: "The selected folder is not a git repository." };
    }
    const defaultBranch =
      safeGit(["symbolic-ref", "refs/remotes/origin/HEAD"], gitRoot)?.split("/")
        .pop() ?? null;
    return {
      ok: true,
      repo: {
        name: path.basename(gitRoot),
        absolutePath: input.absolutePath,
        gitRoot,
        defaultBranch,
      },
    };
  }

  createRepo(input: CreateRepoInput) {
    const result = this.validateRepo(input);
    if (!result.ok || !result.repo) {
      throw new Error(result.reason ?? "Invalid repo.");
    }
    const repo = this.db.insertRepo(input, {
      name: result.repo.name,
      gitRoot: result.repo.gitRoot,
      defaultBranch: result.repo.defaultBranch,
    });
    this.broadcastRefreshes();
    return repo;
  }

  listRepos() {
    return this.db.listRepos();
  }

  listWorkItems() {
    return this.db.listWorkItems();
  }

  getWorkItemDetail(workItemId: string): WorkItemDetail | null {
    return this.db.getWorkItemDetail(workItemId);
  }

  listApprovals() {
    return this.db.listApprovals("pending");
  }

  listSessions() {
    const runs = this.db.listRuns();
    const repos = this.db.listRepos();
    const supervised: SessionRecord[] = runs.flatMap((run) => {
      const session = this.buildSupervisedSession(run, repos);
      return session ? [session] : [];
    });
    const supervisedThreadIds = new Set(
      supervised.map((session) => session.threadId).filter(Boolean),
    );
    const discoveredCodex = discoverLocalSessionDetails()
      .map((detail) => detail.session)
      .filter((session) => !supervisedThreadIds.has(session.threadId));
    const discoveredClaude = discoverClaudeSessionDetails().map(
      (detail) => detail.session,
    );

    return [...supervised, ...discoveredCodex, ...discoveredClaude]
      .sort(compareSessions)
      .map((session) => this.insightService.decorateSession(session));
  }

  listQueueEntities() {
    const groups = this.collectQueueGroups();
    return groups.map((group) =>
      this.queueInsightService.decorateEntity(group.entity, group.details),
    );
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    let detail: SessionDetail | null = null;
    if (sessionId.startsWith("claude:")) {
      detail =
        discoverClaudeSessionDetails().find((detail) => detail.session.id === sessionId) ??
        null;
      return detail ? this.insightService.enrich(detail) : null;
    }

    const nativeSessionId = sessionId.startsWith("codex:")
      ? sessionId.slice("codex:".length)
      : sessionId;
    const run =
      this.db.listRuns().find(
        (candidate) =>
          candidate.id === nativeSessionId || candidate.codexThreadId === nativeSessionId,
      ) ?? null;
    if (run) {
      detail = this.buildSupervisedSessionDetail(run.id);
      return detail ? this.insightService.enrich(detail) : null;
    }

    detail =
      discoverLocalSessionDetails().find((detail) => detail.session.id === sessionId) ??
      null;
    return detail ? this.insightService.enrich(detail) : null;
  }

  async getQueueEntityDetail(entityId: string): Promise<QueueEntityDetail | null> {
    const group = this.collectQueueGroups().find((item) => item.entity.id === entityId) ?? null;
    if (!group) {
      return null;
    }

    const continueDetail = group.details[0] ?? null;
    const continueSession = continueDetail?.session ?? null;
    const branchNames = [...new Set(group.details.map((detail) => detail.session.branchName).filter(Boolean))] as string[];
    const riskSummary =
      continueDetail?.session.blocker ??
      group.details.flatMap((detail) => detail.artifacts.unresolvedIssues)[0] ??
      null;
    const detail: QueueEntityDetail = {
      entity: group.entity,
      repo:
        this.db
          .listRepos()
          .find(
            (repo) =>
              repo.absolutePath === group.entity.repoPath ||
              repo.gitRoot === group.entity.repoPath ||
              repo.name === group.entity.repoName,
          ) ?? null,
      insight: {
        source: "fallback",
        generatedAt: nowIso(),
        goalSummary: group.entity.summary,
        problemSummary: group.entity.problem,
        latestUpdate:
          continueDetail?.insight.latestUpdate ??
          continueDetail?.session.summary ??
          "No meaningful update has been captured yet.",
        nextAction:
          group.entity.nextHumanAction ??
          continueDetail?.session.nextHumanAction ??
          "Resume the most recent session when you want to continue the work.",
      },
      sessions: group.details.map((detail) => this.insightService.decorateSession(detail.session)),
      continueSession,
      providerLabels: [...new Set(group.details.map((detail) => detail.session.provider))],
      timeline: continueDetail?.timeline ?? [],
      changedFilesSummary: summarizeChangedFilesAcrossDetails(group.details),
      testsStatus:
        group.details.map((detail) => detail.artifacts.testsStatus).find(Boolean) ?? null,
      riskSummary,
      branchNames,
    };
    return this.queueInsightService.enrich(detail, group.details);
  }

  discoverSessions() {
    const sessions = this.listSessions();
    void this.warmSessionInsights();
    void this.warmQueueInsights();
    this.broadcastRefreshes();
    return sessions;
  }

  async steerSession(sessionId: string, instruction: string) {
    const detail = await this.getSessionDetail(sessionId);
    if (!detail) {
      throw new Error("Session not found.");
    }

    if (detail.session.provider === "claude") {
      throw new Error(
        "Claude Code sessions are currently read-only in Superman. Resume them in Claude Code directly.",
      );
    }

    if (detail.session.runId) {
      return this.steerWorkItem(detail.session.workItemId!, instruction);
    }

    if (!detail.session.threadId || !detail.session.repoPath) {
      throw new Error("This discovered session cannot be resumed automatically.");
    }

    const adapter = this.requireAdapter();
    const settings = this.db.getSettings();
    const externalRun: AgentRun = {
      id: `external-${detail.session.threadId}`,
      workItemId: "external",
      label: "External session",
      variant: "primary",
      codexThreadId: detail.session.threadId,
      codexTurnId: detail.session.turnId,
      cwd: detail.session.repoPath,
      model: detail.session.model ?? settings.defaultModel,
      sandboxPolicy: settings.defaultSandboxPolicy,
      approvalPolicy: settings.defaultApprovalPolicy,
      status: "running",
      adapterKind: adapter.kind,
      startedAt: detail.session.createdAt,
      updatedAt: nowIso(),
      lastEventAt: detail.session.lastEventAt,
      branchName: detail.session.branchName,
      worktreePath: detail.session.worktreePath,
    };
    await adapter.steerRun(externalRun, instruction);
    return this.getSessionDetail(sessionId);
  }

  async exportSession(sessionId: string) {
    const detail = await this.getSessionDetail(sessionId);
    if (!detail) {
      throw new Error("Session not found.");
    }
    return writeSessionHandoffFiles(this.rootDir, detail);
  }

  async createWorkItem(input: CreateWorkItemInput) {
    const repo = this.db.getRepo(input.repoId);
    if (!repo) {
      throw new Error("Repo not found.");
    }
    const adapter = this.requireAdapter();
    const settings = this.db.getSettings();
    const workItem = this.db.insertWorkItem(input);
    for (const plan of buildRunPlan(input.executionMode)) {
      const startedAt = nowIso();
      const run: AgentRun = {
        id: crypto.randomUUID(),
        workItemId: workItem.id,
        label: plan.label,
        variant: plan.variant,
        codexThreadId: null,
        codexTurnId: null,
        cwd: repo.absolutePath,
        model: settings.defaultModel,
        sandboxPolicy: settings.defaultSandboxPolicy,
        approvalPolicy: settings.defaultApprovalPolicy,
        status: "starting",
        adapterKind: adapter.kind,
        startedAt,
        updatedAt: startedAt,
        lastEventAt: null,
        branchName: repo.defaultBranch,
        worktreePath: null,
      };
      this.db.insertRun(run);
      const connection = await adapter.createRun({
        repo,
        run,
        settings,
        workItem,
      });
      this.db.updateRun(run.id, {
        codexThreadId: connection.threadId,
        codexTurnId: connection.turnId,
        status: "running",
        lastEventAt: nowIso(),
      });
    }
    await this.recomputeWorkItem(workItem.id);
    this.broadcastRefreshes();
    return this.getWorkItemDetail(workItem.id);
  }

  async steerWorkItem(workItemId: string, instruction: string) {
    const detail = this.db.getWorkItemDetail(workItemId);
    if (!detail) {
      throw new Error("Work item not found.");
    }
    const adapter = this.requireAdapter();
    const run =
      detail.runs.find((candidate: AgentRun) =>
        ["running", "needs_me", "blocked"].includes(candidate.status),
      ) ?? detail.runs[0];
    if (!run) {
      throw new Error("No run available to steer.");
    }
    await adapter.steerRun(run, instruction);
    this.db.insertCheckpoint({
      id: crypto.randomUUID(),
      workItemId,
      agentRunId: run.id,
      type: "progress",
      summary: `Human steer: ${instruction}`,
      evidence: null,
      rawEventRefs: [],
      createdAt: nowIso(),
    });
    this.db.updateRun(run.id, {
      status: "running",
      lastEventAt: nowIso(),
    });
    await this.recomputeWorkItem(workItemId);
    this.broadcastRefreshes();
    return this.db.getWorkItemDetail(workItemId);
  }

  async resolveApproval(approvalId: string, input: ResolveApprovalInput) {
    const approval = this.db.getApproval(approvalId);
    if (!approval) {
      throw new Error("Approval not found.");
    }
    await this.requireAdapter().resolveApproval(approval, input);
    this.db.resolveApproval(approvalId, input);
    await this.recomputeWorkItem(approval.workItemId);
    this.broadcastRefreshes();
    return this.db.getApproval(approvalId);
  }

  async exportWorkItem(workItemId: string) {
    const detail = this.db.getWorkItemDetail(workItemId);
    if (!detail) {
      throw new Error("Work item not found.");
    }
    const output = writeHandoffFiles(this.rootDir, detail);
    this.db.insertHandoffExport(workItemId, output.markdownPath, output.jsonPath);
    return output;
  }

  private buildSupervisedSession(
    run: AgentRun,
    repos = this.db.listRepos(),
  ): SessionRecord | null {
    const workItem = this.db.getWorkItem(run.workItemId);
    if (!workItem) return null;
    const repo = repos.find((candidate) => candidate.id === workItem.repoId) ?? null;
    const approvals = this.db.listApprovalsByRun(run.id);
    const checkpoints = this.db.listCheckpointsByRun(run.id);
    const snapshot = deriveSnapshot({
      runs: [run],
      approvals,
      checkpoints,
    });
    const relatedRuns = this.db.listRunsByWorkItem(workItem.id);
    return {
      id: codexSessionId(run.codexThreadId ?? run.id),
      threadId: run.codexThreadId ?? run.id,
      turnId: run.codexTurnId,
      runId: run.id,
      workItemId: workItem.id,
      source: "supervised",
      provider: "codex",
      isArchived: isArchivedSession(run.lastEventAt ?? run.updatedAt),
      title: titleForRun(workItem.title, run, relatedRuns.length),
      objective: workItem.objective,
      repoName: repo?.name ?? path.basename(run.cwd),
      repoPath: repo?.absolutePath ?? run.cwd,
      status: snapshot.status as SessionStatus,
      summary: snapshot.summary,
      blocker: snapshot.blocker,
      nextHumanAction: snapshot.nextHumanAction,
      approvalCount: approvals.filter((approval) => approval.status === "pending").length,
      updatedAt: run.updatedAt,
      createdAt: run.startedAt,
      lastEventAt: run.lastEventAt,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      model: run.model,
    } satisfies SessionRecord;
  }

  private buildSupervisedSessionDetail(runId: string): SessionDetail | null {
    const run = this.db.getRun(runId);
    if (!run) return null;
    const workItem = this.db.getWorkItem(run.workItemId);
    if (!workItem) return null;
    const repo = this.db.getRepo(workItem.repoId);
    const session = this.buildSupervisedSession(run, repo ? [repo] : []);
    if (!session) return null;
    const approvals = this.db.listApprovalsByRun(run.id);
    const checkpoints = this.db.listCheckpointsByRun(run.id);
    const artifacts = this.db.buildArtifactsForRun(run.id);
    const timeline: SessionTimelineEntry[] = checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      type: checkpoint.type,
      summary: checkpoint.summary,
      evidence: checkpoint.evidence,
      createdAt: checkpoint.createdAt,
    }));

    return {
      session,
      repo,
      approvals,
      insight: {
        source: "fallback",
        generatedAt: nowIso(),
        headline: session.title,
        overview: session.summary,
        latestUpdate: checkpoints[0]?.summary ?? session.summary,
        nextAction: session.nextHumanAction ?? "Open the session when you want to continue it.",
        changedFilesSummary:
          artifacts.changedFiles.length > 0
            ? `Touched ${artifacts.changedFiles.length} files.`
            : "No code changes captured yet.",
        riskSummary:
          session.blocker ??
          artifacts.unresolvedIssues[0] ??
          artifacts.testsStatus ??
          "No major risk surfaced from the captured session signals.",
      },
      timeline,
      artifacts: {
        changedFiles: artifacts.changedFiles,
        commandHighlights: artifacts.recentRawMethods,
        testsStatus: artifacts.testsStatus,
        unresolvedIssues: artifacts.unresolvedIssues,
        branchName: artifacts.branchNames[0] ?? run.branchName,
        worktreePath: artifacts.worktreePaths[0] ?? run.worktreePath,
        recentMessages: checkpoints.slice(0, 4).map((checkpoint) => checkpoint.summary),
      },
      latestUserMessage: workItem.objective,
      sourcePath: null,
    };
  }

  private async buildAdapter() {
    const settings = this.db.getSettings();
    if (process.env.SUPERMAN_FORCE_SIMULATOR === "1") {
      const simulator = new SimulatorAdapter();
      await simulator.start();
      return simulator;
    }
    const codex = new CodexAdapter(settings);
    try {
      await codex.start();
      return codex;
    } catch (error) {
      if (!settings.simulatorFallback) {
        throw error;
      }
      const simulator = new SimulatorAdapter();
      await simulator.start();
      return simulator;
    }
  }

  private requireAdapter() {
    if (!this.adapter) {
      throw new Error("Adapter is not initialized yet.");
    }
    return this.adapter;
  }

  private async handleEvent(event: NormalizedEvent) {
    const run =
      event.runId != null
        ? this.db.getRun(event.runId)
        : this.db.getRunByThreadId(event.threadId);
    if (!run) {
      return;
    }

    this.db.insertRawEvent({
      id: event.id,
      runId: run.id,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      source: event.source,
      method: event.method,
      payload: event.payload,
    });

    const lastEventAt = nowIso();
    switch (event.method) {
      case "thread/started":
        this.db.updateRun(run.id, {
          codexThreadId: event.threadId,
          status: "starting",
          lastEventAt,
        });
        break;
      case "turn/started":
        this.db.updateRun(run.id, {
          codexTurnId:
            (event.payload as { turn?: { id?: string } }).turn?.id ??
            event.turnId ??
            run.codexTurnId,
          status: "running",
          lastEventAt,
        });
        break;
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        this.db.updateRun(run.id, {
          status: "running",
          lastEventAt,
        });
        this.db.insertCheckpoint({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          type: "progress",
          summary:
            (event.payload as { delta?: string; summary?: string }).summary ??
            (event.payload as { delta?: string }).delta ??
            `Progress update from ${event.method}.`,
          evidence: buildCheckpointEvidence(
            event.payload as Record<string, unknown>,
          ),
          rawEventRefs: [event.id],
          createdAt: lastEventAt,
        });
        break;
      case "item/completed":
      case "rawResponseItem/completed":
        this.db.updateRun(run.id, {
          status: "running",
          lastEventAt,
        });
        this.db.insertCheckpoint({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          type: "progress",
          summary: `Completed item for ${event.method}.`,
          evidence: buildCheckpointEvidence(
            event.payload as Record<string, unknown>,
          ),
          rawEventRefs: [event.id],
          createdAt: lastEventAt,
        });
        break;
      case "turn/completed": {
        const payload = event.payload as Record<string, unknown>;
        const summary = summarizeCompletion(payload);
        const isBlocked = summary.toLowerCase().startsWith("blocked");
        this.db.updateRun(run.id, {
          status: isBlocked ? "blocked" : "completed",
          lastEventAt,
        });
        this.db.insertCheckpoint({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          type: isBlocked ? "blocked" : "completed",
          summary,
          evidence: buildCheckpointEvidence(payload),
          rawEventRefs: [event.id],
          createdAt: lastEventAt,
        });
        break;
      }
      case "error":
        this.db.updateRun(run.id, {
          status: "blocked",
          lastEventAt,
        });
        this.db.insertCheckpoint({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          type: "blocked",
          summary:
            (event.payload as { summary?: string }).summary ??
            "Blocked due to an execution error.",
          evidence: JSON.stringify(event.payload, null, 2),
          rawEventRefs: [event.id],
          createdAt: lastEventAt,
        });
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/tool/requestUserInput":
      case "item/permissions/requestApproval": {
        this.db.updateRun(run.id, {
          status: "needs_me",
          lastEventAt,
        });
        const payload = event.payload as Record<string, unknown>;
        const approval = this.db.insertApproval({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          codexThreadId: event.threadId,
          codexTurnId: event.turnId ?? run.codexTurnId,
          requestId:
            typeof payload.requestId === "string"
              ? payload.requestId
              : event.id,
          itemId: typeof payload.itemId === "string" ? payload.itemId : null,
          kind: mapApprovalKind(event.method, payload),
          promptSummary: summarizeApproval(payload),
          reason:
            typeof payload.reason === "string" ? payload.reason : null,
          riskSummary: summarizeApprovalRisk(payload),
          targetSummary: summarizeApprovalTarget(payload),
          availableDecisions: Array.isArray(payload.availableDecisions)
            ? payload.availableDecisions.map(String)
            : ["accept", "decline"],
          rawPayload: {
            ...payload,
            riskSummary: summarizeApprovalRisk(payload),
            targetSummary: summarizeApprovalTarget(payload),
          },
          status: "pending",
          createdAt: lastEventAt,
          resolvedAt: null,
        });
        this.db.insertCheckpoint({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          type: "approval_needed",
          summary: approval.promptSummary,
          evidence: buildCheckpointEvidence(payload),
          rawEventRefs: [event.id],
          createdAt: lastEventAt,
        });
        break;
      }
      case "serverRequest/resolved":
        this.db.updateRun(run.id, {
          status: "running",
          lastEventAt,
        });
        this.db.insertCheckpoint({
          id: crypto.randomUUID(),
          workItemId: run.workItemId,
          agentRunId: run.id,
          type: "progress",
          summary: "Approval resolved and the run can continue.",
          evidence: buildCheckpointEvidence(
            event.payload as Record<string, unknown>,
          ),
          rawEventRefs: [event.id],
          createdAt: lastEventAt,
        });
        break;
      default:
        this.db.updateRun(run.id, {
          lastEventAt,
        });
    }

    await this.recomputeWorkItem(run.workItemId);
    this.broadcastRefreshes();
  }

  private async recomputeWorkItem(workItemId: string) {
    const detail = this.db.getWorkItemDetail(workItemId);
    if (!detail) return;
    const snapshot = deriveSnapshot({
      runs: detail.runs,
      approvals: detail.approvals,
      checkpoints: detail.checkpoints,
    });
    this.db.updateWorkItemSnapshot(workItemId, {
      status: snapshot.status,
      summary: snapshot.summary,
      blocker: snapshot.blocker,
      nextHumanAction: snapshot.nextHumanAction,
      latestCheckpointId: snapshot.latestCheckpointId,
    });
  }

  private broadcastRefreshes() {
    const sessions = this.listSessions();
    const queue = this.listQueueEntities();
    const mainSessions = sessions.filter((session) => !session.isArchived);
    this.bus.broadcast("work-items.updated", this.db.listWorkItems());
    this.bus.broadcast("sessions.updated", sessions);
    this.bus.broadcast("queue.updated", queue);
    this.bus.broadcast("approvals.updated", this.db.listApprovals("pending"));
    this.bus.broadcast("repos.updated", this.db.listRepos());
    this.bus.broadcast("health.updated", this.getHealth());
    this.bus.broadcast("tray.updated", {
      activeCount: mainSessions.filter(
        (session) => !["done", "idle"].includes(session.status),
      ).length,
      runningCount: mainSessions.filter((session) => session.status === "running").length,
      needsMeCount: mainSessions.filter((session) => session.status === "needs_me").length,
      blockedCount: mainSessions.filter((session) => session.status === "blocked").length,
      readyCount: mainSessions.filter((session) => session.status === "ready").length,
    });
  }

  private collectSessionDetails() {
    const runs = this.db.listRuns();
    const supervised = runs
      .map((run) => this.buildSupervisedSessionDetail(run.id))
      .filter((detail): detail is SessionDetail => Boolean(detail));
    const supervisedThreadIds = new Set(
      supervised.map((detail) => detail.session.threadId).filter(Boolean),
    );
    const discoveredCodex = discoverLocalSessionDetails().filter(
      (detail) => !supervisedThreadIds.has(detail.session.threadId),
    );
    const discoveredClaude = discoverClaudeSessionDetails();
    return [...supervised, ...discoveredCodex, ...discoveredClaude].sort((left, right) =>
      compareSessions(left.session, right.session),
    );
  }

  private async warmSessionInsights() {
    await this.insightService.warm(this.collectSessionDetails(), 32);
    this.bus.broadcast("sessions.updated", this.listSessions());
  }

  private async warmQueueInsights() {
    await this.queueInsightService.warm(this.collectQueueGroups(), 20);
    this.bus.broadcast("queue.updated", this.listQueueEntities());
  }

  private collectQueueGroups() {
    const details = this.collectSessionDetails().filter((detail) => !detail.session.isArchived);
    const groups = new Map<
      string,
      {
        entity: QueueEntity;
        details: SessionDetail[];
      }
    >();

    for (const detail of details) {
      const repoPath = detail.session.repoPath ?? null;
      const repoName =
        detail.session.repoName ??
        (repoPath ? path.basename(repoPath) : "Unknown project");
      const key = repoPath ?? repoName;
      const id = `queue:${Buffer.from(key).toString("base64url")}`;
      const existing = groups.get(id);
      if (existing) {
        existing.details.push(detail);
        continue;
      }
      groups.set(id, {
        entity: {
          id,
          title: repoName,
          repoName,
          repoPath,
          status: detail.session.status,
          summary: detail.session.summary,
          problem: detail.session.blocker,
          nextHumanAction: detail.session.nextHumanAction,
          sessionCount: 0,
          updatedAt: detail.session.updatedAt,
          lastEventAt: detail.session.lastEventAt,
          continueSessionId: detail.session.id,
          branchName: detail.session.branchName,
        },
        details: [detail],
      });
    }

    return [...groups.values()]
      .map((group) => {
        group.details.sort((left, right) => compareSessions(left.session, right.session));
        const top = group.details[0]!;
        group.entity = {
          ...group.entity,
          status: top.session.status,
          summary: top.insight?.overview ?? top.session.summary,
          problem:
            top.session.blocker ??
            top.artifacts.unresolvedIssues[0] ??
            null,
          nextHumanAction:
            top.insight?.nextAction ??
            top.session.nextHumanAction,
          sessionCount: group.details.length,
          updatedAt: top.session.updatedAt,
          lastEventAt: top.session.lastEventAt,
          continueSessionId: top.session.id,
          branchName: top.session.branchName,
        };
        return group;
      })
      .sort((left, right) =>
        compareSessions(left.details[0]!.session, right.details[0]!.session),
      );
  }
}

function summarizeChangedFilesAcrossDetails(details: SessionDetail[]) {
  const files = [...new Set(details.flatMap((detail) => detail.artifacts.changedFiles))];
  if (files.length === 0) {
    return null;
  }
  const sample = files.slice(0, 4).join(", ");
  const extra = files.length - Math.min(files.length, 4);
  return extra > 0
    ? `Touches ${files.length} files, including ${sample}, plus ${extra} more.`
    : `Touches ${files.length} file${files.length === 1 ? "" : "s"}: ${sample}.`;
}
