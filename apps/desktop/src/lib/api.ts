import type {
  ApprovalRequest,
  CreateRepoInput,
  CreateWorkItemInput,
  HealthStatus,
  QueueEntity,
  QueueEntityDetail,
  Repo,
  ResolveApprovalInput,
  SessionDetail,
  SessionRecord,
  Settings,
  WorkItem,
  WorkItemDetail,
} from "@superman/shared-types";

const API_BASE = "http://127.0.0.1:4317";

type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(
  pathname: string,
  init?: JsonRequestInit,
): Promise<T> {
  const body =
    init?.body === undefined ? undefined : JSON.stringify(init.body);
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    body,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthStatus>("/health"),
  settings: () => request<Settings>("/settings"),
  patchSettings: (body: Partial<Settings>) =>
    request<Settings>("/settings", { method: "PATCH", body }),
  repos: () => request<Repo[]>("/repos"),
  validateRepo: (body: CreateRepoInput) =>
    request<{ ok: boolean; reason?: string }>("/repos/validate", {
      method: "POST",
      body,
    }),
  createRepo: (body: CreateRepoInput) =>
    request<Repo>("/repos", { method: "POST", body }),
  queue: () => request<QueueEntity[]>("/queue"),
  queueDetail: (id: string) => request<QueueEntityDetail>(`/queue/${id}`),
  sessions: () => request<SessionRecord[]>("/sessions"),
  discoverSessions: () => request<SessionRecord[]>("/sessions/discover", { method: "POST" }),
  sessionDetail: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  steerSession: (id: string, instruction: string) =>
    request<SessionDetail | null>(`/sessions/${id}/steer`, {
      method: "POST",
      body: { instruction },
    }),
  exportSession: (id: string) =>
    request<{
      markdownPath: string;
      jsonPath: string;
      copyText: string;
      bundle: unknown;
    }>(`/sessions/${id}/export`, { method: "POST" }),
  workItems: () => request<WorkItem[]>("/work-items"),
  createWorkItem: (body: CreateWorkItemInput) =>
    request<WorkItemDetail>("/work-items", { method: "POST", body }),
  workItemDetail: (id: string) => request<WorkItemDetail>(`/work-items/${id}`),
  steerWorkItem: (id: string, instruction: string) =>
    request<WorkItemDetail>(`/work-items/${id}/steer`, {
      method: "POST",
      body: { instruction },
    }),
  approvals: () => request<ApprovalRequest[]>("/approvals"),
  resolveApproval: (id: string, body: ResolveApprovalInput) =>
    request<ApprovalRequest>(`/approvals/${id}/resolve`, {
      method: "POST",
      body,
    }),
  exportWorkItem: (id: string) =>
    request<{
      markdownPath: string;
      jsonPath: string;
      copyText: string;
      bundle: unknown;
    }>(`/work-items/${id}/export`, { method: "POST" }),
  eventsUrl: () => `${API_BASE}/events`,
};
