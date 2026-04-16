import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverClaudeSessionDetails } from "./claude-sessions.js";

test("discoverClaudeSessionDetails reads project transcripts and active sessions", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "superman-claude-home-"));
  const previous = process.env.SUPERMAN_CLAUDE_HOME;

  try {
    process.env.SUPERMAN_CLAUDE_HOME = tempRoot;
    mkdirSync(path.join(tempRoot, "projects", "-tmp-project"), { recursive: true });
    mkdirSync(path.join(tempRoot, "sessions"), { recursive: true });

    const sessionId = "13427fae-2136-4375-a1c1-ad698bc0bec8";
    const filePath = path.join(
      tempRoot,
      "projects",
      "-tmp-project",
      `${sessionId}.jsonl`,
    );

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "user",
          sessionId,
          timestamp: "2026-04-16T07:55:56.133Z",
          cwd: "/tmp/project",
          gitBranch: "main",
          message: {
            role: "user",
            content: [{ type: "text", text: "Investigate why tests are failing" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          timestamp: "2026-04-16T07:56:30.133Z",
          cwd: "/tmp/project",
          gitBranch: "main",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I am checking the test runner output now." }],
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      path.join(tempRoot, "sessions", "53070.json"),
      JSON.stringify({
        pid: 53070,
        sessionId,
        cwd: "/tmp/project",
        startedAt: 1776326152002,
        kind: "interactive",
        entrypoint: "cli",
      }),
      "utf8",
    );

    utimesSync(filePath, new Date("2026-04-16T08:56:23.000Z"), new Date("2026-04-16T08:56:23.000Z"));

    const sessions = discoverClaudeSessionDetails(10);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.session.id, `claude:${sessionId}`);
    assert.equal(sessions[0]?.session.provider, "claude");
    assert.equal(sessions[0]?.session.status, "running");
    assert.match(sessions[0]?.session.summary ?? "", /checking the test runner output/i);
  } finally {
    if (previous === undefined) {
      delete process.env.SUPERMAN_CLAUDE_HOME;
    } else {
      process.env.SUPERMAN_CLAUDE_HOME = previous;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
