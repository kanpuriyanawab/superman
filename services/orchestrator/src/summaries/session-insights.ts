import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionDetail, SessionInsight } from "@superman/shared-types";

type CachedInsightEntry = {
  updatedAt: string;
  promptVersion?: string;
  repoSignature?: string;
  insight: SessionInsight;
};

type CachedInsightStore = Record<string, CachedInsightEntry>;

type OllamaInsightPayload = {
  headline?: unknown;
  overview?: unknown;
  latestUpdate?: unknown;
  nextAction?: unknown;
  changedFilesSummary?: unknown;
  riskSummary?: unknown;
};

type ProjectGuidance = {
  signature: string;
  summary: string | null;
};

const SESSION_PROMPT_VERSION = "2026-04-16-session-v2";
const PROJECT_GUIDE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "README.mdx",
  "README.txt",
];

function truncate(value: string, length = 320) {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function compactLine(value: string | null | undefined) {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : null;
}

function meaningfulTimeline(detail: SessionDetail) {
  return detail.timeline.filter(
    (entry) =>
      !["tool_call", "tool_output", "reasoning"].includes(entry.type),
  );
}

function cacheKeyForSession(provider: SessionDetail["session"]["provider"], threadId: string) {
  return `${provider}:${threadId}`;
}

function cacheKey(detail: SessionDetail) {
  return cacheKeyForSession(detail.session.provider, detail.session.threadId);
}

function loadProjectGuidance(repoPath: string | null): ProjectGuidance {
  if (!repoPath) {
    return {
      signature: "no-repo",
      summary: null,
    };
  }

  const signatureParts: string[] = [];
  const sections: string[] = [];
  for (const fileName of PROJECT_GUIDE_FILES) {
    const absolutePath = path.join(repoPath, fileName);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stats = statSync(absolutePath);
    signatureParts.push(`${fileName}:${stats.mtimeMs}`);
    const content = readFileSync(absolutePath, "utf8").slice(0, 2200);
    const compact = compactLine(content);
    if (compact) {
      sections.push(`${fileName}: ${truncate(compact, 260)}`);
    }
  }

  return {
    signature: signatureParts.length > 0 ? signatureParts.join("|") : "no-guides",
    summary: sections.length > 0 ? sections.join(" ") : null,
  };
}

function coerceSentence(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const compact = compactLine(value);
  return compact ? truncate(compact, 220) : fallback;
}

function extractChangedFilesSummary(detail: SessionDetail) {
  if (detail.artifacts.changedFiles.length === 0) {
    return "No concrete code changes have been captured yet.";
  }
  const sample = detail.artifacts.changedFiles.slice(0, 4).join(", ");
  const extraCount = detail.artifacts.changedFiles.length - Math.min(detail.artifacts.changedFiles.length, 4);
  return extraCount > 0
    ? `Touches ${detail.artifacts.changedFiles.length} files, including ${sample}, plus ${extraCount} more.`
    : `Touches ${detail.artifacts.changedFiles.length} file${detail.artifacts.changedFiles.length === 1 ? "" : "s"}: ${sample}.`;
}

function extractRiskSummary(detail: SessionDetail) {
  if (detail.approvals.length > 0) {
    return `Waiting on ${detail.approvals.length} approval${detail.approvals.length === 1 ? "" : "s"} before progress can continue.`;
  }
  if (detail.session.blocker) {
    return truncate(detail.session.blocker, 220);
  }
  if (detail.artifacts.unresolvedIssues.length > 0) {
    return truncate(detail.artifacts.unresolvedIssues[0]!, 220);
  }
  if (detail.artifacts.testsStatus) {
    return truncate(detail.artifacts.testsStatus, 220);
  }
  return "No major risk surfaced from the captured session signals.";
}

function cleanHeadline(value: string | null | undefined) {
  if (!value) return null;
  const compact = value
    .replace(/\[Image #[^\]]+\]/g, " ")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 0 ? truncate(compact, 88) : null;
}

function fallbackHeadlineFromSessionTitle(title: string) {
  const cleaned = cleanHeadline(title);
  if (!cleaned) {
    return "Untitled session";
  }
  return cleaned;
}

function summarizeStatus(detail: SessionDetail) {
  const subject =
    compactLine(detail.latestUserMessage) ??
    compactLine(detail.session.objective) ??
    detail.session.title;

  switch (detail.session.status) {
    case "running":
      return `Agent is actively working on: ${truncate(subject, 180)}`;
    case "needs_me":
      return `This session is waiting on your input about: ${truncate(subject, 180)}`;
    case "blocked":
      return `This session is blocked while working on: ${truncate(subject, 180)}`;
    case "ready":
      return `A result is ready for review for: ${truncate(subject, 180)}`;
    case "idle":
      return `This session is paused. Last topic: ${truncate(subject, 180)}`;
    case "done":
      return `This session appears complete: ${truncate(subject, 180)}`;
    default:
      return `There is captured context for: ${truncate(subject, 180)}`;
  }
}

function buildFallbackInsight(detail: SessionDetail): SessionInsight {
  const meaningfulEntries = meaningfulTimeline(detail);
  const latestUpdate =
    compactLine(meaningfulEntries[0]?.summary) ??
    compactLine(detail.timeline[0]?.summary) ??
    compactLine(detail.session.summary) ??
    "No meaningful update has been captured yet.";

  return {
    source: "fallback",
    generatedAt: new Date().toISOString(),
    headline:
      cleanHeadline(detail.latestUserMessage) ??
      cleanHeadline(detail.session.objective) ??
      fallbackHeadlineFromSessionTitle(detail.session.title),
    overview: summarizeStatus(detail),
    latestUpdate,
    nextAction:
      compactLine(detail.session.nextHumanAction) ??
      (detail.session.status === "running"
        ? "Let it continue unless a blocker or approval appears."
        : "Open the session when you want to continue it."),
    changedFilesSummary: extractChangedFilesSummary(detail),
    riskSummary: extractRiskSummary(detail),
  };
}

function stripCodeFences(value: string) {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseInsightPayload(raw: unknown) {
  if (!raw) return null;
  if (typeof raw === "object") {
    return raw as OllamaInsightPayload;
  }
  if (typeof raw !== "string") return null;

  const direct = safeJson<OllamaInsightPayload>(stripCodeFences(raw));
  if (direct) return direct;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return safeJson<OllamaInsightPayload>(raw.slice(start, end + 1));
  }
  return null;
}

function recentMessages(detail: SessionDetail) {
  const items = [
    detail.latestUserMessage,
    ...detail.artifacts.recentMessages.slice(0, 4),
  ]
    .map((value) => compactLine(value))
    .filter((value): value is string => Boolean(value));

  return [...new Set(items)].slice(0, 5);
}

function buildPrompt(detail: SessionDetail, guidance: ProjectGuidance) {
  const timeline = meaningfulTimeline(detail)
    .slice(0, 6)
    .map(
      (entry, index) =>
        `${index + 1}. [${entry.type}] ${truncate(compactLine(entry.summary) ?? "No summary", 200)}`,
    )
    .join("\n");
  const userContext = recentMessages(detail)
    .map((message, index) => `${index + 1}. ${truncate(message, 220)}`)
    .join("\n");

  return [
    "You are preparing a control-plane brief for a human who is supervising multiple coding-agent sessions.",
    "Your job is to interpret what the session is trying to achieve, what state it is in now, and what the human should care about next.",
    "Prioritize user intent, project goals, and current blockers over implementation trivia.",
    "Use project docs to understand the repo's purpose if they clarify the goal.",
    "Do not repeat raw logs, shell chatter, or implementation details unless they materially change the human decision.",
    "Do not mention hidden reasoning, speculation, or uncertainty unless the session is genuinely ambiguous.",
    "Write concise, operator-facing language.",
    "",
    "Return strict JSON with exactly these keys:",
    "- headline: short title, under 80 characters, describing the task in plain English",
    "- overview: 1-2 sentences explaining the goal and current state",
    "- latestUpdate: one concrete sentence describing the latest meaningful progress or blocker",
    "- nextAction: one imperative sentence telling the human the best next move",
    "- changedFilesSummary: summarize scope of code impact, not a raw file dump",
    "- riskSummary: current real risk, blocker, approval dependency, or test concern",
    "",
    `Provider: ${detail.session.provider}`,
    `Title: ${detail.session.title}`,
    `Status: ${detail.session.status}`,
    `Repo: ${detail.session.repoPath ?? "unknown"}`,
    `Project guidance: ${guidance.summary ?? "none"}`,
    `Latest human ask: ${truncate(detail.latestUserMessage ?? detail.session.objective ?? "unknown", 260)}`,
    `Current raw summary: ${truncate(detail.session.summary, 320)}`,
    `Current blocker: ${truncate(detail.session.blocker ?? "none", 220)}`,
    `Next human action from system: ${truncate(detail.session.nextHumanAction ?? "none", 220)}`,
    `Approvals pending: ${detail.approvals.length}`,
    `Changed files: ${detail.artifacts.changedFiles.slice(0, 6).join(", ") || "none"}`,
    `Recent commands: ${detail.artifacts.commandHighlights.slice(0, 4).join(" | ") || "none"}`,
    `Tests signal: ${detail.artifacts.testsStatus ?? "none"}`,
    `Unresolved issues: ${detail.artifacts.unresolvedIssues.slice(0, 3).join(" | ") || "none"}`,
    "",
    "Recent human-facing context:",
    userContext || "No recent human-facing context captured.",
    "",
    "Recent timeline:",
    timeline || "No timeline entries captured.",
  ].join("\n");
}

async function summarizeWithOllama(detail: SessionDetail, guidance: ProjectGuidance) {
  const endpoint =
    process.env.SUPERMAN_OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434/api/chat";
  const model = process.env.SUPERMAN_OLLAMA_MODEL ?? "qwen3.5:4b";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const fallback = buildFallbackInsight(detail);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: "json",
        messages: [
          {
            role: "system",
            content:
              "You summarize coding-agent sessions for a local operator dashboard. Capture intent, state, and blocker clearly. Avoid implementation trivia unless it changes the decision.",
          },
          {
            role: "user",
            content: buildPrompt(detail, guidance),
          },
        ],
      }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      message?: { content?: unknown };
    };
    const parsed = parseInsightPayload(payload.message?.content);
    if (!parsed) {
      return null;
    }

    return {
      source: "ollama" as const,
      generatedAt: new Date().toISOString(),
      headline: coerceSentence(parsed.headline, fallback.headline),
      overview: coerceSentence(parsed.overview, fallback.overview),
      latestUpdate: coerceSentence(
        parsed.latestUpdate,
        fallback.latestUpdate,
      ),
      nextAction: coerceSentence(parsed.nextAction, fallback.nextAction),
      changedFilesSummary: coerceSentence(
        parsed.changedFilesSummary,
        extractChangedFilesSummary(detail),
      ),
      riskSummary: coerceSentence(parsed.riskSummary, extractRiskSummary(detail)),
    } satisfies SessionInsight;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export class SessionInsightService {
  private readonly cachePath: string;
  private loaded = false;
  private cache: CachedInsightStore = {};

  constructor(rootDir: string) {
    this.cachePath = path.join(rootDir, "cache", "session-insights.json");
  }

  async enrich(detail: SessionDetail): Promise<SessionDetail> {
    const guidance = loadProjectGuidance(detail.session.repoPath);
    const cached = this.getCached(detail, guidance);
    if (cached) {
      return { ...detail, insight: cached };
    }

    const insight =
      (await summarizeWithOllama(detail, guidance)) ??
      buildFallbackInsight(detail);
    this.putCached(detail, insight, guidance);
    return { ...detail, insight };
  }

  decorateSession(session: SessionDetail["session"]) {
    this.ensureLoaded();
    const guidance = loadProjectGuidance(session.repoPath);
    const entry = this.cache[cacheKeyForSession(session.provider, session.threadId)];
    if (
      !entry ||
      entry.updatedAt !== session.updatedAt ||
      entry.promptVersion !== SESSION_PROMPT_VERSION ||
      entry.repoSignature !== guidance.signature ||
      typeof entry.insight.headline !== "string" ||
      entry.insight.headline.length === 0
    ) {
      return {
        ...session,
        title: fallbackHeadlineFromSessionTitle(session.title),
      };
    }
    return {
      ...session,
      title: entry.insight.headline,
      summary: entry.insight.overview,
      nextHumanAction: entry.insight.nextAction,
    };
  }

  async warm(details: SessionDetail[], limit = 24) {
    for (const detail of details.slice(0, limit)) {
      if (this.getCached(detail, loadProjectGuidance(detail.session.repoPath))) {
        continue;
      }
      await this.enrich(detail);
    }
  }

  private ensureLoaded() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!existsSync(this.cachePath)) {
      this.cache = {};
      return;
    }
    this.cache = safeJson<CachedInsightStore>(readFileSync(this.cachePath, "utf8")) ?? {};
  }

  private getCached(detail: SessionDetail, guidance: ProjectGuidance) {
    this.ensureLoaded();
    const entry = this.cache[cacheKey(detail)];
    if (
      !entry ||
      entry.updatedAt !== detail.session.updatedAt ||
      entry.promptVersion !== SESSION_PROMPT_VERSION ||
      entry.repoSignature !== guidance.signature
    ) {
      return null;
    }
    if (
      typeof entry.insight.headline !== "string" ||
      entry.insight.headline.length === 0
    ) {
      return null;
    }
    if (entry.insight.source === "fallback") {
      const generatedMs = Date.parse(entry.insight.generatedAt);
      if (!Number.isFinite(generatedMs) || Date.now() - generatedMs > 2 * 60 * 1_000) {
        return null;
      }
    }
    return entry.insight;
  }

  private putCached(detail: SessionDetail, insight: SessionInsight, guidance: ProjectGuidance) {
    this.ensureLoaded();
    this.cache[cacheKey(detail)] = {
      updatedAt: detail.session.updatedAt,
      promptVersion: SESSION_PROMPT_VERSION,
      repoSignature: guidance.signature,
      insight,
    };
    mkdirSync(path.dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }
}
