import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  HandoffBundle,
  SessionDetail,
  SessionHandoffBundle,
  WorkItemDetail,
} from "@superman/shared-types";
import { buildSessionSuggestedNextPrompt, buildSuggestedNextPrompt } from "../domain/prompts.js";

function basename(filePath: string) {
  return path.basename(filePath);
}

export function buildHandoffBundle(detail: WorkItemDetail): HandoffBundle {
  const changedFiles = detail.checkpoints
    .flatMap((checkpoint: WorkItemDetail["checkpoints"][number]) =>
      checkpoint.evidence
        ? checkpoint.evidence
            .split("\n")
            .map((line: string) => line.trim())
            .filter((line: string) => line.startsWith("- "))
            .map((line: string) => line.slice(2))
        : [],
    )
    .slice(0, 10);

  return {
    workItem: detail.workItem,
    repoPath: detail.repo.absolutePath,
    currentStatus: detail.workItem.status,
    currentSummary: detail.workItem.currentSummary,
    goals: [detail.workItem.objective, detail.workItem.doneCriteria],
    constraints: detail.workItem.constraints
      ? [detail.workItem.constraints]
      : [],
    decisionsMade: detail.checkpoints
      .filter(
        (checkpoint: WorkItemDetail["checkpoints"][number]) =>
          checkpoint.type === "progress" || checkpoint.type === "completed",
      )
      .slice(0, 5)
      .map((checkpoint: WorkItemDetail["checkpoints"][number]) => checkpoint.summary),
    blockers: detail.workItem.currentBlocker ? [detail.workItem.currentBlocker] : [],
    changedFiles,
    suggestedNextPrompt: buildSuggestedNextPrompt(detail.workItem),
    artifactReferences: detail.runs
      .map((run: WorkItemDetail["runs"][number]) => run.branchName ?? run.worktreePath ?? run.label)
      .filter(Boolean),
    generatedAt: new Date().toISOString(),
  };
}

export function buildMarkdown(bundle: HandoffBundle) {
  return [
    `# Handoff: ${bundle.workItem.title}`,
    "",
    "## Objective",
    bundle.workItem.objective,
    "",
    "## Done Criteria",
    bundle.workItem.doneCriteria,
    "",
    "## Current Status",
    bundle.currentStatus,
    "",
    "## What Happened",
    bundle.currentSummary,
    "",
    "## Decisions Made",
    ...bundle.decisionsMade.map((decision: string) => `- ${decision}`),
    "",
    "## Blockers / Risks",
    ...(bundle.blockers.length > 0 ? bundle.blockers : ["- None."]).map(
      (blocker: string) => (blocker.startsWith("- ") ? blocker : `- ${blocker}`),
    ),
    "",
    "## Changed Files",
    ...(bundle.changedFiles.length > 0 ? bundle.changedFiles : ["- None captured yet."]).map(
      (file: string) => (file.startsWith("- ") ? file : `- ${file}`),
    ),
    "",
    "## Recommended Next Prompt",
    bundle.suggestedNextPrompt,
  ].join("\n");
}

export function buildSessionHandoffBundle(detail: SessionDetail): SessionHandoffBundle {
  const goals = [...new Set([detail.session.objective, detail.latestUserMessage].filter(Boolean))];
  return {
    session: detail.session,
    repoPath: detail.session.repoPath,
    currentStatus: detail.session.status,
    currentSummary: detail.insight.overview,
    goals: goals.slice(0, 3) as string[],
    blockers: detail.session.blocker ? [detail.session.blocker] : [],
    changedFiles: detail.artifacts.changedFiles.slice(0, 12),
    suggestedNextPrompt: buildSessionSuggestedNextPrompt(detail.session),
    artifactReferences: [
      detail.artifacts.branchName,
      detail.artifacts.worktreePath,
      ...detail.artifacts.commandHighlights,
    ].filter((value): value is string => Boolean(value)),
    generatedAt: new Date().toISOString(),
  };
}

export function buildSessionMarkdown(bundle: SessionHandoffBundle) {
  return [
    `# Session Handoff: ${bundle.session.title}`,
    "",
    "## Status",
    bundle.currentStatus,
    "",
    "## Current Summary",
    bundle.currentSummary,
    "",
    "## Goal / Latest Ask",
    ...(bundle.goals.length > 0 ? bundle.goals : ["No goal captured yet."]),
    "",
    "## Blockers",
    ...(bundle.blockers.length > 0 ? bundle.blockers : ["- None."]).map((value: string) =>
      value.startsWith("- ") ? value : `- ${value}`,
    ),
    "",
    "## Changed Files",
    ...(bundle.changedFiles.length > 0 ? bundle.changedFiles : ["- None captured yet."]).map(
      (value: string) => (value.startsWith("- ") ? value : `- ${value}`),
    ),
    "",
    "## Recommended Next Prompt",
    bundle.suggestedNextPrompt,
  ].join("\n");
}

export function writeHandoffFiles(rootDir: string, detail: WorkItemDetail) {
  const bundle = buildHandoffBundle(detail);
  const exportsDir = path.join(rootDir, "handoffs");
  mkdirSync(exportsDir, { recursive: true });
  const safeTitle = detail.workItem.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const baseName = `${safeTitle}-${Date.now()}`;
  const markdownPath = path.join(exportsDir, `${baseName}.md`);
  const jsonPath = path.join(exportsDir, `${baseName}.json`);
  writeFileSync(markdownPath, buildMarkdown(bundle), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return {
    bundle,
    markdownPath,
    jsonPath,
    copyText: [
      detail.workItem.title,
      detail.workItem.currentSummary,
      `Repo: ${basename(detail.repo.absolutePath)}`,
      `Suggested next prompt:\n${bundle.suggestedNextPrompt}`,
    ].join("\n\n"),
  };
}

export function writeSessionHandoffFiles(rootDir: string, detail: SessionDetail) {
  const bundle = buildSessionHandoffBundle(detail);
  const exportsDir = path.join(rootDir, "handoffs");
  mkdirSync(exportsDir, { recursive: true });
  const safeTitle = detail.session.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const baseName = `${safeTitle}-${Date.now()}`;
  const markdownPath = path.join(exportsDir, `${baseName}.md`);
  const jsonPath = path.join(exportsDir, `${baseName}.json`);
  writeFileSync(markdownPath, buildSessionMarkdown(bundle), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return {
    bundle,
    markdownPath,
    jsonPath,
    copyText: [
      detail.session.title,
      detail.insight.overview,
      detail.session.repoPath ? `Repo: ${basename(detail.session.repoPath)}` : null,
      `Suggested next prompt:\n${bundle.suggestedNextPrompt}`,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
  };
}
