import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  QueueEntity,
  QueueEntityDetail,
  QueueInsight,
  SessionDetail,
  SessionStatus,
} from "@superman/shared-types";

type CachedQueueInsightEntry = {
  signature: string;
  insight: QueueInsight;
};

type CachedQueueInsightStore = Record<string, CachedQueueInsightEntry>;

type OllamaQueuePayload = {
  goalSummary?: unknown;
  problemSummary?: unknown;
  latestUpdate?: unknown;
  nextAction?: unknown;
};

type ProjectContext = {
  signature: string;
  docsSummary: string | null;
  memorySummary: string | null;
};

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

function signatureFromDetails(details: SessionDetail[], projectContext: ProjectContext) {
  return details
    .map((detail) => `${detail.session.id}:${detail.session.updatedAt}`)
    .sort()
    .concat(projectContext.signature)
    .join("|");
}

function queueCacheKey(entity: Pick<QueueEntity, "repoPath" | "repoName">) {
  return entity.repoPath ?? entity.repoName;
}

function memoryFilePath(rootDir: string, entity: Pick<QueueEntity, "repoPath" | "repoName">) {
  const key = Buffer.from(queueCacheKey(entity)).toString("base64url");
  return path.join(rootDir, "memory", `${key}.md`);
}

function coerceSentence(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const compact = compactLine(value);
  return compact ? truncate(compact, 240) : fallback;
}

function summarizeGoal(details: SessionDetail[], projectContext: ProjectContext) {
  if (projectContext.docsSummary) {
    return truncate(projectContext.docsSummary, 240);
  }
  const candidates = details
    .flatMap((detail) => [detail.latestUserMessage, detail.session.objective])
    .map((value) => compactLine(value))
    .filter((value): value is string => Boolean(value));
  if (candidates.length === 0) {
    return "Work has been happening in this repository, but the captured prompts do not yet provide a clean high-level goal.";
  }
  return truncate(candidates[0]!, 240);
}

function summarizeProblem(details: SessionDetail[], topStatus: SessionStatus) {
  const blocker =
    details
      .map((detail) => compactLine(detail.session.blocker))
      .find((value): value is string => Boolean(value)) ??
    details
      .flatMap((detail) => detail.artifacts.unresolvedIssues)
      .map((value) => compactLine(value))
      .find((value): value is string => Boolean(value)) ??
    null;

  if (blocker) {
    return truncate(blocker, 220);
  }
  if (topStatus === "needs_me") {
    return "The work is waiting on a human decision or missing context.";
  }
  if (topStatus === "blocked") {
    return "The work is blocked right now and needs intervention before it can continue.";
  }
  if (topStatus === "running") {
    return "No blocker is surfaced right now; the work is actively progressing.";
  }
  return null;
}

function summarizeLatestUpdate(details: SessionDetail[]) {
  const candidates = details
    .flatMap((detail) => [detail.insight?.latestUpdate, detail.session.summary])
    .map((value) => compactLine(value))
    .filter((value): value is string => Boolean(value));
  return candidates[0] ?? "No meaningful update has been captured yet.";
}

function summarizeNextAction(entity: QueueEntity, details: SessionDetail[]) {
  const candidates = details
    .flatMap((detail) => [detail.insight?.nextAction, detail.session.nextHumanAction])
    .map((value) => compactLine(value))
    .filter((value): value is string => Boolean(value));
  return candidates[0] ?? entity.nextHumanAction ?? "Open the most recent session when you want to continue the work.";
}

function buildFallbackInsight(
  entity: QueueEntity,
  details: SessionDetail[],
  projectContext: ProjectContext,
): QueueInsight {
  const problem =
    summarizeProblem(details, entity.status) ??
    compactLine(projectContext.memorySummary) ??
    null;
  return {
    source: "fallback",
    generatedAt: new Date().toISOString(),
    goalSummary: summarizeGoal(details, projectContext),
    problemSummary: problem,
    latestUpdate: truncate(summarizeLatestUpdate(details), 240),
    nextAction: truncate(summarizeNextAction(entity, details), 220),
  };
}

function parsePayload(raw: unknown) {
  if (!raw) return null;
  if (typeof raw === "object") {
    return raw as OllamaQueuePayload;
  }
  if (typeof raw !== "string") return null;
  return safeJson<OllamaQueuePayload>(raw);
}

function buildPrompt(
  entity: QueueEntity,
  details: SessionDetail[],
  projectContext: ProjectContext,
) {
  const sessionSnippets = details
    .slice(0, 5)
    .map((detail, index) =>
      [
        `${index + 1}. status=${detail.session.status}`,
        `goal=${truncate(compactLine(detail.latestUserMessage ?? detail.session.objective ?? "unknown") ?? "unknown", 180)}`,
        `summary=${truncate(compactLine(detail.session.summary) ?? "unknown", 180)}`,
        `problem=${truncate(compactLine(detail.session.blocker ?? detail.insight?.riskSummary ?? "none") ?? "none", 180)}`,
      ].join(" | "),
    )
    .join("\n");

  return [
    "Summarize this repository-level agent queue entity for a human operator.",
    "Focus on what the work across recent sessions was trying to achieve overall, and what the current problem or friction is now.",
    "Return strict JSON with keys: goalSummary, problemSummary, latestUpdate, nextAction.",
    "",
    `Repository: ${entity.repoPath ?? entity.repoName}`,
    `Current status: ${entity.status}`,
    `Session count: ${details.length}`,
    "",
    `Project docs: ${projectContext.docsSummary ?? "none"}`,
    `Superman memory: ${projectContext.memorySummary ?? "none"}`,
    "",
    "Recent sessions:",
    sessionSnippets || "No session summaries captured.",
  ].join("\n");
}

async function summarizeWithOllama(
  entity: QueueEntity,
  details: SessionDetail[],
  projectContext: ProjectContext,
) {
  const endpoint =
    process.env.SUPERMAN_OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434/api/chat";
  const model = process.env.SUPERMAN_OLLAMA_MODEL ?? "qwen3.5:4b";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const fallback = buildFallbackInsight(entity, details, projectContext);

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
              "You summarize software work for a local control-plane UI. Be concise, concrete, and user-facing.",
          },
          { role: "user", content: buildPrompt(entity, details, projectContext) },
        ],
      }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      message?: { content?: unknown };
    };
    const parsed = parsePayload(payload.message?.content);
    if (!parsed) {
      return null;
    }

    return {
      source: "ollama" as const,
      generatedAt: new Date().toISOString(),
      goalSummary: coerceSentence(parsed.goalSummary, fallback.goalSummary),
      problemSummary: coerceSentence(
        parsed.problemSummary,
        fallback.problemSummary ?? "No blocker is surfaced right now.",
      ),
      latestUpdate: coerceSentence(parsed.latestUpdate, fallback.latestUpdate),
      nextAction: coerceSentence(parsed.nextAction, fallback.nextAction),
    } satisfies QueueInsight;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export class QueueInsightService {
  private readonly cachePath: string;
  private readonly rootDir: string;
  private loaded = false;
  private cache: CachedQueueInsightStore = {};

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.cachePath = path.join(rootDir, "cache", "queue-insights.json");
  }

  decorateEntity(entity: QueueEntity, details: SessionDetail[]) {
    this.ensureLoaded();
    const projectContext = this.loadProjectContext(entity);
    const entry = this.cache[queueCacheKey(entity)];
    const signature = signatureFromDetails(details, projectContext);
    if (!entry || entry.signature !== signature) {
      const fallback = buildFallbackInsight(entity, details, projectContext);
      return {
        ...entity,
        summary: fallback.goalSummary,
        problem: fallback.problemSummary,
        nextHumanAction: fallback.nextAction,
      };
    }
    return {
      ...entity,
      summary: entry.insight.goalSummary,
      problem: entry.insight.problemSummary,
      nextHumanAction: entry.insight.nextAction,
    };
  }

  async enrich(detail: QueueEntityDetail, sourceDetails: SessionDetail[]) {
    const projectContext = this.loadProjectContext(detail.entity);
    const cached = this.getCached(detail.entity, sourceDetails, projectContext);
    if (cached) {
      return { ...detail, insight: cached };
    }

    const insight =
      (await summarizeWithOllama(detail.entity, sourceDetails, projectContext)) ??
      buildFallbackInsight(detail.entity, sourceDetails, projectContext);
    this.putCached(detail.entity, sourceDetails, insight, projectContext);
    return { ...detail, insight };
  }

  async warm(detailsByEntity: Array<{ entity: QueueEntity; details: SessionDetail[] }>, limit = 16) {
    for (const item of detailsByEntity.slice(0, limit)) {
      const projectContext = this.loadProjectContext(item.entity);
      if (this.getCached(item.entity, item.details, projectContext)) {
        continue;
      }
      const detail = {
        entity: item.entity,
        repo: null,
        insight: buildFallbackInsight(item.entity, item.details, projectContext),
        sessions: [],
        continueSession: null,
        providerLabels: [],
        timeline: [],
        changedFilesSummary: null,
        testsStatus: null,
        riskSummary: null,
        branchNames: [],
      } satisfies QueueEntityDetail;
      await this.enrich(detail, item.details);
    }
  }

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.cachePath)) {
      this.cache = {};
      return;
    }
    this.cache = safeJson<CachedQueueInsightStore>(readFileSync(this.cachePath, "utf8")) ?? {};
  }

  memoryPathFor(entity: Pick<QueueEntity, "repoPath" | "repoName">) {
    return memoryFilePath(this.rootDir, entity);
  }

  writeMemory(
    entity: Pick<QueueEntity, "repoPath" | "repoName">,
    sections: Array<{ title: string; body: string | null | undefined }>,
  ) {
    const body = sections
      .map((section) => {
        const value = compactLine(section.body);
        return value ? `## ${section.title}\n${value}` : null;
      })
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const memoryPath = this.memoryPathFor(entity);
    mkdirSync(path.dirname(memoryPath), { recursive: true });
    writeFileSync(memoryPath, `${body}\n`, "utf8");
    return memoryPath;
  }

  private loadProjectContext(entity: Pick<QueueEntity, "repoPath" | "repoName">): ProjectContext {
    const signatureParts: string[] = [];
    const docSections: string[] = [];
    for (const candidate of PROJECT_GUIDE_FILES) {
      const docPath = entity.repoPath ? path.join(entity.repoPath, candidate) : null;
      if (!docPath || !existsSync(docPath)) {
        continue;
      }
      const stats = statSync(docPath);
      signatureParts.push(`${candidate}:${stats.mtimeMs}`);
      const content = readFileSync(docPath, "utf8");
      const compact = compactLine(content.slice(0, 2400));
      if (compact) {
        docSections.push(`${candidate}: ${truncate(compact, 320)}`);
      }
    }

    const memoryPath = this.memoryPathFor(entity);
    let memorySummary: string | null = null;
    if (existsSync(memoryPath)) {
      const stats = statSync(memoryPath);
      signatureParts.push(`memory:${stats.mtimeMs}`);
      memorySummary = compactLine(readFileSync(memoryPath, "utf8").slice(0, 1600));
    } else {
      signatureParts.push("memory:none");
    }

    return {
      signature: signatureParts.join("|"),
      docsSummary: docSections.length > 0 ? docSections.join(" ") : null,
      memorySummary,
    };
  }

  private getCached(entity: QueueEntity, details: SessionDetail[], projectContext: ProjectContext) {
    this.ensureLoaded();
    const entry = this.cache[queueCacheKey(entity)];
    if (!entry || entry.signature !== signatureFromDetails(details, projectContext)) {
      return null;
    }
    return entry.insight;
  }

  private putCached(
    entity: QueueEntity,
    details: SessionDetail[],
    insight: QueueInsight,
    projectContext: ProjectContext,
  ) {
    this.ensureLoaded();
    this.cache[queueCacheKey(entity)] = {
      signature: signatureFromDetails(details, projectContext),
      insight,
    };
    mkdirSync(path.dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }
}
