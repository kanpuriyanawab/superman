# Repository Guidelines

## Project Structure & Module Organization
This repository is a `pnpm` workspace with three packages:

- `apps/desktop`: React 19 + Vite desktop UI, plus the Tauri wrapper in `apps/desktop/src-tauri`.
- `services/orchestrator`: TypeScript backend/orchestration logic in `services/orchestrator/src`.
- `packages/shared-types`: shared TypeScript types exported from `packages/shared-types/src`.

Build outputs go to `*/dist` and should not be edited manually. Tests currently live beside source files as `*.test.ts`, mainly under `services/orchestrator/src`.

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies.
- `pnpm dev`: start the orchestrator and desktop app together for local development.
- `pnpm build`: build all workspace packages recursively.
- `pnpm test`: run all package tests.
- `pnpm lint`: run the repo’s TypeScript validation step.
- `pnpm typecheck`: run strict type-checking across the workspace.
- `pnpm --filter @superman/desktop tauri:dev`: run the native desktop shell.

## Coding Style & Naming Conventions
The codebase uses strict TypeScript via `tsconfig.base.json`; keep new code type-safe and ESM-compatible. Follow the existing style:

- 2-space indentation and double quotes.
- `PascalCase` for React components and exported types.
- `camelCase` for functions, variables, and helpers.
- Use descriptive filenames by domain, such as `domain/reducer.ts` or `components/StatusBadge.tsx`.

There is no dedicated ESLint or Prettier config yet, so `pnpm lint` currently means `tsc --noEmit`.

## Testing Guidelines
Use the package-native runners already in place:

- Desktop app: `vitest` via `pnpm --filter @superman/desktop test`
- Orchestrator: Node’s built-in test runner via `pnpm --filter @superman/orchestrator test`

Name tests `*.test.ts` and keep them close to the code they cover. Favor small, deterministic unit tests around reducers, session discovery, and shared utilities before adding broader integration coverage.

## Commit & Pull Request Guidelines
Git history is minimal (`Initial commit`), so no strong commit convention is established yet. Use short, imperative commit subjects and include a workspace hint when helpful, for example `orchestrator: improve approval summaries`.

Pull requests should include:

- a brief problem/solution summary,
- linked issue or task reference when available,
- test evidence (`pnpm test`, targeted package test, or manual Tauri verification),
- screenshots for UI changes in `apps/desktop`.

## Contributor Notes
Prefer `rg` for code search, keep generated folders out of manual edits, and update shared contracts in `packages/shared-types` before wiring dependent app or service changes.
