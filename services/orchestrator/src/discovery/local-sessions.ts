import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SessionArtifacts,
  SessionDetail,
  SessionRecord,
  SessionStatus,
  SessionTimelineEntry,
} from "@superman/shared-types";
import { isArchivedSession } from "../domain/sessions.js";

type SessionIndexEntry = {
  id: string;
  thread_name?: string;
  updated_at?: string;
};

type JsonLine = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

const BLOCKED_RE = /\b(blocked|cannot continue|can't continue|ambiguous|need clarification|missing context|stuck)\b/i;
const NEEDS_ME_RE =
  /\b(could you|can you|please provide|need your input|which option|which approach|let me know|share more detail)\b/i;

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function safeRead(filePath: string) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function basename(value: string | null) {
  return value ? path.basename(value) : null;
}

function codexRootDir() {
  return process.env.SUPERMAN_CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function walkSessionFiles(root: string, output: string[] = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(absolutePath, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(absolutePath);
    }
  }
  return output;
}

function sessionIdFromPath(filePath: string) {
  return filePath.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? null;
}

function fileUpdatedAt(filePath: string) {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function extractTextContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return String((part as { text: string }).text);
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function truncate(value: string, length = 180) {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function extractChangedFiles(value: string | null) {
  if (!value) return [];
  const matches = value.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g) ?? [];
  return unique(
    matches.filter(
      (match) =>
        match.includes("/") &&
        !match.includes("://") &&
        !match.startsWith("//"),
    ),
  );
}

function extractTestsStatus(...values: Array<string | null>) {
  for (const value of values) {
    if (!value) continue;
    if (value.toLowerCase().includes("test")) {
      return truncate(value, 140);
    }
  }
  return null;
}

function parseCommand(args: unknown) {
  if (typeof args !== "string") return null;
  const parsed = safeJson<Record<string, unknown>>(args);
  if (!parsed) return args;
  if (Array.isArray(parsed.command)) {
    return parsed.command.map(String).join(" ");
  }
  if (typeof parsed.cmd === "string") {
    return parsed.cmd;
  }
  return args;
}

function deriveStatus(
  updatedAt: string,
  latestAssistant: string | null,
  latestTimelineType: SessionTimelineEntry["type"] | null,
) {
  const assistantText = latestAssistant ?? "";
  if (BLOCKED_RE.test(assistantText)) return "blocked" satisfies SessionStatus;
  if (NEEDS_ME_RE.test(assistantText) || assistantText.includes("?")) {
    return "needs_me" satisfies SessionStatus;
  }

  const updatedMs = Date.parse(updatedAt);
  const isRecent = Number.isFinite(updatedMs) && Date.now() - updatedMs < 10 * 60_000;
  if (latestTimelineType === "tool_call" || latestTimelineType === "reasoning") {
    return "running" satisfies SessionStatus;
  }
  if (isRecent && !latestAssistant) {
    return "running" satisfies SessionStatus;
  }
  if (latestAssistant) {
    return "ready" satisfies SessionStatus;
  }
  return "idle" satisfies SessionStatus;
}

function nextHumanActionFor(status: SessionStatus) {
  switch (status) {
    case "needs_me":
      return "Open the session and answer the latest question or provide the missing context.";
    case "blocked":
      return "Review the blocker and steer the session with the missing decision.";
    case "ready":
      return "Inspect the latest session summary and decide whether to resume or export a handoff.";
    case "running":
      return null;
    case "idle":
      return "Resume the session when you want to continue the thread.";
    default:
      return null;
  }
}

function buildDiscoveredDetail(
  filePath: string,
  indexEntry: SessionIndexEntry,
): SessionDetail | null {
  const raw = safeRead(filePath);
  if (!raw) return null;
  const parsedLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJson<JsonLine>(line))
    .filter((line): line is JsonLine => Boolean(line));

  if (parsedLines.length === 0) return null;

  let cwd: string | null = null;
  let createdAt = indexEntry.updated_at ?? new Date().toISOString();
  let latestUserMessage: string | null = null;
  let latestAssistantMessage: string | null = null;
  const timeline: SessionTimelineEntry[] = [];
  const commandHighlights: string[] = [];
  const recentMessages: string[] = [];
  const changedFiles = new Set<string>();
  const unresolvedIssues = new Set<string>();
  let testsStatus: string | null = null;

  for (const line of parsedLines) {
    const timestamp = line.timestamp ?? createdAt;
    if (line.type === "session_meta") {
      createdAt = timestamp;
      if (typeof line.payload?.cwd === "string") {
        cwd = String(line.payload.cwd);
      }
      continue;
    }

    if (line.type === "event_msg" && line.payload?.type === "user_message") {
      const text =
        typeof line.payload.message === "string" ? String(line.payload.message) : null;
      if (text && !text.includes("<environment_context>")) {
        latestUserMessage = text;
        recentMessages.push(truncate(text, 120));
        timeline.push({
          id: crypto.randomUUID(),
          type: "user_message",
          summary: truncate(text, 180),
          evidence: null,
          createdAt: timestamp,
        });
      }
      continue;
    }

    if (line.type === "event_msg" && line.payload?.type === "agent_message") {
      const text =
        typeof line.payload.message === "string" ? String(line.payload.message) : null;
      if (text) {
        latestAssistantMessage = text;
        recentMessages.push(truncate(text, 120));
        timeline.push({
          id: crypto.randomUUID(),
          type: "assistant_message",
          summary: truncate(text, 180),
          evidence: null,
          createdAt: timestamp,
        });
        if (BLOCKED_RE.test(text)) unresolvedIssues.add(truncate(text, 180));
        const maybeTests = extractTestsStatus(text);
        if (!testsStatus && maybeTests) testsStatus = maybeTests;
        for (const file of extractChangedFiles(text)) changedFiles.add(file);
      }
      continue;
    }

    if (line.type === "event_msg" && line.payload?.type === "agent_reasoning") {
      const text = typeof line.payload.text === "string" ? String(line.payload.text) : null;
      if (text) {
        timeline.push({
          id: crypto.randomUUID(),
          type: "reasoning",
          summary: truncate(text, 180),
          evidence: null,
          createdAt: timestamp,
        });
      }
      continue;
    }

    if (line.type === "response_item" && line.payload?.type === "function_call") {
      const name = typeof line.payload.name === "string" ? String(line.payload.name) : "tool";
      const command = parseCommand(line.payload.arguments);
      const summary = command ? `${name}: ${command}` : name;
      commandHighlights.push(truncate(summary, 180));
      timeline.push({
        id: crypto.randomUUID(),
        type: "tool_call",
        summary: truncate(summary, 180),
        evidence: null,
        createdAt: timestamp,
      });
      for (const file of extractChangedFiles(summary)) changedFiles.add(file);
      continue;
    }

    if (line.type === "response_item" && line.payload?.type === "function_call_output") {
      const output = typeof line.payload.output === "string" ? String(line.payload.output) : null;
      if (output) {
        const summary = truncate(output.replace(/\s+/g, " "), 180);
        timeline.push({
          id: crypto.randomUUID(),
          type: "tool_output",
          summary,
          evidence: null,
          createdAt: timestamp,
        });
        const maybeTests = extractTestsStatus(output);
        if (!testsStatus && maybeTests) testsStatus = maybeTests;
        for (const file of extractChangedFiles(output)) changedFiles.add(file);
      }
      continue;
    }

    if (line.type === "response_item" && line.payload?.type === "message") {
      const role = typeof line.payload.role === "string" ? String(line.payload.role) : null;
      const texts = extractTextContent(line.payload.content);
      if (texts.length === 0) continue;
      const text = texts.join("\n");
      if (role === "user" && !text.includes("<environment_context>")) {
        latestUserMessage = text;
      }
      if (role === "assistant") {
        latestAssistantMessage = text;
      }
    }
  }

  const sortedTimeline = timeline
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12);
  const latestTimelineType = sortedTimeline[0]?.type ?? null;
  const updatedAt = indexEntry.updated_at ?? sortedTimeline[0]?.createdAt ?? createdAt;
  const title =
    indexEntry.thread_name?.trim() ||
    latestUserMessage?.split("\n")[0].trim() ||
    basename(cwd) ||
    "Untitled Codex session";
  const status = deriveStatus(updatedAt, latestAssistantMessage, latestTimelineType);
  const branchName = cwd ? readCurrentBranch(cwd) : null;

  const session: SessionRecord = {
    id: `codex:${indexEntry.id}`,
    threadId: indexEntry.id,
    turnId: null,
    runId: null,
    workItemId: null,
    source: "discovered",
    provider: "codex",
    isArchived: isArchivedSession(updatedAt),
    title: truncate(title, 88),
    objective: latestUserMessage ? truncate(latestUserMessage, 240) : null,
    repoName: basename(cwd),
    repoPath: cwd,
    status,
    summary:
      truncate(
        latestAssistantMessage ??
          latestUserMessage ??
          "Discovered local Codex session.",
        220,
      ),
    blocker: status === "blocked" ? truncate(latestAssistantMessage ?? "Session is blocked.", 180) : null,
    nextHumanAction: nextHumanActionFor(status),
    approvalCount: 0,
    updatedAt,
    createdAt,
    lastEventAt: updatedAt,
    branchName,
    worktreePath: null,
    model: null,
  };

  const artifacts: SessionArtifacts = {
    changedFiles: [...changedFiles].slice(0, 20),
    commandHighlights: unique(commandHighlights).slice(0, 8),
    testsStatus,
    unresolvedIssues: [...unresolvedIssues].slice(0, 8),
    branchName,
    worktreePath: null,
    recentMessages: unique(recentMessages).slice(-4),
  };

  return {
    session,
    repo: null,
    approvals: [],
    insight: {
      source: "fallback",
      generatedAt: new Date().toISOString(),
      headline: session.title,
      overview: session.summary,
      latestUpdate: session.summary,
      nextAction: session.nextHumanAction ?? "Open the session when you want to continue it.",
      changedFilesSummary:
        artifacts.changedFiles.length > 0
          ? `Touched ${artifacts.changedFiles.length} files.`
          : "No code changes captured yet.",
      riskSummary:
        artifacts.unresolvedIssues[0] ??
        artifacts.testsStatus ??
        "No major risk surfaced from the captured session signals.",
    },
    timeline: sortedTimeline,
    artifacts,
    latestUserMessage,
    sourcePath: filePath,
  };
}

function readCurrentBranch(cwd: string) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function discoverLocalSessionDetails(limit = 24) {
  const codexRoot = codexRootDir();
  const indexPath = path.join(codexRoot, "session_index.jsonl");
  const sessionsRoot = path.join(codexRoot, "sessions");
  if (!existsSync(sessionsRoot)) {
    return [];
  }

  const indexEntries = (existsSync(indexPath) ? safeRead(indexPath) : "") ?? "";
  const parsedIndexEntries = indexEntries
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJson<SessionIndexEntry>(line))
    .filter((value): value is SessionIndexEntry => Boolean(value?.id));

  const latestIndexById = new Map<string, SessionIndexEntry>();
  for (const entry of parsedIndexEntries) {
    latestIndexById.set(entry.id, entry);
  }

  const sessionFiles = walkSessionFiles(sessionsRoot)
    .map((filePath) => ({
      filePath,
      sessionId: sessionIdFromPath(filePath),
      updatedAt: fileUpdatedAt(filePath),
    }))
    .filter((entry): entry is { filePath: string; sessionId: string; updatedAt: string } =>
      Boolean(entry.sessionId),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit * 3);

  const uniqueFiles = new Map<string, { filePath: string; sessionId: string; updatedAt: string }>();
  for (const file of sessionFiles) {
    if (!uniqueFiles.has(file.sessionId)) {
      uniqueFiles.set(file.sessionId, file);
    }
  }

  return [...uniqueFiles.values()]
    .map((entry) => {
      const indexEntry = latestIndexById.get(entry.sessionId) ?? {
        id: entry.sessionId,
        updated_at: entry.updatedAt,
      };
      return buildDiscoveredDetail(entry.filePath, indexEntry);
    })
    .filter((value): value is SessionDetail => Boolean(value))
    .sort((left, right) =>
      right.session.updatedAt.localeCompare(left.session.updatedAt),
    )
    .slice(0, limit);
}
