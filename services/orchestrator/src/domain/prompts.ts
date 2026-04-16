import type {
  CreateWorkItemInput,
  Repo,
  SessionRecord,
  Settings,
  WorkItem,
} from "@superman/shared-types";

const STATUS_SCHEMA = {
  type: "object",
  properties: {
    state: {
      type: "string",
      enum: ["running", "needs_me", "blocked", "ready"],
    },
    summary: { type: "string" },
    blocker: { type: ["string", "null"] },
    next_human_action: { type: ["string", "null"] },
    changed_files_summary: {
      type: "array",
      items: { type: "string" },
    },
    tests_status: { type: ["string", "null"] },
  },
  required: ["state", "summary"],
};

export function buildTurnInput(
  workItem: WorkItem,
  repo: Repo,
  runLabel: string,
  settings: Settings,
): Array<{ type: "text"; text: string }> {
  const constraints = workItem.constraints?.trim() || "None provided.";
  return [
    {
      type: "text",
      text: [
        "You are working inside a local repository managed through Superman.",
        "",
        `Run label: ${runLabel}`,
        `Work item title: ${workItem.title}`,
        `Objective: ${workItem.objective}`,
        `Done criteria: ${workItem.doneCriteria}`,
        `Repo path: ${repo.absolutePath}`,
        `Constraints: ${constraints}`,
        "",
        "Important:",
        "- Work autonomously unless you truly need human input.",
        "- Keep updates concise and action-oriented.",
        "- When blocked, state the blocker explicitly.",
        "- When ready for review, say so clearly.",
        "- Use the workspace-write sandbox conservatively and request approval only when required.",
        `- Model preference: ${settings.defaultModel}.`,
        "",
        "At meaningful milestones, include a compact status packet in plain English with:",
        "state, summary, blocker (nullable), next human action (nullable), changed files summary, tests status.",
      ].join("\n"),
    },
  ];
}

export function buildStructuredOutputSchema() {
  return STATUS_SCHEMA;
}

export function buildSuggestedNextPrompt(workItem: WorkItem) {
  return [
    `Resume work on "${workItem.title}".`,
    `Current summary: ${workItem.currentSummary}`,
    workItem.currentBlocker
      ? `Address blocker: ${workItem.currentBlocker}`
      : "Review the latest artifacts, close any remaining gaps, and confirm done criteria.",
    `Done criteria: ${workItem.doneCriteria}`,
  ].join("\n");
}

export function buildSessionSuggestedNextPrompt(session: SessionRecord) {
  const providerLabel =
    session.provider === "claude" ? "Claude Code" : "Codex";
  return [
    `Resume the ${providerLabel} session "${session.title}".`,
    `Current summary: ${session.summary}`,
    session.blocker
      ? `Address blocker: ${session.blocker}`
      : "Review the current state, close remaining gaps, and continue toward completion.",
    session.objective ? `Latest user goal: ${session.objective}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export function seedDescription(input: CreateWorkItemInput) {
  if (input.description?.trim()) {
    return input.description.trim();
  }

  return `${input.objective.trim()}\n\nDone criteria:\n${input.doneCriteria.trim()}`;
}
