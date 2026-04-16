import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLocalSessionDetails } from "./local-sessions.js";

function writeSessionFile(
  codexRoot: string,
  relativePath: string,
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
) {
  const filePath = path.join(codexRoot, "sessions", relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: "2026-04-16T06:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-04-16T06:00:00.000Z",
          cwd: "/tmp/project",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T06:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: userMessage,
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T06:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: assistantMessage,
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

test("discoverLocalSessionDetails uses real session files even when the index is stale", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "superman-codex-home-"));
  const previous = process.env.SUPERMAN_CODEX_HOME;

  try {
    process.env.SUPERMAN_CODEX_HOME = tempRoot;

    writeFileSync(
      path.join(tempRoot, "session_index.jsonl"),
      `${JSON.stringify({
        id: "019d1b5a-cd87-7023-b2e5-19d0a0d566fd",
        thread_name: "old indexed session",
        updated_at: "2026-03-24T14:41:03.146859Z",
      })}\n`,
      "utf8",
    );

    const olderFile = writeSessionFile(
      tempRoot,
      "2026/03/24/rollout-2026-03-24T14-41-03-019d1b5a-cd87-7023-b2e5-19d0a0d566fd.jsonl",
      "019d1b5a-cd87-7023-b2e5-19d0a0d566fd",
      "Old session request",
      "Old session summary",
    );
    const freshFile = writeSessionFile(
      tempRoot,
      "2026/04/16/rollout-2026-04-16T11-59-47-019d94fb-40d1-7ec1-9eef-4f28d7c2dc0d.jsonl",
      "019d94fb-40d1-7ec1-9eef-4f28d7c2dc0d",
      "Current session request",
      "Current session summary",
    );

    utimesSync(olderFile, new Date("2026-03-24T14:41:03.146Z"), new Date("2026-03-24T14:41:03.146Z"));
    utimesSync(freshFile, new Date("2026-04-16T08:56:23.000Z"), new Date("2026-04-16T08:56:23.000Z"));

    const sessions = discoverLocalSessionDetails(10);

    assert.equal(sessions[0]?.session.id, "codex:019d94fb-40d1-7ec1-9eef-4f28d7c2dc0d");
    assert.equal(
      sessions.some(
        (detail) => detail.session.id === "codex:019d94fb-40d1-7ec1-9eef-4f28d7c2dc0d",
      ),
      true,
    );
    assert.match(sessions[0]?.session.summary ?? "", /Current session summary/);
  } finally {
    if (previous === undefined) {
      delete process.env.SUPERMAN_CODEX_HOME;
    } else {
      process.env.SUPERMAN_CODEX_HOME = previous;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
