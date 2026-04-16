import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentRun,
  ApprovalRequest,
  ApprovalStatus,
  CheckpointType,
  Checkpoint,
  CreateRepoInput,
  CreateWorkItemInput,
  HealthStatus,
  Repo,
  ResolveApprovalInput,
  RiskLevel,
  Settings,
  WorkItem,
  WorkItemDetail,
  WorkItemArtifacts,
} from "@superman/shared-types";
import { DEFAULT_SETTINGS } from "../domain/defaults.js";
import { seedDescription } from "../domain/prompts.js";

type SqlValue = string | number | null;

function nowIso() {
  return new Date().toISOString();
}

function asJson<T>(value: T) {
  return JSON.stringify(value);
}

function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class SupermanDatabase {
  readonly sqlite: DatabaseSync;

  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.sqlite = new DatabaseSync(path.join(rootDir, "superman.db"));
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  init() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        absolute_path TEXT NOT NULL UNIQUE,
        git_root TEXT NOT NULL,
        default_branch TEXT,
        last_used_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        objective TEXT NOT NULL,
        done_criteria TEXT NOT NULL,
        constraints TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        current_summary TEXT NOT NULL,
        current_blocker TEXT,
        next_human_action TEXT,
        latest_checkpoint_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repos (id)
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        label TEXT NOT NULL,
        variant TEXT NOT NULL,
        codex_thread_id TEXT,
        codex_turn_id TEXT,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_at TEXT,
        branch_name TEXT,
        worktree_path TEXT,
        FOREIGN KEY (work_item_id) REFERENCES work_items (id)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT,
        raw_event_refs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items (id),
        FOREIGN KEY (agent_run_id) REFERENCES agent_runs (id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        codex_thread_id TEXT,
        codex_turn_id TEXT,
        request_id TEXT,
        item_id TEXT,
        kind TEXT NOT NULL,
        prompt_summary TEXT NOT NULL,
        reason TEXT,
        available_decisions TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (work_item_id) REFERENCES work_items (id),
        FOREIGN KEY (agent_run_id) REFERENCES agent_runs (id)
      );

      CREATE TABLE IF NOT EXISTS raw_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        source TEXT NOT NULL,
        method TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoff_exports (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        json_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items (id)
      );
    `);

    const settings = this.getSettings();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (settings[key as keyof Settings] === undefined) {
        this.sqlite
          .prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)")
          .run(key, asJson(value));
      }
    }
  }

  getSettings(): Settings {
    const rows = this.sqlite
      .prepare("SELECT key, value FROM settings")
      .all() as Array<{ key: keyof Settings; value: string }>;
    const next = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      (next[row.key] as unknown) = fromJson(row.value, next[row.key]);
    }
    return next;
  }

  patchSettings(input: Partial<Settings>) {
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      this.sqlite
        .prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)")
        .run(key, asJson(value));
    }
    return this.getSettings();
  }

  insertRepo(result: CreateRepoInput, meta: {
    name: string;
    gitRoot: string;
    defaultBranch: string | null;
  }) {
    const timestamp = nowIso();
    const repo: Repo = {
      id: crypto.randomUUID(),
      name: meta.name,
      absolutePath: result.absolutePath,
      gitRoot: meta.gitRoot,
      defaultBranch: meta.defaultBranch,
      lastUsedAt: timestamp,
      createdAt: timestamp,
    };
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO repos(
          id, name, absolute_path, git_root, default_branch, last_used_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo.id,
        repo.name,
        repo.absolutePath,
        repo.gitRoot,
        repo.defaultBranch,
        repo.lastUsedAt,
        repo.createdAt,
      );
    return repo;
  }

  listRepos(): Repo[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, absolute_path, git_root, default_branch, last_used_at, created_at
         FROM repos
         ORDER BY last_used_at DESC`,
      )
      .all() as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapRepo(row));
  }

  getRepo(id: string) {
    const row = this.sqlite
      .prepare(
        `SELECT id, name, absolute_path, git_root, default_branch, last_used_at, created_at
         FROM repos WHERE id = ?`,
      )
      .get(id) as Record<string, SqlValue> | undefined;
    return row ? this.mapRepo(row) : null;
  }

  insertWorkItem(input: CreateWorkItemInput) {
    const timestamp = nowIso();
    const workItem: WorkItem = {
      id: crypto.randomUUID(),
      repoId: input.repoId,
      title: input.title.trim(),
      description: seedDescription(input),
      objective: input.objective.trim(),
      doneCriteria: input.doneCriteria.trim(),
      constraints: input.constraints?.trim() || null,
      status: "running",
      priority: input.priority,
      riskLevel: input.riskLevel as RiskLevel,
      ownerType: "mixed",
      executionMode: input.executionMode,
      currentSummary: "Queued and waiting to start.",
      currentBlocker: null,
      nextHumanAction: null,
      latestCheckpointId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sqlite
      .prepare(
        `INSERT INTO work_items(
          id, repo_id, title, description, objective, done_criteria, constraints,
          status, priority, risk_level, owner_type, execution_mode, current_summary,
          current_blocker, next_human_action, latest_checkpoint_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workItem.id,
        workItem.repoId,
        workItem.title,
        workItem.description,
        workItem.objective,
        workItem.doneCriteria,
        workItem.constraints,
        workItem.status,
        workItem.priority,
        workItem.riskLevel,
        workItem.ownerType,
        workItem.executionMode,
        workItem.currentSummary,
        workItem.currentBlocker,
        workItem.nextHumanAction,
        workItem.latestCheckpointId,
        workItem.createdAt,
        workItem.updatedAt,
      );
    return workItem;
  }

  updateWorkItemSnapshot(
    workItemId: string,
    input: {
      status: string;
      summary: string;
      blocker: string | null;
      nextHumanAction: string | null;
      latestCheckpointId: string | null;
    },
  ) {
    this.sqlite
      .prepare(
        `UPDATE work_items
         SET status = ?, current_summary = ?, current_blocker = ?, next_human_action = ?,
             latest_checkpoint_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.summary,
        input.blocker,
        input.nextHumanAction,
        input.latestCheckpointId,
        nowIso(),
        workItemId,
      );
  }

  listWorkItems(): WorkItem[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM work_items ORDER BY updated_at DESC")
      .all() as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapWorkItem(row));
  }

  getWorkItem(id: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(id) as Record<string, SqlValue> | undefined;
    return row ? this.mapWorkItem(row) : null;
  }

  insertRun(run: AgentRun) {
    this.sqlite
      .prepare(
        `INSERT INTO agent_runs(
          id, work_item_id, label, variant, codex_thread_id, codex_turn_id, cwd, model,
          sandbox_policy, approval_policy, status, adapter_kind, started_at, updated_at,
          last_event_at, branch_name, worktree_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workItemId,
        run.label,
        run.variant,
        run.codexThreadId,
        run.codexTurnId,
        run.cwd,
        run.model,
        run.sandboxPolicy,
        run.approvalPolicy,
        run.status,
        run.adapterKind,
        run.startedAt,
        run.updatedAt,
        run.lastEventAt,
        run.branchName,
        run.worktreePath,
      );
  }

  listRunsByWorkItem(workItemId: string) {
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM agent_runs WHERE work_item_id = ? ORDER BY started_at ASC",
      )
      .all(workItemId) as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapRun(row));
  }

  listRuns() {
    const rows = this.sqlite
      .prepare("SELECT * FROM agent_runs ORDER BY updated_at DESC")
      .all() as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapRun(row));
  }

  getRun(id: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(id) as Record<string, SqlValue> | undefined;
    return row ? this.mapRun(row) : null;
  }

  getRunByThreadId(threadId: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_runs WHERE codex_thread_id = ?")
      .get(threadId) as Record<string, SqlValue> | undefined;
    return row ? this.mapRun(row) : null;
  }

  updateRun(runId: string, input: Partial<AgentRun>) {
    const current = this.getRun(runId);
    if (!current) return null;
    const next = {
      ...current,
      ...input,
      updatedAt: nowIso(),
    };
    this.sqlite
      .prepare(
        `UPDATE agent_runs
         SET codex_thread_id = ?, codex_turn_id = ?, status = ?, adapter_kind = ?,
             updated_at = ?, last_event_at = ?, branch_name = ?, worktree_path = ?
         WHERE id = ?`,
      )
      .run(
        next.codexThreadId,
        next.codexTurnId,
        next.status,
        next.adapterKind,
        next.updatedAt,
        next.lastEventAt,
        next.branchName,
        next.worktreePath,
        runId,
      );
    return next;
  }

  insertCheckpoint(checkpoint: Checkpoint) {
    this.sqlite
      .prepare(
        `INSERT INTO checkpoints(
          id, work_item_id, agent_run_id, type, summary, evidence, raw_event_refs, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.workItemId,
        checkpoint.agentRunId,
        checkpoint.type,
        checkpoint.summary,
        checkpoint.evidence,
        asJson(checkpoint.rawEventRefs),
        checkpoint.createdAt,
      );
    return checkpoint;
  }

  listCheckpointsByWorkItem(workItemId: string) {
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM checkpoints WHERE work_item_id = ? ORDER BY created_at DESC",
      )
      .all(workItemId) as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapCheckpoint(row));
  }

  listCheckpointsByRun(runId: string) {
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM checkpoints WHERE agent_run_id = ? ORDER BY created_at DESC",
      )
      .all(runId) as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapCheckpoint(row));
  }

  insertApproval(approval: ApprovalRequest) {
    this.sqlite
      .prepare(
        `INSERT INTO approvals(
          id, work_item_id, agent_run_id, codex_thread_id, codex_turn_id, request_id, item_id,
          kind, prompt_summary, reason, available_decisions, raw_payload, status, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.workItemId,
        approval.agentRunId,
        approval.codexThreadId,
        approval.codexTurnId,
        approval.requestId,
        approval.itemId,
        approval.kind,
        approval.promptSummary,
        approval.reason,
        asJson(approval.availableDecisions),
        asJson(approval.rawPayload),
        approval.status,
        approval.createdAt,
        approval.resolvedAt,
      );
    return approval;
  }

  listApprovals(status?: ApprovalStatus) {
    const rows = status
      ? (this.sqlite
          .prepare(
            "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC",
          )
          .all(status) as Array<Record<string, SqlValue>>)
      : (this.sqlite
          .prepare("SELECT * FROM approvals ORDER BY created_at DESC")
          .all() as Array<Record<string, SqlValue>>);
    return rows.map((row) => this.mapApproval(row));
  }

  listApprovalsByWorkItem(workItemId: string) {
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM approvals WHERE work_item_id = ? ORDER BY created_at DESC",
      )
      .all(workItemId) as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapApproval(row));
  }

  listApprovalsByRun(runId: string) {
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM approvals WHERE agent_run_id = ? ORDER BY created_at DESC",
      )
      .all(runId) as Array<Record<string, SqlValue>>;
    return rows.map((row) => this.mapApproval(row));
  }

  getApproval(id: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as Record<string, SqlValue> | undefined;
    return row ? this.mapApproval(row) : null;
  }

  resolveApproval(id: string, input: ResolveApprovalInput) {
    const resolvedAt = nowIso();
    const status = input.decision === "approved" ? "approved" : "rejected";
    this.sqlite
      .prepare(
        "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?",
      )
      .run(status, resolvedAt, id);
    return this.getApproval(id);
  }

  insertRawEvent(event: {
    id: string;
    runId?: string;
    threadId: string;
    turnId?: string;
    itemId?: string;
    source: string;
    method: string;
    payload: unknown;
  }) {
    this.sqlite
      .prepare(
        `INSERT INTO raw_events(
          id, run_id, thread_id, turn_id, item_id, source, method, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId ?? null,
        event.threadId,
        event.turnId ?? null,
        event.itemId ?? null,
        event.source,
        event.method,
        asJson(event.payload),
        nowIso(),
      );
  }

  insertHandoffExport(workItemId: string, markdownPath: string, jsonPath: string) {
    this.sqlite
      .prepare(
        "INSERT INTO handoff_exports(id, work_item_id, markdown_path, json_path, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(crypto.randomUUID(), workItemId, markdownPath, jsonPath, nowIso());
  }

  getWorkItemDetail(id: string): WorkItemDetail | null {
    const workItem = this.getWorkItem(id);
    if (!workItem) return null;
    const repo = this.getRepo(workItem.repoId);
    if (!repo) return null;
    const runs = this.listRunsByWorkItem(id);
    const checkpoints = this.listCheckpointsByWorkItem(id);
    const approvals = this.listApprovalsByWorkItem(id);
    return {
      workItem,
      repo,
      runs,
      checkpoints,
      approvals,
      artifacts: this.buildArtifacts(id, runs, checkpoints),
    };
  }

  getHealthSnapshot(adapterKind: HealthStatus["adapterKind"], codexConnected: boolean) {
    return {
      ok: true,
      adapterKind,
      codexConnected,
      simulatorActive: adapterKind === "simulator",
      message:
        adapterKind === "simulator"
          ? "Simulator mode is active."
          : "Connected to Codex app-server.",
    } satisfies HealthStatus;
  }

  private mapRepo(row: Record<string, SqlValue>): Repo {
    return {
      id: String(row.id),
      name: String(row.name),
      absolutePath: String(row.absolute_path),
      gitRoot: String(row.git_root),
      defaultBranch: row.default_branch ? String(row.default_branch) : null,
      lastUsedAt: String(row.last_used_at),
      createdAt: String(row.created_at),
    };
  }

  private mapWorkItem(row: Record<string, SqlValue>): WorkItem {
    return {
      id: String(row.id),
      repoId: String(row.repo_id),
      title: String(row.title),
      description: String(row.description),
      objective: String(row.objective),
      doneCriteria: String(row.done_criteria),
      constraints: row.constraints ? String(row.constraints) : null,
      status: row.status as WorkItem["status"],
      priority: row.priority as WorkItem["priority"],
      riskLevel: row.risk_level as WorkItem["riskLevel"],
      ownerType: row.owner_type as WorkItem["ownerType"],
      executionMode: row.execution_mode as WorkItem["executionMode"],
      currentSummary: String(row.current_summary),
      currentBlocker: row.current_blocker ? String(row.current_blocker) : null,
      nextHumanAction: row.next_human_action
        ? String(row.next_human_action)
        : null,
      latestCheckpointId: row.latest_checkpoint_id
        ? String(row.latest_checkpoint_id)
        : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapRun(row: Record<string, SqlValue>): AgentRun {
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      label: String(row.label),
      variant: row.variant as AgentRun["variant"],
      codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
      codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
      cwd: String(row.cwd),
      model: String(row.model),
      sandboxPolicy: String(row.sandbox_policy),
      approvalPolicy: String(row.approval_policy),
      status: row.status as AgentRun["status"],
      adapterKind: row.adapter_kind as AgentRun["adapterKind"],
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      lastEventAt: row.last_event_at ? String(row.last_event_at) : null,
      branchName: row.branch_name ? String(row.branch_name) : null,
      worktreePath: row.worktree_path ? String(row.worktree_path) : null,
    };
  }

  private mapCheckpoint(row: Record<string, SqlValue>): Checkpoint {
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      agentRunId: String(row.agent_run_id),
      type: row.type as Checkpoint["type"],
      summary: String(row.summary),
      evidence: row.evidence ? String(row.evidence) : null,
      rawEventRefs: fromJson<string[]>(row.raw_event_refs, []),
      createdAt: String(row.created_at),
    };
  }

  private mapApproval(row: Record<string, SqlValue>): ApprovalRequest {
    const rawPayload = fromJson(row.raw_payload, {});
    return {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      agentRunId: String(row.agent_run_id),
      codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
      codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
      requestId: row.request_id ? String(row.request_id) : null,
      itemId: row.item_id ? String(row.item_id) : null,
      kind: row.kind as ApprovalRequest["kind"],
      promptSummary: String(row.prompt_summary),
      reason: row.reason ? String(row.reason) : null,
      riskSummary:
        typeof (rawPayload as { riskSummary?: unknown }).riskSummary === "string"
          ? String((rawPayload as { riskSummary?: unknown }).riskSummary)
          : null,
      targetSummary:
        typeof (rawPayload as { targetSummary?: unknown }).targetSummary === "string"
          ? String((rawPayload as { targetSummary?: unknown }).targetSummary)
          : null,
      availableDecisions: fromJson<string[]>(row.available_decisions, []),
      rawPayload,
      status: row.status as ApprovalRequest["status"],
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    };
  }

  private buildArtifacts(
    workItemId: string,
    runs: AgentRun[],
    checkpoints: Checkpoint[],
  ): WorkItemArtifacts {
    const runIds = runs.map((run) => run.id);
    const rawRows =
      runIds.length === 0
        ? []
        : (this.sqlite
            .prepare(
              `SELECT method, payload, created_at
               FROM raw_events
               WHERE run_id IN (${runIds.map(() => "?").join(", ")})
               ORDER BY created_at DESC
               LIMIT 20`,
            )
            .all(...runIds) as Array<Record<string, SqlValue>>);

    const changedFiles = new Set<string>();
    const unresolvedIssues = new Set<string>();
    const recentRawMethods: string[] = [];
    let testsStatus: string | null = null;

    for (const checkpoint of checkpoints) {
      const changedFromEvidence = extractChangedFiles(checkpoint.evidence);
      for (const file of changedFromEvidence) changedFiles.add(file);
      const maybeTests = extractTestsStatus(checkpoint.summary, checkpoint.evidence);
      if (!testsStatus && maybeTests) testsStatus = maybeTests;
      if (
        checkpoint.type === "blocked" ||
        checkpoint.type === "error" ||
        checkpoint.summary.toLowerCase().includes("unresolved")
      ) {
        unresolvedIssues.add(checkpoint.summary);
      }
    }

    for (const row of rawRows) {
      const method = String(row.method);
      recentRawMethods.push(method);
      const payload = fromJson<Record<string, unknown>>(row.payload, {});
      for (const file of extractChangedFiles(JSON.stringify(payload))) {
        changedFiles.add(file);
      }
      const maybeTests = extractTestsStatus(
        method,
        JSON.stringify(payload),
      );
      if (!testsStatus && maybeTests) testsStatus = maybeTests;
    }

    return {
      changedFiles: [...changedFiles].slice(0, 20),
      testsStatus,
      unresolvedIssues: [...unresolvedIssues].slice(0, 10),
      branchNames: runs
        .map((run) => run.branchName)
        .filter((value): value is string => Boolean(value)),
      worktreePaths: runs
        .map((run) => run.worktreePath)
        .filter((value): value is string => Boolean(value)),
      recentRawMethods,
    };
  }

  buildArtifactsForRun(runId: string) {
    const run = this.getRun(runId);
    if (!run) {
      return {
        changedFiles: [],
        testsStatus: null,
        unresolvedIssues: [],
        branchNames: [],
        worktreePaths: [],
        recentRawMethods: [],
      } satisfies WorkItemArtifacts;
    }

    return this.buildArtifacts(
      run.workItemId,
      [run],
      this.listCheckpointsByRun(runId),
    );
  }
}

function extractChangedFiles(value: string | null) {
  if (!value) return [];
  const matches = value.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g) ?? [];
  return matches.filter(
    (match) =>
      match.includes("/") &&
      !match.includes("://") &&
      !match.startsWith("//"),
  );
}

function extractTestsStatus(...values: Array<string | null>) {
  for (const value of values) {
    if (!value) continue;
    const lowered = value.toLowerCase();
    if (lowered.includes("test")) {
      return value.length > 180 ? `${value.slice(0, 177)}...` : value;
    }
  }
  return null;
}
