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

type ClaudeActiveSession = {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  kind?: string;
  entrypoint?: string;
};

type ClaudeLine = {
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  uuid?: string;
  isMeta?: boolean;
  error?: string;
  isApiErrorMessage?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
  attachment?: {
    type?: string;
    content?: string;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
  };
};

const BLOCKED_RE =
  /\b(blocked|cannot continue|can't continue|ambiguous|need clarification|missing context|authentication failed|api error)\b/i;
const NEEDS_ME_RE =
  /\b(could you|can you|please provide|need your input|which option|which approach|let me know|share more detail)\b/i;

function claudeRootDir() {
  return process.env.SUPERMAN_CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
}

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

function truncate(value: string, length = 180) {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function walkFiles(root: string, output: string[] = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolutePath, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(absolutePath);
    }
  }
  return output;
}

function fileUpdatedAt(filePath: string) {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function activeClaudeSessions() {
  const sessionsRoot = path.join(claudeRootDir(), "sessions");
  if (!existsSync(sessionsRoot)) return new Map<string, ClaudeActiveSession>();
  const sessions = new Map<string, ClaudeActiveSession>();
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const payload = safeJson<ClaudeActiveSession>(
      safeRead(path.join(sessionsRoot, entry.name)) ?? "",
    );
    if (payload?.sessionId) {
      sessions.set(payload.sessionId, payload);
    }
  }
  return sessions;
}

function extractTextSegments(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        typeof part === "object" &&
        part !== null &&
        typeof (part as { type?: unknown }).type === "string"
      ) {
        const candidate = part as { type: string; text?: unknown };
        if (candidate.type === "text" && typeof candidate.text === "string") {
          return candidate.text;
        }
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function extractMeaningfulText(content: unknown) {
  return extractTextSegments(content)
    .map((text) => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .filter((text) => !text.startsWith("command-message"))
    .filter((text) => !text.startsWith("command-name"))
    .filter((text) => !text.includes("local-command-caveat"));
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

function deriveStatus(
  updatedAt: string,
  latestAssistant: string | null,
  latestTimelineType: SessionTimelineEntry["type"] | null,
  isActive: boolean,
  sawApiError: boolean,
) {
  const assistantText = latestAssistant ?? "";
  if (BLOCKED_RE.test(assistantText) || sawApiError) {
    return "blocked" satisfies SessionStatus;
  }
  if (NEEDS_ME_RE.test(assistantText) || assistantText.includes("?")) {
    return "needs_me" satisfies SessionStatus;
  }
  if (isActive) {
    return "running" satisfies SessionStatus;
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
      return "Open the Claude Code session and answer the latest question or provide the missing context.";
    case "blocked":
      return "Review the Claude Code blocker and continue the session there.";
    case "ready":
      return "Inspect the latest Claude Code summary and decide whether to resume or export a handoff.";
    case "idle":
      return "Resume the Claude Code session when you want to continue the thread.";
    default:
      return null;
  }
}

function buildClaudeDetail(
  filePath: string,
  activeSessions: Map<string, ClaudeActiveSession>,
): SessionDetail | null {
  const raw = safeRead(filePath);
  if (!raw) return null;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJson<ClaudeLine>(line))
    .filter((line): line is ClaudeLine => Boolean(line));
  if (lines.length === 0) return null;

  const sessionId =
    lines.find((line) => typeof line.sessionId === "string")?.sessionId ??
    path.basename(filePath, ".jsonl");
  const active = activeSessions.get(sessionId) ?? null;
  let cwd: string | null = active?.cwd ?? null;
  let branchName: string | null = null;
  let createdAt = lines[0]?.timestamp ?? fileUpdatedAt(filePath);
  let latestUserMessage: string | null = null;
  let latestAssistantMessage: string | null = null;
  let sawApiError = false;
  const timeline: SessionTimelineEntry[] = [];
  const commandHighlights: string[] = [];
  const changedFiles = new Set<string>();
  const unresolvedIssues = new Set<string>();
  const recentMessages: string[] = [];
  let testsStatus: string | null = null;

  for (const line of lines) {
    const timestamp = line.timestamp ?? createdAt;
    if (line.cwd) cwd = line.cwd;
    if (line.gitBranch) branchName = line.gitBranch;

    if (line.type === "user") {
      const texts = extractMeaningfulText(line.message?.content);
      if (texts.length > 0 && !line.isMeta) {
        const text = texts.join("\n");
        latestUserMessage = text;
        recentMessages.push(truncate(text, 120));
        timeline.push({
          id: line.uuid ?? crypto.randomUUID(),
          type: "user_message",
          summary: truncate(text, 180),
          evidence: null,
          createdAt: timestamp,
        });
      }
      continue;
    }

    if (line.type === "assistant") {
      const texts = extractMeaningfulText(line.message?.content);
      if (texts.length > 0) {
        const text = texts.join("\n");
        latestAssistantMessage = text;
        recentMessages.push(truncate(text, 120));
        timeline.push({
          id: line.uuid ?? crypto.randomUUID(),
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

      if (Array.isArray(line.message?.content)) {
        for (const part of line.message.content) {
          if (
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "tool_use"
          ) {
            const toolPart = part as {
              name?: unknown;
              input?: { command?: unknown; description?: unknown };
            };
            const summary = [
              typeof toolPart.name === "string" ? toolPart.name : "tool",
              typeof toolPart.input?.command === "string"
                ? toolPart.input.command
                : typeof toolPart.input?.description === "string"
                  ? toolPart.input.description
                  : null,
            ]
              .filter((value): value is string => Boolean(value))
              .join(": ");
            commandHighlights.push(truncate(summary, 180));
            timeline.push({
              id: crypto.randomUUID(),
              type: "tool_call",
              summary: truncate(summary, 180),
              evidence: null,
              createdAt: timestamp,
            });
          }
        }
      }
      continue;
    }

    if (line.type === "system" && line.subtype === "api_error") {
      sawApiError = true;
      const summary = line.error
        ? `Claude API error: ${line.error}`
        : "Claude API error interrupted the session.";
      unresolvedIssues.add(summary);
      timeline.push({
        id: line.uuid ?? crypto.randomUUID(),
        type: "blocked",
        summary,
        evidence: null,
        createdAt: timestamp,
      });
      continue;
    }

    if (line.type === "attachment" && line.attachment?.type === "skill_listing") {
      timeline.push({
        id: line.uuid ?? crypto.randomUUID(),
        type: "progress",
        summary: "Claude session initialized its available tools and skills.",
        evidence: null,
        createdAt: timestamp,
      });
      continue;
    }

    if (line.toolUseResult?.stdout || line.toolUseResult?.stderr) {
      const output = [line.toolUseResult.stdout, line.toolUseResult.stderr]
        .filter((value): value is string => Boolean(value))
        .join("\n");
      timeline.push({
        id: line.uuid ?? crypto.randomUUID(),
        type: "tool_output",
        summary: truncate(output.replace(/\s+/g, " "), 180),
        evidence: null,
        createdAt: timestamp,
      });
      const maybeTests = extractTestsStatus(output);
      if (!testsStatus && maybeTests) testsStatus = maybeTests;
      for (const file of extractChangedFiles(output)) changedFiles.add(file);
    }
  }

  const sortedTimeline = timeline
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12);
  const updatedAt = sortedTimeline[0]?.createdAt ?? fileUpdatedAt(filePath);
  const latestTimelineType = sortedTimeline[0]?.type ?? null;
  const status = deriveStatus(
    updatedAt,
    latestAssistantMessage,
    latestTimelineType,
    Boolean(active),
    sawApiError,
  );
  const title =
    latestUserMessage?.split("\n")[0].trim() ||
    basename(cwd) ||
    "Untitled Claude Code session";

  const session: SessionRecord = {
    id: `claude:${sessionId}`,
    threadId: sessionId,
    turnId: null,
    runId: null,
    workItemId: null,
    source: "discovered",
    provider: "claude",
    isArchived: isArchivedSession(updatedAt),
    title: truncate(title, 88),
    objective: latestUserMessage ? truncate(latestUserMessage, 240) : null,
    repoName: basename(cwd),
    repoPath: cwd,
    status,
    summary: truncate(
      latestAssistantMessage ?? latestUserMessage ?? "Discovered Claude Code session.",
      220,
    ),
    blocker:
      status === "blocked"
        ? truncate(latestAssistantMessage ?? "Claude Code session is blocked.", 180)
        : null,
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

export function discoverClaudeSessionDetails(limit = 24) {
  const projectsRoot = path.join(claudeRootDir(), "projects");
  if (!existsSync(projectsRoot)) return [];
  const activeSessions = activeClaudeSessions();
  const files = walkFiles(projectsRoot)
    .map((filePath) => ({ filePath, updatedAt: fileUpdatedAt(filePath) }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit * 3);

  const details = files
    .map((entry) => buildClaudeDetail(entry.filePath, activeSessions))
    .filter((value): value is SessionDetail => Boolean(value))
    .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));

  const uniqueBySessionId = new Map<string, SessionDetail>();
  for (const detail of details) {
    if (!uniqueBySessionId.has(detail.session.threadId)) {
      uniqueBySessionId.set(detail.session.threadId, detail);
    }
  }

  return [...uniqueBySessionId.values()].slice(0, limit);
}
