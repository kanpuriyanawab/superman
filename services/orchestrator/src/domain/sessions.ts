import type { SessionRecord, SessionStatus } from "@superman/shared-types";

export const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1_000;

const STATUS_PRIORITY: Record<SessionStatus, number> = {
  needs_me: 0,
  blocked: 1,
  running: 2,
  ready: 3,
  error: 4,
  idle: 5,
  done: 6,
};

export function isArchivedSession(updatedAt: string, now = Date.now()) {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return false;
  }
  return now - updatedMs > ARCHIVE_AFTER_MS;
}

export function compareSessions(left: SessionRecord, right: SessionRecord) {
  if (left.isArchived !== right.isArchived) {
    return left.isArchived ? 1 : -1;
  }

  const leftPriority = STATUS_PRIORITY[left.status] ?? 99;
  const rightPriority = STATUS_PRIORITY[right.status] ?? 99;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedCompare !== 0) {
    return updatedCompare;
  }

  return right.createdAt.localeCompare(left.createdAt);
}
