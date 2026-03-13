# NLK Agents Project Goals

## Workspace Isolation (Required)

- `codex-room start` is scoped to the directory where it is launched (`NLK_WORKDIR`).
- Users connected to that room must see only Codex threads/sessions that belong to that exact project directory.
- Do not list, hydrate, resume, or expose threads from other directories, even if a thread id is known.
- Treat cross-project thread visibility as a security/privacy regression.
- Default CLI behavior is dangerous: expand room scope to the enclosing Git repo root when available.
- `--safe` is an explicit opt-in that keeps room scope limited to the exact current directory.

## Current Priorities

- Highest priority: match the documented stable `codex app-server` API and lifecycle. We can use experemental API latter if needed.
- Prefer documented `thread/*`, `turn/*`, and `item/*` notifications over raw or legacy event families when both exist.
- Use `thread/resume` for live continuation of an existing thread; keep `thread/read` for read-only replay and hydration checks.
- Favour correctness and reconnect stability over extra features.
- Diff/file-change UI should stay collapsed by default and avoid duplicate or noisy patch rendering.
- Security findings and follow-up work for room/project isolation must be recorded in `security.md`.

## Roadmap

- Finish stable `app-server` alignment first; experimental features must not weaken the stable chat flow.
- Keep any compatibility code that intentionally preserves a path toward future experimental API adoption, but mark it clearly in code comments and do not let it override the stable protocol path.
- After stable parity, evaluate a guarded opt-in for `persistExtendedHistory` to improve replay and reconnect hydration.
- After stable parity, evaluate `tool/requestUserInput` UX and richer approval/request flows only where they match documented server-request contracts.
- Keep `dynamicTools`, `thread/realtime/*`, plugins, and remote skills out of the main chat path until there is a clear product need and explicit protocol coverage.

## Review Scope

- `review/start` must not silently widen room scope beyond `NLK_WORKDIR`.
- If `codex-room` is started from a Git subdirectory in `--safe` mode and the repo root is wider than `NLK_WORKDIR`, block `review/start` with a clear error instead of letting Codex review sibling directories or generate broken relative paths.
- Default startup already enables repo-wide review from subdirectories by expanding `NLK_WORKDIR` to the Git repo root when available.
- Treat this as both a workspace-isolation rule and a correctness rule for review output.

## Smoke Testing

- Start an isolated backend on a separate port with explicit `NLK_SESSION_KEY` and `NLK_WORKDIR`.
- For CLI testing, verify both default dangerous mode and `--safe`.
- Open `POST /api/rooms/:roomId/events` as SSE and keep it running while probing.
- Drive the room through `POST /api/rooms/:roomId/messages` plus `POST /api/rooms/:roomId/codex/rpc`.
- Prefer live protocol probes over assumptions when validating parity against `codex app-server`.

### Core smoke scenarios

- New thread: `thread/start` then `turn/start`, verify `turn/started`, `item/*`, `turn/completed`, and `thread/tokenUsage/updated`.
- File change: ask Codex to edit/create one file, verify `item/started(fileChange)` -> `item/fileChange/outputDelta` -> `item/completed(fileChange)` -> `turn/diff/updated`.
- Command execution: ask Codex to run a simple command like `pwd`, verify `item/started(commandExecution)` -> optional `item/commandExecution/outputDelta` -> `item/completed(commandExecution)`.
- Web search: ask for a live page/title lookup, verify `item/started(webSearch)` -> `item/completed(webSearch)`.
- Review: only run `review/start` when `NLK_WORKDIR` is the Git repo root; otherwise the correct behavior is an explicit rejection.
- Review:
  `--safe` from a Git subdirectory should reject `review/start` clearly.
  default startup from that same subdirectory should expand scope to the repo root and allow `review/start`.
- Compaction: call `thread/compact/start`, verify `item/started(contextCompaction)` -> `item/completed(contextCompaction)` and ignore deprecated `thread/compacted` except as compatibility noise.

### Probe recipe

- `thread/start` currently expects `sandbox` in kebab-case, e.g. `danger-full-access` or `workspace-write`.
- `turn/start` currently expects `sandboxPolicy.type` in camelCase, e.g. `dangerFullAccess` or `workspaceWrite`.
- After each probe, inspect `GET /api/rooms/:roomId/state` to confirm the persisted room timeline matches the live SSE flow and did not gain duplicate synthetic steps.
