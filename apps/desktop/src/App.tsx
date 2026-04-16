import { useEffect, useMemo, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  QueueEntity,
  QueueEntityDetail,
  Repo,
  SessionDetail,
  SessionRecord,
  SessionTimelineEntry,
} from "@superman/shared-types";
import { StatusBadge } from "./components/StatusBadge";
import { api } from "./lib/api";
import {
  copyTextToClipboard,
  notifyUrgent,
  openCommandInTerminal,
  pickRepoDirectory,
  syncTray,
} from "./lib/tauri";

const queryClient = new QueryClient();

type View = "today" | "archives" | "settings";

type NavItem = {
  value: View;
  label: string;
};

function repoLabel(session: Pick<SessionRecord, "repoName" | "repoPath">) {
  if (session.repoName) return session.repoName;
  if (!session.repoPath) return "Unknown repo";
  const parts = session.repoPath.split("/").filter(Boolean);
  return parts.at(-1) ?? session.repoPath;
}

function sessionSummaryText(detail: SessionDetail) {
  const branch =
    detail.artifacts.branchName ?? detail.session.branchName ?? null;
  const parts = [
    `${providerLabel(detail.session)} session in ${repoLabel(detail.session)}.`,
    detail.insight.latestUpdate,
    detail.insight.changedFilesSummary,
    detail.insight.riskSummary,
    detail.artifacts.testsStatus
      ? `Tests: ${detail.artifacts.testsStatus}`
      : null,
    branch ? `Branch: ${branch}.` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.join(" ");
}

function timeAgo(value: string | null) {
  if (!value) return "No recent activity";
  const deltaMs = Date.now() - new Date(value).getTime();
  const deltaMinutes = Math.max(0, Math.round(deltaMs / 60_000));
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return `${Math.round(deltaHours / 24)}d ago`;
}

function groupSessions(sessions: SessionRecord[]) {
  return {
    needs_me: sessions.filter((session) => session.status === "needs_me"),
    running: sessions.filter((session) => session.status === "running"),
    blocked: sessions.filter((session) => session.status === "blocked"),
    ready: sessions.filter((session) => session.status === "ready"),
    idle: sessions.filter((session) => session.status === "idle"),
    done: sessions.filter((session) => session.status === "done"),
    error: sessions.filter((session) => session.status === "error"),
  };
}

function hasUrgentStatus(session: SessionRecord) {
  return ["needs_me", "blocked", "ready"].includes(session.status);
}

function providerLabel(session: SessionRecord) {
  return session.provider === "claude" ? "Claude Code" : "Codex";
}

function sessionResumeCommand(session: SessionRecord) {
  return session.provider === "claude"
    ? `claude --resume ${session.threadId}`
    : `codex resume ${session.threadId}`;
}

function SupermanLogo() {
  return (
    <svg
      aria-hidden="true"
      className="brand-logo"
      viewBox="0 0 64 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M5 7L21 1H43L59 7L47 24L32 51L17 24L5 7Z"
        fill="#E11D2E"
        stroke="#FACC15"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M20 14H40L36 19H27L30 23H39L32 34H20L24 29H32L29 25H21L28 14H20Z"
        fill="#FACC15"
      />
    </svg>
  );
}

function TodayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 3.25L11.8 6.9L15.85 7.5L12.92 10.36L13.61 14.4L10 12.5L6.39 14.4L7.08 10.36L4.15 7.5L8.2 6.9L10 3.25Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5.25H16V8H4V5.25Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M5.5 8V14.75H14.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 10.75H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 12.2C11.215 12.2 12.2 11.215 12.2 10C12.2 8.785 11.215 7.8 10 7.8C8.785 7.8 7.8 8.785 7.8 10C7.8 11.215 8.785 12.2 10 12.2Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 10C16 9.49 15.95 8.99 15.84 8.52L17.25 7.43L15.77 4.87L14.08 5.56C13.35 4.95 12.47 4.51 11.5 4.29L11.25 2.5H8.75L8.5 4.29C7.53 4.51 6.65 4.95 5.92 5.56L4.23 4.87L2.75 7.43L4.16 8.52C4.05 8.99 4 9.49 4 10C4 10.51 4.05 11.01 4.16 11.48L2.75 12.57L4.23 15.13L5.92 14.44C6.65 15.05 7.53 15.49 8.5 15.71L8.75 17.5H11.25L11.5 15.71C12.47 15.49 13.35 15.05 14.08 14.44L15.77 15.13L17.25 12.57L15.84 11.48C15.95 11.01 16 10.51 16 10Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function navIcon(view: View) {
  switch (view) {
    case "today":
      return <TodayIcon />;
    case "archives":
      return <ArchiveIcon />;
    case "settings":
      return <SettingsIcon />;
    default:
      return <TodayIcon />;
  }
}

function useEventStream() {
  const client = useQueryClient();
  const previousUrgent = useRef(0);

  useEffect(() => {
    const source = new EventSource(api.eventsUrl());
    const refresh = () => {
      void client.invalidateQueries();
    };

    const onTrayUpdated = async (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as {
        payload: {
          activeCount: number;
          needsMeCount: number;
          blockedCount: number;
          readyCount: number;
        };
      };
      const tray = payload.payload;
      await syncTray(tray);
      const urgent = tray.needsMeCount + tray.blockedCount + tray.readyCount;
      if (urgent > previousUrgent.current) {
        const title =
          tray.needsMeCount > 0
            ? "Session needs input"
            : tray.blockedCount > 0
              ? "A session is blocked"
              : "Session ready for review";
        const body = `${tray.needsMeCount} needs input, ${tray.blockedCount} blocked, ${tray.readyCount} ready`;
        await notifyUrgent(title, body);
      }
      previousUrgent.current = urgent;
      refresh();
    };

    source.addEventListener("sessions.updated", refresh as EventListener);
    source.addEventListener("approvals.updated", refresh as EventListener);
    source.addEventListener("repos.updated", refresh as EventListener);
    source.addEventListener("health.updated", refresh as EventListener);
    source.addEventListener(
      "tray.updated",
      onTrayUpdated as unknown as EventListener,
    );

    return () => {
      source.close();
    };
  }, [client]);
}

function AppShell() {
  useEventStream();
  const [view, setView] = useState<View>("today");
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [repoPathInput, setRepoPathInput] = useState("");
  const [handoffResult, setHandoffResult] = useState<{
    markdownPath: string;
    jsonPath: string;
  } | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const reposQuery = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const queueQuery = useQuery({
    queryKey: ["queue"],
    queryFn: api.queue,
    refetchInterval: 15_000,
  });
  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: api.sessions,
    refetchInterval: 15_000,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
  });
  const detailQuery = useQuery({
    queryKey: ["session", selectedSessionId],
    queryFn: () => api.sessionDetail(selectedSessionId!),
    enabled: Boolean(selectedSessionId),
    refetchInterval: selectedSessionId ? 15_000 : false,
  });
  const queueDetailQuery = useQuery({
    queryKey: ["queue", selectedQueueId],
    queryFn: () => api.queueDetail(selectedQueueId!),
    enabled: Boolean(selectedQueueId),
    refetchInterval: selectedQueueId ? 15_000 : false,
  });

  const createRepoMutation = useMutation({
    mutationFn: api.createRepo,
    onSuccess: async () => {
      setRepoPathInput("");
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    },
    onError: (error) => setErrorText(error.message),
  });

  const discoverMutation = useMutation({
    mutationFn: api.discoverSessions,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => setErrorText(error.message),
  });

  const exportMutation = useMutation({
    mutationFn: (sessionId: string) => api.exportSession(sessionId),
    onSuccess: async (result) => {
      setHandoffResult({
        markdownPath: result.markdownPath,
        jsonPath: result.jsonPath,
      });
      await copyTextToClipboard(result.copyText);
      await queryClient.invalidateQueries();
    },
    onError: (error) => setErrorText(error.message),
  });

  const settingsMutation = useMutation({
    mutationFn: api.patchSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => setErrorText(error.message),
  });

  const repos = reposQuery.data ?? [];
  const queueEntities = queueQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const mainSessions = sessions.filter((session) => !session.isArchived);
  const archivedSessions = sessions.filter((session) => session.isArchived);
  const selectedQueueDetail = queueDetailQuery.data ?? null;
  const selectedDetail = detailQuery.data ?? null;
  const grouped = useMemo(() => groupSessions(mainSessions), [mainSessions]);

  useEffect(() => {
    if (!selectedQueueId) {
      const preferred = queueEntities[0] ?? null;
      if (preferred) {
        setSelectedQueueId(preferred.id);
      }
    }
  }, [queueEntities, selectedQueueId]);

  useEffect(() => {
    if (!selectedSessionId) {
      const preferred = mainSessions[0] ?? archivedSessions[0] ?? null;
      if (preferred) {
        setSelectedSessionId(preferred.id);
      }
    }
  }, [archivedSessions, mainSessions, selectedSessionId]);

  useEffect(() => {
    const pool = view === "archives" ? archivedSessions : mainSessions;
    if (pool.length === 0) {
      return;
    }
    if (!selectedSessionId || !pool.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(pool[0]!.id);
    }
  }, [archivedSessions, mainSessions, selectedSessionId, view]);

  const summaryStats = {
    needsMe: grouped.needs_me.length,
    blocked: grouped.blocked.length,
    ready: grouped.ready.length,
  };

  const navItems: NavItem[] = [
    { value: "today", label: "Today" },
    { value: "archives", label: "Archives" },
    { value: "settings", label: "Settings" },
  ];

  async function handleRepoPicker() {
    const picked = await pickRepoDirectory();
    if (picked) setRepoPathInput(picked);
  }

  async function submitRepo() {
    try {
      setErrorText(null);
      const validation = await api.validateRepo({ absolutePath: repoPathInput });
      if (!validation.ok) {
        setErrorText(validation.reason ?? "That folder is not a git repo.");
        return;
      }
      await createRepoMutation.mutateAsync({ absolutePath: repoPathInput });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Unable to add repo.");
    }
  }

  async function handleOpenSessionInTerminal(session: SessionRecord) {
    try {
      setErrorText(null);
      await openCommandInTerminal(sessionResumeCommand(session), session.repoPath);
    } catch (error) {
      setErrorText(
        error instanceof Error
          ? error.message
          : "Unable to open Terminal for this session.",
      );
    }
  }

  function renderSessionCard(
    session: SessionRecord,
    compact = false,
    targetView: View = "today",
  ) {
    return (
      <button
        key={session.id}
        className={`session-card ${selectedSessionId === session.id ? "selected" : ""} ${
          compact ? "compact" : ""
        }`}
        onClick={() => {
          setSelectedSessionId(session.id);
          setView(targetView);
        }}
        type="button"
      >
        <div className="session-card-header">
          <span className="repo-pill">{repoLabel(session)}</span>
          <div className="session-card-header-actions">
            <StatusBadge status={session.status} />
            <span className="session-card-time">
              {timeAgo(session.lastEventAt ?? session.updatedAt)}
            </span>
          </div>
        </div>
        <h3>{session.title}</h3>
        <p>{session.summary}</p>
        <div className="session-card-footer">
          <span>
            {providerLabel(session)} ·{" "}
            {session.isArchived
              ? "Archived"
              : session.source === "discovered"
                ? "Auto-discovered"
                : "Supervised"}
          </span>
        </div>
      </button>
    );
  }

  function renderQueueCard(entity: QueueEntity) {
    return (
      <button
        key={entity.id}
        className={`session-card ${selectedQueueId === entity.id ? "selected" : ""}`}
        onClick={() => {
          setSelectedQueueId(entity.id);
          setView("today");
        }}
        type="button"
      >
        <div className="session-card-header">
          <StatusBadge status={entity.status} />
          <span className="session-card-time">{timeAgo(entity.lastEventAt ?? entity.updatedAt)}</span>
        </div>
        <h3>{entity.title}</h3>
        <p>{entity.summary}</p>
        {entity.problem ? <p className="queue-problem">{entity.problem}</p> : null}
        <div className="session-card-footer">
          <span>{entity.sessionCount} session{entity.sessionCount === 1 ? "" : "s"}</span>
          <span>{entity.branchName ?? entity.repoName}</span>
        </div>
      </button>
    );
  }

  function renderTodayView() {
    return (
      <div className="page-stack">
        <section className="signal-strip">
          <span className="signal-pill">
            <strong>{summaryStats.needsMe}</strong>
            Needs me
          </span>
          <span className="signal-pill">
            <strong>{grouped.blocked.length}</strong>
            Blocked
          </span>
          <span className="signal-pill">
            <strong>{grouped.running.length}</strong>
            Running
          </span>
          <span className="signal-pill">
            <strong>{grouped.ready.length}</strong>
            Ready
          </span>
        </section>

        <div className="workspace-grid">
          <section className="column-stack">
            <section className="panel session-list-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Sessions</p>
                  <h3>Current sessions</h3>
                </div>
                <span className="count-pill">{mainSessions.length}</span>
              </div>
              {mainSessions.length === 0 ? (
                <p className="empty-inline">No recent sessions are active right now.</p>
              ) : (
                <div className="session-grid">
                  {mainSessions.map((session) => renderSessionCard(session, false, "today"))}
                </div>
              )}
            </section>
          </section>

          <aside className="detail-panel">{renderSessionDetail(selectedDetail)}</aside>
        </div>
      </div>
    );
  }

  function renderQueueDetail(detail: QueueEntityDetail | null) {
    if (queueDetailQuery.isPending && !detail) {
      return (
        <div className="empty-detail">
          <p className="eyebrow">Selection</p>
          <h3>Summarizing project</h3>
          <p>Superman is condensing the recent work across sessions into a repo-level brief.</p>
        </div>
      );
    }

    if (!detail) {
      return (
        <div className="empty-detail">
          <p className="eyebrow">Selection</p>
          <h3>Pick a project</h3>
          <p>The aggregated brief, current problem, and continue command will appear here.</p>
        </div>
      );
    }

    const resumeCommand = detail.continueSession
      ? sessionResumeCommand(detail.continueSession)
      : null;

    return (
      <>
        <div className="detail-header">
          <div className="detail-heading">
            <div className="detail-chip-row">
              {detail.providerLabels.map((provider: QueueEntityDetail["providerLabels"][number]) => (
                <span key={provider} className="provider-pill">
                  {provider === "claude" ? "Claude Code" : "Codex"}
                </span>
              ))}
            </div>
            <h3>{detail.entity.title}</h3>
          </div>
          <StatusBadge status={detail.entity.status} />
        </div>

        <div className="detail-section detail-section-glance">
          <h4>At a glance</h4>
          <div className="glance-stack">
            <div className="glance-block">
              <span>What we were trying to achieve</span>
              <p className="glance-copy">{detail.insight.goalSummary}</p>
            </div>
            <div className="glance-block">
              <span>Current problem</span>
              <p className="glance-copy">
                {detail.insight.problemSummary ?? "No active blocker is surfaced right now."}
              </p>
            </div>
          </div>
        </div>

        <div className="detail-section">
          <h4>Continue session</h4>
          <div className="command-card">
            <span className="command-label">
              {detail.continueSession
                ? `${providerLabel(detail.continueSession)} · recommended session`
                : "No active session available"}
            </span>
            <code className="command-line">
              {resumeCommand ?? "No resumable session available."}
            </code>
            <div className="action-callout">
              <strong>{detail.insight.nextAction}</strong>
            </div>
            <div className="action-row">
              <button
                className="secondary-button"
                disabled={!resumeCommand}
                onClick={() => resumeCommand ? void copyTextToClipboard(resumeCommand) : undefined}
                type="button"
              >
                Copy command
              </button>
              <button
                className="ghost-button"
                disabled={!detail.continueSession || exportMutation.isPending}
                onClick={() =>
                  detail.continueSession
                    ? exportMutation.mutate(detail.continueSession.id)
                    : undefined
                }
                type="button"
              >
                Export handoff
              </button>
            </div>
          </div>
        </div>

        <div className="detail-section">
          <h4>Signals</h4>
          <div className="detail-metadata">
            <div>
              <span>Repo</span>
              <strong>{detail.entity.repoPath ?? detail.entity.repoName}</strong>
            </div>
            <div>
              <span>Latest update</span>
              <strong>{detail.insight.latestUpdate}</strong>
            </div>
            <div>
              <span>Code impact</span>
              <strong>{detail.changedFilesSummary ?? "No concrete code changes captured yet."}</strong>
            </div>
            <div>
              <span>Risk</span>
              <strong>{detail.riskSummary ?? "No major risk surfaced from the captured session signals."}</strong>
            </div>
            <div>
              <span>Tests</span>
              <strong>{detail.testsStatus ?? "No test signal captured yet."}</strong>
            </div>
            <div>
              <span>Branches</span>
              <strong>{detail.branchNames.length > 0 ? detail.branchNames.join(", ") : "No branch detected."}</strong>
            </div>
          </div>
        </div>

        <div className="detail-section">
          <h4>Recent activity</h4>
          <div className="timeline">
            {detail.timeline.length === 0 ? (
              <p className="empty-inline">No timeline entries captured yet.</p>
            ) : (
              detail.timeline
                .filter((entry: SessionTimelineEntry) => !["tool_call", "tool_output", "reasoning"].includes(entry.type))
                .slice(0, 8)
                .map((entry: SessionTimelineEntry) => (
                  <div key={entry.id} className="timeline-entry">
                    <div className="timeline-dot" />
                    <div>
                      <p className="eyebrow">{entry.type.replaceAll("_", " ")}</p>
                      <strong>{entry.summary}</strong>
                      {entry.evidence ? (
                        <details className="timeline-evidence">
                          <summary>Raw evidence</summary>
                          <p>{entry.evidence}</p>
                        </details>
                      ) : null}
                      <span>{timeAgo(entry.createdAt)}</span>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      </>
    );
  }

  function renderSessionDetail(detail: SessionDetail | null) {
    if (detailQuery.isPending && !detail) {
      return (
        <div className="empty-detail">
          <p className="eyebrow">Selection</p>
          <h3>Summarizing session</h3>
          <p>Superman is condensing the latest context into a clean operator brief.</p>
        </div>
      );
    }

    if (!detail) {
      return (
        <div className="empty-detail">
          <p className="eyebrow">Selection</p>
          <h3>Pick a session</h3>
          <p>The session brief, recent activity, and resume command will appear here.</p>
        </div>
      );
    }

    return (
      <>
        <div className="detail-header">
          <div className="detail-heading">
            <div className="detail-chip-row">
              <span className="provider-pill">{providerLabel(detail.session)}</span>
              <span className="repo-pill detail-repo-pill">{repoLabel(detail.session)}</span>
            </div>
            <h3>{detail.insight.headline}</h3>
          </div>
          <div className="detail-header-actions">
            <button
              className="secondary-button"
              onClick={() => void handleOpenSessionInTerminal(detail.session)}
              type="button"
            >
              Open in terminal
            </button>
            <StatusBadge status={detail.session.status} />
          </div>
        </div>

        <div className="detail-section detail-section-glance">
          <h4>At a glance</h4>
          <p className="glance-copy">{detail.insight.overview}</p>
        </div>

        <div className="detail-section">
          <h4>Next action</h4>
          <p className="glance-copy">{detail.insight.nextAction}</p>
        </div>

        <div className="detail-section">
          <h4>Summary</h4>
          <div className="summary-card">
            <p className="summary-copy">{sessionSummaryText(detail)}</p>
          </div>
        </div>

        <div className="detail-section">
          <h4>Recent activity</h4>
          <div className="timeline">
            {(() => {
              const visibleEntries =
                detail.timeline.filter(
                  (entry) => !["tool_call", "tool_output", "reasoning"].includes(entry.type),
                ).slice(0, 8) || [];
              const entries = visibleEntries.length > 0 ? visibleEntries : detail.timeline.slice(0, 6);

              return entries.length === 0 ? (
                <p className="empty-inline">No timeline entries captured yet.</p>
              ) : (
                entries.map((entry: SessionTimelineEntry) => (
                  <div key={entry.id} className="timeline-entry">
                    <div className="timeline-dot" />
                    <div>
                      <p className="eyebrow">{entry.type.replaceAll("_", " ")}</p>
                      <strong>{entry.summary}</strong>
                      {entry.evidence ? (
                        <details className="timeline-evidence">
                          <summary>Raw evidence</summary>
                          <p>{entry.evidence}</p>
                        </details>
                      ) : null}
                      <span>{timeAgo(entry.createdAt)}</span>
                    </div>
                  </div>
                ))
              );
            })()}
          </div>
        </div>
      </>
    );
  }

  function renderArchivesView() {
    return (
      <div className="page-stack">
        <section className="sessions-toolbar panel">
          <div>
            <p className="eyebrow">Archive</p>
            <h3>Older sessions</h3>
            <p className="subtle-copy">
              Sessions older than three days live here so the main command center stays centered on active work.
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => discoverMutation.mutate()}
            type="button"
          >
            Refresh discovery
          </button>
        </section>

        <div className="workspace-grid">
          <section className="column-stack">
            <section className="panel session-list-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Archives</p>
                  <h3>Past sessions</h3>
                </div>
                <span className="count-pill">{archivedSessions.length}</span>
              </div>
              {archivedSessions.length === 0 ? (
                <p className="empty-inline">Nothing has aged into the archive yet.</p>
              ) : (
                <div className="session-grid">
                  {archivedSessions.map((session) =>
                    renderSessionCard(session, false, "archives"),
                  )}
                </div>
              )}
            </section>
          </section>

          <aside className="detail-panel">{renderSessionDetail(selectedDetail)}</aside>
        </div>
      </div>
    );
  }

  function renderSettingsView() {
    return (
      <div className="page-stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Settings</p>
              <h3>Discovery and execution defaults</h3>
            </div>
          </div>
          <div className="settings-grid">
            <label className="toggle-card">
              <span>
                <strong>Simulator fallback</strong>
                <small>Keep Superman usable when Codex app-server is unavailable.</small>
              </span>
              <input
                checked={Boolean(settingsQuery.data?.simulatorFallback)}
                onChange={(event) =>
                  settingsMutation.mutate({
                    simulatorFallback: event.target.checked,
                  })
                }
                type="checkbox"
              />
            </label>

            <div className="settings-row">
              <span className="settings-label">Endpoint</span>
              <strong>{settingsQuery.data?.codexEndpoint ?? "ws://127.0.0.1:4500"}</strong>
            </div>
            <div className="settings-row">
              <span className="settings-label">Default model</span>
              <strong>{settingsQuery.data?.defaultModel ?? "gpt-5.4"}</strong>
            </div>
            <div className="settings-row">
              <span className="settings-label">Connected repos</span>
              <strong>{repos.length}</strong>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Repositories</p>
              <h3>Optional repo validation</h3>
            </div>
            <button
              className="secondary-button"
              onClick={handleRepoPicker}
              type="button"
            >
              Pick folder
            </button>
          </div>
          <div className="repo-form">
            <input
              className="text-input"
              placeholder="/Users/me/project"
              value={repoPathInput}
              onChange={(event) => setRepoPathInput(event.target.value)}
            />
            <button
              className="primary-button"
              disabled={!repoPathInput || createRepoMutation.isPending}
              onClick={submitRepo}
              type="button"
            >
              Add repo
            </button>
          </div>
          <div className="repo-list">
            {repos.length === 0 ? (
              <p className="empty-inline">
                No repos added yet. Discovery still works from Codex session metadata.
              </p>
            ) : (
              repos.map((repo: Repo) => (
                <div key={repo.id} className="repo-row">
                  <div>
                    <strong>{repo.name}</strong>
                    <span>{repo.absolutePath}</span>
                  </div>
                  <small>{repo.defaultBranch ?? "git repo"}</small>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderMainView() {
    switch (view) {
      case "today":
        return renderTodayView();
      case "archives":
        return renderArchivesView();
      case "settings":
        return renderSettingsView();
      default:
        return renderTodayView();
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <SupermanLogo />
        </div>

        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              key={item.value}
              className={view === item.value ? "nav-item active" : "nav-item"}
              aria-label={item.label}
              onClick={() => setView(item.value)}
              title={item.label}
              type="button"
            >
              <span className="nav-icon">{navIcon(item.value)}</span>
            </button>
          ))}
        </nav>

      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Command center</p>
            <h2>
              {view === "today"
                ? "Today"
                : view === "archives"
                    ? "Archives"
                    : "Settings"}
            </h2>
          </div>
          <div className="page-header-status">
            <button
              className="secondary-button"
              onClick={() => discoverMutation.mutate()}
              type="button"
            >
              Refresh discovery
            </button>
          </div>
        </header>

        {errorText ? <div className="banner error">{errorText}</div> : null}
        {handoffResult ? (
          <div className="banner success">
            Handoff exported to <code>{handoffResult.markdownPath}</code> and{" "}
            <code>{handoffResult.jsonPath}</code>.
          </div>
        ) : null}

        {renderMainView()}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
