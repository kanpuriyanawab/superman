import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type {
  AgentRun,
  ApprovalRequest,
  HealthStatus,
  NormalizedEvent,
  Repo,
  ResolveApprovalInput,
  Settings,
  WorkItem,
} from "@superman/shared-types";
import { buildStructuredOutputSchema, buildTurnInput } from "../domain/prompts.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export interface AdapterRunContext {
  repo: Repo;
  run: AgentRun;
  settings: Settings;
  workItem: WorkItem;
}

export interface ExecutionAdapter {
  readonly kind: "codex" | "simulator";
  start(): Promise<void>;
  createRun(context: AdapterRunContext): Promise<{
    threadId: string | null;
    turnId: string | null;
  }>;
  steerRun(run: AgentRun, instruction: string): Promise<void>;
  resolveApproval(
    approval: ApprovalRequest,
    input: ResolveApprovalInput,
  ): Promise<void>;
  onEvent(callback: (event: NormalizedEvent) => void): void;
  getHealth(): HealthStatus;
}

function createJsonRpcRequest(method: string, params?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id: crypto.randomUUID(),
    method,
    params,
  };
}

export class CodexAdapter implements ExecutionAdapter {
  readonly kind = "codex" as const;
  private socket: WebSocket | null = null;
  private appServerProcess: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventHandler: ((event: NormalizedEvent) => void) | null = null;
  private codexConnected = false;

  constructor(private readonly settings: Settings) {}

  onEvent(callback: (event: NormalizedEvent) => void) {
    this.eventHandler = callback;
  }

  getHealth(): HealthStatus {
    return {
      ok: true,
      adapterKind: "codex",
      codexConnected: this.codexConnected,
      simulatorActive: false,
      message: this.codexConnected
        ? "Connected to Codex app-server."
        : "Codex app-server is starting or unavailable.",
    };
  }

  async start() {
    await this.ensureSocket();
    await this.initialize();
  }

  async createRun(context: AdapterRunContext) {
    const threadResponse = (await this.request("thread/start", {
      cwd: context.repo.absolutePath,
      model: context.settings.defaultModel,
      sandbox: "workspace-write",
      approvalPolicy: context.settings.defaultApprovalPolicy,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })) as {
      thread?: { id: string };
    };

    const threadId = threadResponse.thread?.id ?? null;
    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }

    const turnResponse = (await this.request("turn/start", {
      threadId,
      input: buildTurnInput(
        context.workItem,
        context.repo,
        context.run.label,
        context.settings,
      ),
      cwd: context.repo.absolutePath,
      approvalPolicy: context.settings.defaultApprovalPolicy,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [context.repo.absolutePath],
        readOnlyAccess: { mode: "all" },
        networkAccess: context.settings.defaultNetworkEnabled,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: context.settings.defaultModel,
      outputSchema: buildStructuredOutputSchema(),
    })) as {
      turn?: { id: string };
    };

    return {
      threadId,
      turnId: turnResponse.turn?.id ?? null,
    };
  }

  async steerRun(run: AgentRun, instruction: string) {
    if (!run.codexThreadId) {
      throw new Error("Cannot steer a run without a Codex thread id.");
    }
    if (run.codexTurnId) {
      await this.request("turn/steer", {
        threadId: run.codexThreadId,
        expectedTurnId: run.codexTurnId,
        input: [{ type: "text", text: instruction }],
      });
      return;
    }

    await this.request("turn/start", {
      threadId: run.codexThreadId,
      input: [{ type: "text", text: instruction }],
    });
  }

  async resolveApproval(
    approval: ApprovalRequest,
    input: ResolveApprovalInput,
  ) {
    if (!approval.requestId || !this.socket) {
      return;
    }

    const decision =
      input.decision === "approved"
        ? { decision: "accept" }
        : { decision: "decline" };

    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: approval.requestId,
        result:
          approval.kind === "tool_input"
            ? {
                answers: {
                  response: { answers: [input.responseText || input.decision] },
                },
              }
            : decision,
      }),
    );
  }

  private async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "superman",
        version: "0.1.0",
      },
      protocolVersion: 1,
      capabilities: {},
    });
    this.socket?.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  }

  private async ensureSocket() {
    const endpoint = this.settings.codexEndpoint;
    try {
      await this.openSocket(endpoint);
      return;
    } catch {
      await this.spawnAppServer(endpoint);
      await this.openSocket(endpoint);
    }
  }

  private openSocket(endpoint: string) {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Codex app-server."));
      }, 5_000);

      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.codexConnected = true;
        socket.addEventListener("message", (event) => {
          this.handleMessage(String(event.data));
        });
        socket.addEventListener("close", () => {
          this.codexConnected = false;
        });
        resolve();
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Unable to connect to Codex app-server."));
      });
    });
  }

  private async spawnAppServer(endpoint: string) {
    if (this.appServerProcess) {
      return;
    }

    const listenTarget = endpoint.startsWith("ws://")
      ? endpoint
      : "ws://127.0.0.1:4500";
    this.appServerProcess = spawn(
      "codex",
      ["app-server", "--listen", listenTarget],
      {
        cwd: path.resolve(process.cwd()),
        env: process.env,
        stdio: "pipe",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_250));
  }

  private request(method: string, params?: unknown) {
    if (!this.socket) {
      throw new Error("Codex socket is not connected.");
    }

    const request = createJsonRpcRequest(method, params);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.socket?.send(JSON.stringify(request));
    });
  }

  private handleMessage(raw: string) {
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (payload.id && this.pending.has(payload.id)) {
      const request = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) {
        request?.reject(payload.error);
      } else {
        request?.resolve(payload.result);
      }
      return;
    }

    const threadId =
      payload.params?.threadId ??
      payload.params?.thread?.id ??
      payload.params?.item?.threadId ??
      "unknown";
    if (!payload.method || !this.eventHandler) {
      return;
    }

    this.eventHandler({
      id: crypto.randomUUID(),
      source: "codex",
      threadId,
      turnId: payload.params?.turnId,
      itemId: payload.params?.itemId ?? payload.params?.item?.id,
      method: payload.method,
      timestamp: Date.now(),
      payload: payload.params,
    });
  }
}
