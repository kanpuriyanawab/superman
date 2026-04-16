# Superman

Superman is a local-first macOS desktop app for supervising agent sessions running on your machine.

It is not a task tracker or IDE. The current product shape is:
- discover local Codex and Claude Code sessions
- compress them into a low-noise control plane
- show only what needs attention
- let you jump back into the right terminal session fast

## Current Status

This repo is an active prototype.

What works today:
- macOS desktop app via Tauri
- local orchestrator service
- Codex session discovery from `~/.codex`
- Claude Code session discovery from `~/.claude`
- session summaries with local Ollama fallback/enrichment
- active session view plus archives
- native `Open in terminal` action for resuming sessions

What is still rough:
- summarization quality is still being tuned
- some UX flows are intentionally incomplete
- the app is optimized for local development, not packaging/distribution yet

## Monorepo Layout

```text
apps/desktop/              React + Vite UI
apps/desktop/src-tauri/    Tauri Rust host
services/orchestrator/     Local TypeScript backend
packages/shared-types/     Shared contracts used by desktop + orchestrator
CLAUDE.md                  Repo guidance for Claude Code
AGENTS.md                  Repo guidance for Codex/agents
superman_build_spec.md     Original product/build spec
```

## Prerequisites

Minimum:
- macOS
- Node.js 20+
- `pnpm` 10+
- Rust toolchain
- Xcode Command Line Tools

Useful optional dependencies:
- Codex CLI installed and authenticated
- Claude Code installed and authenticated
- Ollama installed locally
- `qwen3.5:4b` pulled into Ollama if you want local summary generation

Install core tooling:

```bash
# Node / pnpm
corepack enable
corepack prepare pnpm@10.33.0 --activate

# Rust
curl https://sh.rustup.rs -sSf | sh
rustup default stable

# Xcode CLI tools
xcode-select --install
```

## Install

From the repo root:

```bash
pnpm install
```

## How Superman Works

At runtime there are 3 pieces:

1. `apps/desktop`
   React UI rendered by Vite in dev.

2. `apps/desktop/src-tauri`
   Native Tauri host.
   It starts the local orchestrator automatically, owns tray/notifications, and handles native actions like opening Terminal.

3. `services/orchestrator`
   Local backend on `http://127.0.0.1:4317`.
   It discovers sessions, summarizes them, serves HTTP/SSE, and stores local state.

## Local Data and Discovery

Superman reads and writes local state in a few places:

- Codex sessions:
  - `~/.codex/sessions/...`
  - `~/.codex/session_index.jsonl` may exist, but real session files are the main source

- Claude Code sessions:
  - `~/.claude/projects/...`
  - `~/.claude/sessions/...`

- Superman local state:
  - by default: `~/.superman`
  - in Tauri dev from this repo: `.superman-dev/`

Inside Superman state you will see things like:
- cached summaries
- exported handoffs
- SQLite operational data for supervised runs

## Running the App

### Recommended dev workflow

Run these in two terminals from the repo root.

Terminal 1:

```bash
pnpm --filter @superman/desktop dev
```

Terminal 2:

```bash
pnpm --filter @superman/desktop exec tauri dev --no-watch
```

What this does:
- Terminal 1 starts the Vite frontend
- Terminal 2 starts the native Tauri app
- the Tauri host starts the local orchestrator automatically

### Alternative commands

Run orchestrator only:

```bash
pnpm --filter @superman/orchestrator dev
```

Run desktop web UI only:

```bash
pnpm --filter @superman/desktop dev
```

Run native Tauri from inside the desktop package:

```bash
cd apps/desktop
pnpm tauri:dev
```

## Simulator Mode vs Live Mode

Superman can run in two modes.

### Live mode

Used when Codex app-server / real local agent tooling is available.

Expected behavior:
- discover real Codex sessions
- discover real Claude Code sessions
- show current sessions in `Today`

### Simulator mode

Useful when you want deterministic behavior or don’t have live agent infrastructure working.

Force simulator mode:

```bash
SUPERMAN_FORCE_SIMULATOR=1 pnpm --filter @superman/desktop exec tauri dev --no-watch
```

The simulator is mainly useful for orchestrator-driven demo flows. The current session-first UI is mostly centered on discovered local sessions.

## Ollama Summaries

Superman can use Ollama for local summarization.

Expected endpoint:

```text
http://127.0.0.1:11434/api/chat
```

Expected model:

```text
qwen3.5:4b
```

Default behavior:
- uses `stream: false`
- uses `think: false`
- caches summaries so the model is not hit on every paint

You can override endpoint/model with env vars:

```bash
SUPERMAN_OLLAMA_ENDPOINT=http://127.0.0.1:11434/api/chat
SUPERMAN_OLLAMA_MODEL=qwen3.5:4b
```

Quick sanity check:

```bash
curl http://127.0.0.1:11434/api/chat \
  -d '{
    "model": "qwen3.5:4b",
    "stream": false,
    "think": false,
    "messages": [{"role":"user","content":"hello"}]
  }'
```

## Using the App

Current main views:
- `Today`
  - active sessions discovered on your machine
- `Archives`
  - older sessions moved out of the active queue
- `Settings`
  - repo connection and local config

Typical workflow:

1. Start the app.
2. Click `Refresh discovery`.
3. Wait a few seconds for session summaries to populate.
4. Select a session in `Today`.
5. Read:
   - `At a glance`
   - `Next action`
   - `Summary`
6. Click `Open in terminal` to resume the underlying Codex or Claude session.

## Build / Test Commands

From repo root:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Targeted commands:

```bash
pnpm --filter @superman/shared-types build
pnpm --filter @superman/orchestrator build
pnpm --filter @superman/orchestrator typecheck
pnpm --filter @superman/orchestrator test
pnpm --filter @superman/desktop build
pnpm --filter @superman/desktop typecheck
pnpm --filter @superman/desktop test
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Environment Variables

Common ones:

```bash
# Orchestrator port
SUPERMAN_ORCHESTRATOR_PORT=4317

# Local Superman state root
SUPERMAN_HOME=/path/to/custom-superman-home

# Force simulator mode
SUPERMAN_FORCE_SIMULATOR=1

# Ollama
SUPERMAN_OLLAMA_ENDPOINT=http://127.0.0.1:11434/api/chat
SUPERMAN_OLLAMA_MODEL=qwen3.5:4b
```

## Troubleshooting

### 1. App window opens but nothing loads

Check:

```bash
curl -s http://127.0.0.1:4317/health
```

If that fails:
- Tauri may not have started the orchestrator
- port `4317` may already be taken
- restart both dev terminals

### 2. Sessions are missing

First:
- click `Refresh discovery`

Then verify the expected local folders exist:
- `~/.codex/sessions`
- `~/.claude/projects`

Important:
- sessions older than 3 days are intentionally moved to `Archives`

### 3. Open in terminal does nothing

Restart the Tauri app, not just the Vite frontend:

```bash
pnpm --filter @superman/desktop exec tauri dev --no-watch
```

If it still fails, likely causes are:
- Terminal automation permissions on macOS
- missing `codex` or `claude` on PATH for Terminal
- AppleScript failure

### 4. Summaries look stale or bad

Expected causes:
- cached summaries from an older prompt version
- Ollama not running
- session is too new and fallback summary is still shown

Try:
- restart the app
- click `Refresh discovery`
- verify Ollama responds locally

### 5. Tauri build fails

Check:
- Rust installed correctly
- Xcode Command Line Tools installed
- no stale `tauri dev` process is still running

## Notes for Contributors

- Use `apply_patch` for manual edits.
- Prefer `rg` for search.
- Update `packages/shared-types` before changing dependent app/service contracts.
- Do not assume the README is a product spec; the source of original intent is `superman_build_spec.md`.
- The current product has diverged from the original work-item-centric spec toward a session-first control plane.

## Relevant Files

- [apps/desktop/src/App.tsx](./apps/desktop/src/App.tsx)
- [apps/desktop/src/styles.css](./apps/desktop/src/styles.css)
- [apps/desktop/src/lib/tauri.ts](./apps/desktop/src/lib/tauri.ts)
- [apps/desktop/src-tauri/src/main.rs](./apps/desktop/src-tauri/src/main.rs)
- [services/orchestrator/src/app.ts](./services/orchestrator/src/app.ts)
- [services/orchestrator/src/summaries/session-insights.ts](./services/orchestrator/src/summaries/session-insights.ts)
- [services/orchestrator/src/discovery/local-sessions.ts](./services/orchestrator/src/discovery/local-sessions.ts)
- [services/orchestrator/src/discovery/claude-sessions.ts](./services/orchestrator/src/discovery/claude-sessions.ts)
- [packages/shared-types/src/index.ts](./packages/shared-types/src/index.ts)

