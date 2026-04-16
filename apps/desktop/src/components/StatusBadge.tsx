import type { SessionStatus } from "@superman/shared-types";

const LABELS: Record<SessionStatus, string> = {
  running: "Running",
  needs_me: "Needs Me",
  blocked: "Blocked",
  ready: "Ready",
  done: "Done",
  error: "Error",
  idle: "Idle",
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {LABELS[status]}
    </span>
  );
}
