import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { CreateRepoInput, CreateWorkItemInput, ResolveApprovalInput, Settings } from "@superman/shared-types";
import { SupermanApp } from "./app.js";

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export function createHttpServer(app: SupermanApp, port = 4317) {
  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      writeJson(res, 404, { error: "Not found." });
      return;
    }
    if (req.method === "OPTIONS") {
      writeJson(res, 200, {});
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${port}`}`);

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, app.getHealth());
        return;
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        writeJson(res, 200, app.getSettings());
        return;
      }

      if (req.method === "PATCH" && url.pathname === "/settings") {
        const input = await readJson<Partial<Settings>>(req);
        writeJson(res, 200, app.patchSettings(input));
        return;
      }

      if (req.method === "GET" && url.pathname === "/repos") {
        writeJson(res, 200, app.listRepos());
        return;
      }

      if (req.method === "POST" && url.pathname === "/repos/validate") {
        const input = await readJson<CreateRepoInput>(req);
        writeJson(res, 200, app.validateRepo(input));
        return;
      }

      if (req.method === "POST" && url.pathname === "/repos") {
        const input = await readJson<CreateRepoInput>(req);
        writeJson(res, 201, app.createRepo(input));
        return;
      }

      if (req.method === "GET" && url.pathname === "/work-items") {
        writeJson(res, 200, app.listWorkItems());
        return;
      }

      if (req.method === "GET" && url.pathname === "/sessions") {
        writeJson(res, 200, app.listSessions());
        return;
      }

      if (req.method === "GET" && url.pathname === "/queue") {
        writeJson(res, 200, app.listQueueEntities());
        return;
      }

      if (req.method === "POST" && url.pathname === "/sessions/discover") {
        writeJson(res, 200, app.discoverSessions());
        return;
      }

      if (req.method === "GET" && /^\/queue\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/")[2];
        const detail = await app.getQueueEntityDetail(id);
        if (!detail) {
          writeJson(res, 404, { error: "Queue entity not found." });
          return;
        }
        writeJson(res, 200, detail);
        return;
      }

      if (req.method === "GET" && /^\/sessions\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/")[2];
        const detail = await app.getSessionDetail(id);
        if (!detail) {
          writeJson(res, 404, { error: "Session not found." });
          return;
        }
        writeJson(res, 200, detail);
        return;
      }

      if (req.method === "POST" && /^\/sessions\/[^/]+\/steer$/.test(url.pathname)) {
        const id = url.pathname.split("/")[2];
        const input = await readJson<{ instruction: string }>(req);
        writeJson(res, 200, await app.steerSession(id, input.instruction));
        return;
      }

      if (req.method === "POST" && /^\/sessions\/[^/]+\/export$/.test(url.pathname)) {
        const id = url.pathname.split("/")[2];
        writeJson(res, 200, await app.exportSession(id));
        return;
      }

      if (req.method === "POST" && url.pathname === "/work-items") {
        const input = await readJson<CreateWorkItemInput>(req);
        writeJson(res, 201, await app.createWorkItem(input));
        return;
      }

      if (req.method === "GET" && /^\/work-items\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/")[2];
        const detail = app.getWorkItemDetail(id);
        if (!detail) {
          writeJson(res, 404, { error: "Work item not found." });
          return;
        }
        writeJson(res, 200, detail);
        return;
      }

      if (
        req.method === "POST" &&
        /^\/work-items\/[^/]+\/steer$/.test(url.pathname)
      ) {
        const id = url.pathname.split("/")[2];
        const input = await readJson<{ instruction: string }>(req);
        writeJson(res, 200, await app.steerWorkItem(id, input.instruction));
        return;
      }

      if (
        req.method === "POST" &&
        /^\/work-items\/[^/]+\/export$/.test(url.pathname)
      ) {
        const id = url.pathname.split("/")[2];
        writeJson(res, 200, await app.exportWorkItem(id));
        return;
      }

      if (req.method === "GET" && url.pathname === "/approvals") {
        writeJson(res, 200, app.listApprovals());
        return;
      }

      if (
        req.method === "POST" &&
        /^\/approvals\/[^/]+\/resolve$/.test(url.pathname)
      ) {
        const id = url.pathname.split("/")[2];
        const input = await readJson<ResolveApprovalInput>(req);
        writeJson(res, 200, await app.resolveApproval(id, input));
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(`event: connected\ndata: {"ok":true}\n\n`);
        const unsubscribe = app.bus.subscribe((payload) => {
          res.write(payload);
        });
        req.on("close", unsubscribe);
        return;
      }

      writeJson(res, 404, { error: "Not found." });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected server error.";
      writeJson(res, 500, { error: message });
    }
  });

  return {
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve());
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
