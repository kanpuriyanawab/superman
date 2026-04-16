import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "@superman/shared-types";
import { ARCHIVE_AFTER_MS, compareSessions, isArchivedSession } from "./sessions.js";

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "session-1",
    threadId: "thread-1",
    turnId: null,
    runId: null,
    workItemId: null,
    source: "discovered",
    provider: "codex",
    isArchived: false,
    title: "Test session",
    objective: null,
    repoName: "repo",
    repoPath: "/tmp/repo",
    status: "ready",
    summary: "summary",
    blocker: null,
    nextHumanAction: null,
    approvalCount: 0,
    updatedAt: "2026-04-16T09:00:00.000Z",
    createdAt: "2026-04-16T08:00:00.000Z",
    lastEventAt: "2026-04-16T09:00:00.000Z",
    branchName: "main",
    worktreePath: null,
    model: null,
    ...overrides,
  };
}

test("isArchivedSession marks sessions older than three days as archived", () => {
  const now = Date.parse("2026-04-16T12:00:00.000Z");
  assert.equal(
    isArchivedSession(
      new Date(now - ARCHIVE_AFTER_MS - 60_000).toISOString(),
      now,
    ),
    true,
  );
  assert.equal(
    isArchivedSession(
      new Date(now - ARCHIVE_AFTER_MS + 60_000).toISOString(),
      now,
    ),
    false,
  );
});

test("compareSessions keeps active sessions ahead of archived history and sorts by status priority", () => {
  const sessions = [
    session({
      id: "archived",
      isArchived: true,
      status: "running",
      updatedAt: "2026-04-01T09:00:00.000Z",
    }),
    session({
      id: "ready",
      status: "ready",
      updatedAt: "2026-04-16T09:00:00.000Z",
    }),
    session({
      id: "running",
      status: "running",
      updatedAt: "2026-04-15T09:00:00.000Z",
    }),
    session({
      id: "needs-me",
      status: "needs_me",
      updatedAt: "2026-04-15T08:00:00.000Z",
    }),
  ];

  sessions.sort(compareSessions);
  assert.deepEqual(
    sessions.map((entry) => entry.id),
    ["needs-me", "running", "ready", "archived"],
  );
});
