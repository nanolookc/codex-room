# NLK Agents Project Goals

## Workspace Isolation (Required)

- `codex-room start` is scoped to the directory where it is launched (`NLK_WORKDIR`).
- Users connected to that room must see only Codex threads/sessions that belong to that exact project directory.
- Do not list, hydrate, resume, or expose threads from other directories, even if a thread id is known.
- Treat cross-project thread visibility as a security/privacy regression.

