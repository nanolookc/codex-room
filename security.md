# Security Findings

## Current Status

Primary priority for this project is API correctness and stable support of the documented `codex app-server` lifecycle.

Workspace isolation remains required and any cross-project thread exposure is treated as a security regression.

## Confirmed Findings

### 1. RPC surface was broader than the room/project policy

The browser-facing `/api/rooms/:roomId/codex/rpc` endpoint exposed almost raw `app-server` methods, while backend policy only scope-checked a small subset of thread-bearing methods.

Risk:
- thread-scoped methods added upstream could bypass workspace checks;
- global mutating methods could escape the room/project boundary;
- experimental methods enlarged attack surface further.

Immediate direction:
- keep the proxy on an explicit allowlist of supported methods;
- require scope checks for every allowed method that accepts `threadId`-like params;
- reject unsupported methods by default instead of forwarding them upstream.

### 2. Approval safety was effectively disabled

The backend auto-accepted `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.

Risk:
- room participants could execute command/file-change flows without a real approval decision;
- this weakens the safety contract that `app-server` expects rich clients to honor.

Direction:
- keep this tracked explicitly;
- if product policy remains “shared room auto-approves”, treat it as an intentional product decision, not an invisible protocol default.

### 3. Event-stream overflow was not treated as a state-corruption event

When SSE backpressure dropped queued events, the frontend had no typed overflow event and no resync path.

Risk:
- silently missing `item/completed`, `turn/completed`, approval, or diff events;
- UI and thread state diverge after long or noisy turns.

Direction:
- emit a typed overflow event;
- force state replay/resync on overflow.

## Required Regression Coverage

- `thread/read` for a foreign thread must be denied.
- `thread/resume` for a foreign thread must be denied.
- `thread/fork` for a foreign thread must be denied.
- `thread/loaded/list` must only return threads from the current workspace.
- unsupported or blocked RPC methods must fail closed.
- queue overflow must trigger client resync instead of silent continuation.
