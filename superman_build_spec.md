# Superman — Build Specification

## 1. Product Overview

**Superman** is a local-first supervisor layer for Codex-powered work on macOS.

It is not a task tracker, IDE, or Codex replacement.

It sits above Codex execution and turns parallel agent work into a low-noise, task-centric operating surface for humans.

### Core outcome
Superman should let one person or a small team run multiple Codex-backed work streams in parallel without holding all execution context in their head.

### MVP promise
A user can:
- connect a local repo
- create a work item
- launch one or more Codex-backed runs
- let those runs work in parallel
- receive only meaningful interruptions
- review approvals in one place
- export a portable handoff bundle

## 2. Problem Statement

As Codex usage increases, the execution bottleneck shifts from code generation to human supervision.

The pain is not that Codex cannot do enough. The pain is that humans must still:
- remember why each agent is working on something
- track what changed across multiple threads
- notice blockers and approvals in time
- coordinate handoffs across people and Codex accounts
- reconstruct state from scattered terminals, branches, diffs, and chat transcripts

This creates:
- attention fragmentation
- context fragmentation
- manager blind spots
- duplicated effort
- poor handoffs

Superman solves this by providing a **shared control plane for local Codex work**.

## 3. Product Principles

1. **Task-centric, not thread-centric**  
   The main unit in the UI is a work item, not a chat thread.

2. **Low-noise by default**  
   The product should suppress raw streams and surface only meaningful deltas.

3. **Local-first**  
   Everything should run on the user’s Mac with local persistence.

4. **Codex-native**  
   Reuse Codex app-server and Codex CLI behavior instead of reimplementing execution.

5. **Reviewable and resumable**  
   Every work item should be easy to inspect, resume, fork, or hand off.

6. **Portable context**  
   Sharing should happen through compressed state and handoff bundles, not raw transcript dumps.

## 4. Target Users

### Primary
- Heavy Codex CLI users
- Staff / lead engineers
- founders / technical builders running multiple work streams

### Secondary
- small teams using Codex independently but needing coordination
- managers who need selective visibility rather than full transcript access

## 5. MVP Scope

### In scope
- local tray / menu bar app
- local command center window
- one-repo connection flow
- create work item
- launch one or more Codex-backed runs
- compress execution into four states: `running`, `needs_me`, `blocked`, `ready`
- approval queue
- handoff export
- all core user journeys supported in local mode

### Out of scope for MVP
- full Jira/Asana sync
- real-time multi-user collaboration backend
- cloud sync
- distributed auth between multiple machines
- advanced analytics
- deep IDE embedding
- cross-repo orchestration

## 6. Success Criteria

A successful MVP demo should show:
1. user connects a repo
2. user creates 3 work items
3. Codex-backed runs start for each
4. menu bar stays quiet unless action is needed
5. at least one run enters `needs_me`
6. at least one run enters `blocked`
7. at least one run enters `ready`
8. user opens approval queue and resolves one approval
9. user exports a handoff bundle for one task

## 7. Core Concepts

### 7.1 Work Item
A human-defined unit of intent.

Fields:
- id
- title
- description
- desired outcome / done criteria
- repo_id
- status
- priority
- risk_level
- created_at
- updated_at
- owner_type (`human`, `agent`, `mixed`)
- current_summary
- current_blocker
- next_human_action
- latest_checkpoint_id

### 7.2 Agent Run
A Codex-backed execution thread attached to a work item.

Fields:
- id
- work_item_id
- codex_thread_id
- codex_turn_id (nullable)
- cwd
- model
- sandbox_policy
- approval_policy
- status
- started_at
- updated_at
- last_event_at
- branch_name (nullable)
- worktree_path (nullable)

### 7.3 Checkpoint
A compressed, meaningful state update generated from raw agent events.

Fields:
- id
- work_item_id
- agent_run_id
- type (`progress`, `approval_needed`, `blocked`, `ready_for_review`, `completed`, `error`)
- summary
- evidence
- raw_event_refs
- created_at

### 7.4 Approval Request
A user-actionable prompt surfaced from Codex app-server.

Fields:
- id
- work_item_id
- agent_run_id
- codex_thread_id
- codex_turn_id
- kind (`command`, `network`, `file_change`, `tool_input`)
- prompt_summary
- reason
- available_decisions
- raw_payload
- status (`pending`, `approved`, `rejected`, `expired`)
- created_at
- resolved_at

### 7.5 Handoff Bundle
A portable export representing the state of a work item.

Fields:
- work_item metadata
- current summary
- repo path
- branch / worktree info
- goals
- constraints
- decisions made
- blockers
- artifacts
- next recommended prompt
- transcript excerpt references

## 8. UX Model

Superman has **two primary surfaces** and one lightweight export flow.

### 8.1 Menu Bar / Tray Surface
Purpose: ambient awareness and interruption routing.

It answers one question:
**Do I need to look right now?**

It should show:
- total active items
- count of `needs_me`
- count of `blocked`
- count of `ready`

Clicking the tray opens a popover with:
- Needs me now
- Blocked
- Ready for review
- Open command center

### 8.2 Command Center Window
Purpose: full task-centric control.

Primary sections:
- Today / Triage
- Work Items board
- Work Item detail
- Approval queue
- Handoffs / exports
- Settings / repo connections

### 8.3 Handoff Export Flow
Purpose: compress current state into a shareable artifact.

Output formats:
- markdown file
- JSON file
- copy-to-clipboard summary

## 9. Core User Journeys

## Journey A — First Run / Connect Repo
1. User opens Superman.
2. User clicks “Connect repo”.
3. User selects a local folder.
4. App validates that folder exists and is a git repo.
5. App stores repo record locally.
6. App shows empty work board with CTA to create first work item.

## Journey B — Create Work Item
1. User clicks “New work item”.
2. User enters:
   - title
   - objective
   - done criteria
   - optional constraints
   - priority
3. User chooses execution mode:
   - single Codex run
   - parallel runs (2–3 variants)
4. User submits.
5. Superman creates a local work item record.
6. Superman launches one or more Codex-backed runs for the repo.

## Journey C — Parallel Work Without Constant Interruptions
1. Codex runs execute in background.
2. Superman receives raw events.
3. Superman compresses them into checkpoints.
4. Tray remains quiet unless a work item enters:
   - `needs_me`
   - `blocked`
   - `ready`
5. The board updates continuously.

## Journey D — Resolve Approval
1. A Codex run emits an approval request.
2. Superman converts raw approval payload into a human-readable approval card.
3. Tray badge increments.
4. User opens approval queue.
5. User sees:
   - what the agent was trying to do
   - why approval is needed
   - risk summary
   - decision buttons
6. User approves or rejects.
7. Superman sends approval response back to Codex app-server.
8. Work item status updates.

## Journey E — Review a Ready Task
1. Work item transitions to `ready`.
2. Tray shows one ready item.
3. User opens work item detail.
4. User sees:
   - short summary
   - files changed
   - tests run
   - unresolved issues
   - suggested next action
5. User can mark as done, resume, or export handoff.

## Journey F — Resume / Steer a Running Task
1. User opens work item detail.
2. User clicks “Resume / Steer”.
3. User enters new instruction.
4. Superman appends instruction via Codex turn steering or new turn.
5. Work item timeline records the intervention.

## Journey G — Export Handoff
1. User opens work item detail.
2. Clicks “Export handoff”.
3. Superman generates a structured markdown bundle.
4. User saves file or copies to clipboard.
5. Another human / Codex account can use that bundle to resume work.

## 10. Information Architecture

### 10.1 Main Navigation
- Today
- Work Items
- Approvals
- Handoffs
- Settings

### 10.2 Today Screen
Sections:
- Needs me now
- Running silently
- Blocked
- Ready for review

Each card shows:
- title
- repo
- current state
- one-line summary
- time since last update
- next action

### 10.3 Work Items Screen
Board or table view.

Columns:
- Running
- Needs Me
- Blocked
- Ready
- Done (optional collapsed)

Controls:
- filter by repo
- filter by priority
- filter by status
- search
- sort by last update

### 10.4 Work Item Detail
Tabs:
- Summary
- Timeline
- Approvals
- Artifacts
- Handoff

#### Summary tab
- title
- objective
- done criteria
- latest status
- current summary
- next human action
- linked runs

#### Timeline tab
- chronological checkpoints
- raw event snippets when expanded
- steering history

#### Approvals tab
- pending approvals
- resolved approvals

#### Artifacts tab
- changed files
- output snippets
- branch / worktree metadata
- exportable summary

#### Handoff tab
- generated handoff preview
- export buttons

### 10.5 Approvals Screen
Queue of pending approvals.

Each approval card shows:
- work item name
- kind
- summary
- reason
- action buttons

### 10.6 Settings Screen
- connected repos
- Codex connection settings
- default model
- default sandbox policy
- default approval policy
- notification preferences
- export preferences

## 11. State Model

Superman uses a derived status model for work items.

### 11.1 Canonical work item states
- `running`
- `needs_me`
- `blocked`
- `ready`
- `done`
- `error`

### 11.2 Derivation rules

#### `needs_me`
Set when any active run has:
- pending command approval
- pending network approval
- pending file change approval
- explicit user-input request
- unresolved high-priority clarification generated by Superman’s classifier

#### `blocked`
Set when:
- run emits a terminal failure with no autonomous recovery
- classifier detects missing requirement / ambiguity / dependency blocker
- run is stalled beyond timeout threshold with no progress checkpoint

#### `ready`
Set when:
- run completes successfully and classifier marks ready for review
- run produces final output with no pending approvals and no blocker

#### `running`
Set when:
- at least one attached run is active
- no approvals pending
- no blocker detected
- not yet ready

## 12. Technical Architecture

## 12.1 High-Level Architecture

```text
[Tauri Tray + Command Center UI]
        |
        | invoke/events
        v
[Tauri Rust Host]
        |
        | local app service bridge
        v
[Superman Local Orchestrator]
        |
        | WebSocket JSON-RPC
        v
[Codex app-server running locally]
        |
        v
[Codex execution in local repo]
```

## 12.2 Components

### A. Tauri Desktop Shell
Responsibilities:
- macOS tray/menu bar integration
- window lifecycle
- native notifications
- secure local persistence hooks
- launching / supervising local orchestrator process if needed

### B. Frontend UI (React + TypeScript)
Responsibilities:
- all visible screens
- local state presentation
- approval controls
- work item creation flows
- handoff preview and export UI

### C. Rust Host Layer
Responsibilities:
- expose Tauri commands to frontend
- manage window/tray interactions
- optionally spawn local orchestrator subprocess
- relay events from backend to frontend
- keep app single-instance

### D. Local Orchestrator Service
Responsibilities:
- maintain WebSocket connection to Codex app-server
- create/resume threads
- start and steer turns
- ingest raw Codex events
- map raw events to derived checkpoints
- maintain work item store
- manage approval workflow state
- produce handoff bundles

### E. Persistence Layer
Responsibilities:
- store work items, runs, checkpoints, approvals, repo metadata, settings
- restore state across restarts

## 13. Recommended Tech Stack

### Desktop shell
- Tauri v2
- Rust host
- tray icon + menu
- notification plugin
- store plugin or SQLite

### Frontend
- React
- TypeScript
- Vite
- TanStack Query or Zustand for UI state
- Tailwind for styling
- shadcn/ui for components

### Local backend/orchestrator
Two viable options:

#### Option 1 — Node/TypeScript orchestrator (recommended for hackathon)
Pros:
- fast iteration
- easy WebSocket + JSON-RPC client implementation
- shared types with frontend
- easier prompt/JSON schema handling

Cons:
- one more process to supervise

#### Option 2 — Rust-only backend inside Tauri
Pros:
- fewer moving pieces
- native performance

Cons:
- slower product iteration for hackathon
- more friction for JSON-heavy app-server client implementation

### Recommendation
Use:
- **Tauri + React frontend**
- **Node/TypeScript local orchestrator**
- **Codex app-server over local WebSocket**

## 14. Why Codex app-server instead of shelling directly to Codex CLI

Use Codex app-server as the main integration interface because Superman needs:
- thread lifecycle control
- streamed agent events
- approval request handling
- stored thread access
- structured notifications

Shelling directly into the Codex TUI is brittle and terminal-centric.

Codex app-server is a better fit because Superman is a custom rich client.

## 15. Codex Integration Design

## 15.1 Transport
Run `codex app-server` locally with WebSocket transport.

Recommended launch mode:
- `codex app-server --listen ws://127.0.0.1:4500`

Why WebSocket:
- simpler for a local orchestrator written in TypeScript
- good fit for long-lived event stream
- enables independent UI and service lifecycle

## 15.2 Connection Handshake
On app startup:
1. start orchestrator
2. ensure app-server is running or spawn it
3. open WebSocket connection
4. send `initialize`
5. send `initialized`
6. begin listening for notifications

Client metadata should identify Superman clearly.

## 15.3 Thread Model
Each Superman **agent run** maps to one Codex **thread**.

Mapping:
- Work Item → one or more Agent Runs
- Agent Run → one Codex thread
- each steering action → `turn/start` or `turn/steer`

### Recommendation
For MVP, do **one thread per run**.
Do not overload one Codex thread with multiple work items.

## 15.4 Thread Lifecycle
### New run
- call `thread/start`
- persist returned `thread.id`
- immediately call `turn/start` with user task input

### Resume run
- call `thread/resume`
- optionally call `turn/start` with continuation input

### Fork run
- optional MVP+ feature
- call `thread/fork`
- create a new agent run record linked to original work item

## 15.5 Turn Input Design
Every `turn/start` input should be structured.

Template:
1. task title
2. objective
3. done criteria
4. repo context
5. constraints
6. expected output format

For better checkpoint extraction, Superman should ask Codex to produce concise, machine-readable summaries at meaningful boundaries.

## 15.6 Structured Summaries Strategy
Superman should not rely only on raw free-form text.

For major turns, include an instruction that asks Codex to output concise status packets such as:
- current step
- current blocker
- changed files summary
- recommended next action
- readiness classification

If feasible, use `outputSchema` for structured turn outputs where Superman specifically requests a formal status summary.

### Suggested internal schema for structured summaries
```json
{
  "type": "object",
  "properties": {
    "state": {
      "type": "string",
      "enum": ["running", "needs_me", "blocked", "ready"]
    },
    "summary": { "type": "string" },
    "blocker": { "type": ["string", "null"] },
    "next_human_action": { "type": ["string", "null"] },
    "changed_files_summary": {
      "type": "array",
      "items": { "type": "string" }
    },
    "tests_status": { "type": ["string", "null"] }
  },
  "required": ["state", "summary"]
}
```

## 16. Event Ingestion and Classification

## 16.1 Raw Event Sources from app-server
Superman should subscribe to and handle:
- `thread/started`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- approval-related requests
- server request resolution events
- thread archival / state changes

## 16.2 Internal Event Pipeline
```text
Codex Notification
  -> raw event store
  -> event normalizer
  -> classifier / reducer
  -> checkpoint store
  -> work item state update
  -> UI event broadcast
```

## 16.3 Event Normalization
Define a normalized internal event type:

```ts
interface NormalizedEvent {
  id: string;
  source: 'codex';
  threadId: string;
  turnId?: string;
  itemId?: string;
  method: string;
  timestamp: number;
  payload: unknown;
}
```

## 16.4 Classification Rules
Superman should convert raw events into user-facing checkpoints.

### Rules examples
- pending approval request → checkpoint type `approval_needed`, work item status `needs_me`
- final agent message indicating completion → checkpoint type `ready_for_review`, status `ready`
- failed command execution with no retry path → checkpoint type `blocked`, status `blocked`
- ongoing deltas without problem → keep `running`

## 16.5 Stalled Run Detection
A run should be marked `blocked` if:
- it has no meaningful checkpoint for X minutes
- it has emitted an error item
- it is waiting on an unresolved approval beyond threshold

Default threshold for MVP:
- 10 minutes of no meaningful event while still marked active

## 17. Approval Handling Design

## 17.1 Approval Types
Superman must support:
- command execution approvals
- network approvals
- file change approvals
- user input prompts for tools

## 17.2 Approval Queue UX
Every approval should be transformed into:
- concise title
- why this happened
- scope / risk
- original target context
- action buttons

## 17.3 Approval Command Flow
```text
Codex sends approval request
  -> Superman stores pending approval
  -> work item becomes needs_me
  -> tray badge increments
  -> user resolves request
  -> Superman sends decision response
  -> pending approval marked resolved
  -> work item re-derived
```

## 17.4 Approval Safety Defaults
For MVP defaults:
- approval policy: conservative
- sandbox: workspace write only
- network off by default unless user explicitly enables it for the work item

## 18. Handoff Export Design

## 18.1 Export Goals
A handoff bundle should be usable by:
- another human
- another Codex account
- future you tomorrow

## 18.2 Export Content
### Required sections
- work item title
- objective
- done criteria
- repo path
- current status
- summary of what happened
- decisions already made
- blocker or readiness status
- changed files summary
- suggested next prompt
- references to relevant artifacts

### Markdown export template
```md
# Handoff: <title>

## Objective
...

## Done Criteria
...

## Current Status
running | needs_me | blocked | ready

## What Happened
...

## Decisions Made
- ...

## Blockers / Risks
- ...

## Changed Files
- ...

## Recommended Next Prompt
...
```

## 18.3 Export Formats
- `.md`
- `.json`
- clipboard copy

## 19. Persistence Design

## 19.1 Storage Choice
### MVP recommendation
Use **SQLite** for main data and filesystem exports for handoff bundles.

Reason:
- relational records map well to work items / runs / checkpoints / approvals
- easier querying than key-value only
- future-safe if you add analytics / filters

Alternative for hackathon speed:
- JSON files + Tauri Store plugin

### Final recommendation
If time is limited, use:
- Tauri Store for settings
- SQLite for operational data

## 19.2 Suggested tables
- repos
- work_items
- agent_runs
- checkpoints
- approvals
- raw_events
- handoff_exports
- settings

## 20. Repo Connection Design

## 20.1 Connect repo flow
- select directory
- validate exists
- validate git repo
- record root path
- optionally detect current branch
- set as default cwd for new runs

## 20.2 Repo metadata
Store:
- id
- name
- absolute_path
- git_root
- default_branch
- last_used_at

## 21. Launching Codex-backed Runs

## 21.1 Single run
- create work item
- create one agent run
- start thread
- start turn with task payload

## 21.2 Parallel runs
For hackathon, support 2–3 runs max per work item.

Modes:
- `single`
- `parallel_compare`
- `parallel_explore`

### `parallel_compare`
Run 2 agents with same objective but slightly different strategies.

### `parallel_explore`
Run 2–3 agents for different subtasks like:
- investigation
- implementation
- validation

## 21.3 Prompting strategy for parallel runs
Superman should label each run clearly.
Examples:
- Variant A — implementation-first
- Variant B — test-first
- Validator — review changed files and run tests

## 22. Command Center UI Components

## 22.1 Reusable components
- StatusBadge
- WorkItemCard
- ApprovalCard
- TimelineEntry
- RepoPicker
- RunChip
- StateFilterBar
- HandoffPreview

## 22.2 Tray components
- TrayStatusIcon
- TrayPopoverSummary
- TrayActionRow

## 23. Tauri App Design

## 23.1 Windows
Use at least two windows:
- `main` — command center
- `tray-popover` — small contextual window or tray menu experience

The main window can start hidden and be shown from the tray.

## 23.2 Tray
Tray should support:
- open command center
- show pending approvals count
- quick links to needs-me items
- quit Superman

## 23.3 Native notifications
Use native notifications for:
- new approval needed
- work item ready
- work item blocked

Do not notify for ordinary running updates.

## 23.4 Single instance
Superman should run as a single instance app.
A second launch should focus the existing window.

## 24. Orchestrator Process Design

## 24.1 Responsibilities
- spawn / connect to Codex app-server
- maintain one durable WebSocket connection
- keep thread-to-work-item mapping
- handle reconnection
- write raw events to DB
- emit higher-level state changes to UI

## 24.2 Process supervision
Recommended approach:
- Tauri launches orchestrator as a child process on startup
- Rust host monitors child lifecycle
- on crash, show UI error and allow restart

## 24.3 IPC between Tauri and orchestrator
Choose one:

### Preferred MVP choice
- orchestrator runs local HTTP server on localhost for commands
- orchestrator also exposes WebSocket or SSE for pushing updates to UI

This keeps UI code simple.

Alternative:
- use Tauri commands only and keep orchestrator embedded in Rust

## 24.4 Suggested local backend API
### Commands
- `POST /repos`
- `GET /repos`
- `POST /work-items`
- `GET /work-items`
- `GET /work-items/:id`
- `POST /work-items/:id/steer`
- `POST /approvals/:id/resolve`
- `POST /work-items/:id/export`

### Stream
- `GET /events` via WebSocket or SSE

## 25. Detailed Codex App-Server Integration Plan

## 25.1 Startup sequence
1. Superman starts.
2. Tauri Rust host ensures orchestrator is running.
3. Orchestrator checks if app-server is reachable at configured port.
4. If not reachable, orchestrator spawns `codex app-server --listen ws://127.0.0.1:4500`.
5. Orchestrator connects.
6. Orchestrator sends `initialize` and `initialized`.
7. App enters ready state.

## 25.2 Create new run sequence
```text
UI -> create work item
Orchestrator -> persist work item
Orchestrator -> thread/start
Orchestrator -> persist thread id
Orchestrator -> turn/start with task input
Orchestrator -> mark run active
Codex -> emits item/started and deltas
Orchestrator -> classify + persist
UI -> update board
```

## 25.3 Approval sequence
```text
Codex -> item/.../requestApproval
Orchestrator -> create pending approval record
Orchestrator -> emit UI event
UI -> render approval card
User -> approve/reject
UI -> local API resolve approval
Orchestrator -> respond to app-server request
Codex -> serverRequest/resolved + item/completed
Orchestrator -> re-derive state
```

## 25.4 Resume / steer sequence
If run is active:
- use `turn/steer`

If run is idle:
- optionally `thread/resume`
- then `turn/start`

## 25.5 Rehydration on app restart
On restart:
- load local DB
- reconnect to app-server
- for active runs, check thread status via `thread/read` or `thread/resume`
- restore UI

## 26. Data Flow Details

## 26.1 Event storage strategy
Persist all raw app-server notifications into `raw_events`.

Why:
- easier debugging
- easier replay during development
- lets you improve classifier later

## 26.2 Derived state reducer
Every new raw event triggers:
1. normalize raw event
2. persist raw event
3. derive run state
4. derive work item state
5. create checkpoint when meaningful
6. emit UI update

## 27. Status Compression Logic

Superman’s main magic is compression.

## 27.1 Inputs to compression
- current run status
- active pending approvals
- recent item/completed events
- structured summary packets
- error items
- inactivity timers

## 27.2 Output
A work item should always have:
- one primary state
- one summary sentence
- one next human action (nullable)

## 27.3 Example compression outputs
### Running
“Implementing auth callback handling in repo settings flow. No action needed.”

### Needs me
“Needs approval to enable network access for package install.”

### Blocked
“Blocked: acceptance criteria for export format are unclear.”

### Ready
“Ready for review: completed handoff export flow and ran unit tests.”

## 28. UI State Management

## 28.1 Frontend state buckets
- persistent server state: work items, approvals, repos
- ephemeral UI state: selected filters, open drawers, selected card
- stream state: latest incoming events

## 28.2 Suggested libraries
- TanStack Query for backend data fetching
- Zustand for ephemeral UI state

## 29. Suggested Project Structure

```text
superman/
  apps/
    desktop/
      src/
        components/
        features/
        pages/
        lib/
      src-tauri/
        src/
        tauri.conf.json
  services/
    orchestrator/
      src/
        codex/
        events/
        db/
        exports/
        prompts/
        routes/
        types/
  packages/
    shared-types/
```

## 30. Prompt Design for Codex-backed Runs

Every work item launch prompt should include:
- role
- task objective
- done criteria
- repo path context
- operating rules
- summary contract

### Base prompt template
```text
You are working inside a local repository managed through Superman.

Work item title: {title}
Objective: {objective}
Done criteria: {done_criteria}
Constraints: {constraints}

Important:
- Work autonomously unless you truly need human input.
- When blocked, state the blocker explicitly.
- When ready for review, say so clearly.
- Keep updates concise and action-oriented.
```

### For structured status checkpoints
Add explicit instructions asking for compact status summaries at milestones.

## 31. Error Handling

## 31.1 app-server not installed / unavailable
UI should show:
- Codex connection failed
- verify `codex` is installed and authenticated
- retry button

## 31.2 app-server overload
If app-server rejects with overload error:
- retry with exponential backoff
- surface warning only if prolonged

## 31.3 thread not found / stale mapping
- mark run degraded
- allow user to reconnect or archive run

## 31.4 orchestrator crash
- show banner in UI
- allow restart orchestrator

## 32. Security / Safety Defaults

- run locally only
- default sandbox should not be full access
- network should be off by default unless task explicitly enables it
- approval queue must show enough context before action
- store only local repo paths and app metadata unless user exports data

## 33. Performance Expectations

For MVP:
- support 5–10 active work items
- support 1–3 runs per item
- event UI update latency under 1 second locally
- tray badge update latency under 1 second

## 34. MVP Build Plan

## Phase 1 — Foundation
- scaffold Tauri app with React
- set up tray and main window
- build repo connection flow
- set up local orchestrator process
- connect to Codex app-server

## Phase 2 — Work Items and Runs
- create DB schema
- create work item CRUD
- launch threads and turns
- store raw events
- render work board

## Phase 3 — Compression and Approvals
- add event classifier
- derive four primary states
- build approvals queue
- implement approval resolution round trip
- add tray badge and notifications

## Phase 4 — Handoff and Polish
- handoff generator
- export actions
- ready-for-review detail page
- resume / steer flow
- end-to-end demo polish

## 35. Acceptance Criteria by Feature

### local tray/menu bar
- tray icon exists
- shows counts for urgent states
- opens command center
- supports quit

### local command center window
- visible board of work items
- navigable detail pages
- approval queue accessible

### create work item
- can create from UI
- persists locally
- appears in board immediately

### connect one repo
- can select local repo
- validates git root
- persists selection

### launch one or more Codex-backed runs
- can start at least one run per work item
- optional 2–3 parallel runs
- mappings stored correctly

### compress updates into four states
- work item always displays one canonical state
- state transitions occur from real app-server events

### approval queue
- pending approvals collected centrally
- can approve/reject from UI
- run continues afterward

### handoff export
- generates markdown handoff
- includes next recommended prompt
- export file saved locally

## 36. Recommended Demo Scenario

Use one local repo.
Create 3 work items:
1. build tray interactions
2. implement approval queue screen
3. add handoff export

Run them in parallel.
Demonstrate:
- one work item silently running
- one needing approval
- one becoming ready for review
- exporting one handoff bundle

## 37. Nice-to-Have After MVP

- compare mode for parallel runs
- per-run worktree support
- timeline playback from raw events
- simple team memory search over past handoffs
- Jira/Asana export
- daily digest view
- keyboard shortcuts for triage

## 38. Final Build Recommendation

For the hackathon, optimize for **clarity of product value**, not total feature count.

The strongest implementation is:
- **Tauri desktop shell for macOS tray + window**
- **React/TypeScript UI**
- **Node/TypeScript local orchestrator**
- **Codex app-server over local WebSocket**
- **SQLite + lightweight local exports**

That gives Superman the right shape:
- native enough to feel like a Mac productivity tool
- local enough to run reliably in a hackathon
- structured enough to grow into a serious product later

---

# Appendix A — Concrete Implementation Notes for the Codex Agent

## Build order for the agent
1. Scaffold Tauri + React app.
2. Add tray, main window, and basic navigation.
3. Build local orchestrator service with health endpoint.
4. Add SQLite schema and repo CRUD.
5. Implement Codex app-server connection manager.
6. Implement work item creation -> thread/start -> turn/start.
7. Implement raw event ingestion and logging.
8. Implement status derivation and board updates.
9. Implement approval queue and resolution flow.
10. Implement handoff export.
11. Polish tray badges, notifications, and review UX.

## Do not do these in MVP
- do not parse terminal TUI output
- do not automate Jira/Asana yet
- do not build cloud sync
- do not support multiple repos at once in first pass
- do not overbuild analytics

## Product quality bar
The product should feel:
- calm
- focused
- interruption-aware
- task-centric
- immediately useful even with one repo and one user

# Appendix B — Suggested Naming in Code

- `WorkItem`
- `AgentRun`
- `Checkpoint`
- `ApprovalRequest`
- `HandoffBundle`
- `CodexConnectionManager`
- `EventReducer`
- `StatusDeriver`
- `HandoffExporter`
- `TrayState`

# Appendix C — Suggested Default Settings

- default model: configurable
- default sandbox: workspace write
- default network access: false
- default approval policy: conservative / ask before risky actions
- default parallel runs per work item: 1
- default tray notification style: urgent only

