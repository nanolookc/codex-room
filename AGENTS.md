# NLK Agents Project Goals

## Workspace Isolation (Required)

- `codex-room start` is scoped to the directory where it is launched (`NLK_WORKDIR`).
- Users connected to that room must see only Codex threads/sessions that belong to that exact project directory.
- Do not list, hydrate, resume, or expose threads from other directories, even if a thread id is known.
- Treat cross-project thread visibility as a security/privacy regression.

## Current Priorities

- Highest priority: match the documented stable `codex app-server` API and lifecycle.
- Prefer documented `thread/*`, `turn/*`, and `item/*` notifications over raw or legacy event families when both exist.
- Use `thread/resume` for live continuation of an existing thread; keep `thread/read` for read-only replay and hydration checks.
- Favour correctness and reconnect stability over extra features.
- Diff/file-change UI should stay collapsed by default and avoid duplicate or noisy patch rendering.
- Security findings and follow-up work for room/project isolation must be recorded in `security.md`.

## Roadmap

- Finish stable `app-server` alignment first; experimental features must not weaken the stable chat flow.
- After stable parity, evaluate a guarded opt-in for `persistExtendedHistory` to improve replay and reconnect hydration.
- After stable parity, evaluate `tool/requestUserInput` UX and richer approval/request flows only where they match documented server-request contracts.
- Keep `dynamicTools`, `thread/realtime/*`, plugins, and remote skills out of the main chat path until there is a clear product need and explicit protocol coverage.
