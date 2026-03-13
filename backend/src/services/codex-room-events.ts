import type { CodexRpcMessage, RoomEvent } from '@codex-room/shared';
import {
  extractFinalResponseFromItem,
  extractPromptFromInput,
  normalizeCodexItem,
  normalizeCodexItemType
} from '@codex-room/shared';

export type PendingServerRequest = {
  message: CodexRpcMessage;
  resolve: (value: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RoomSessionState = {
  pendingServerRequests: Map<string, PendingServerRequest>;
  lastActiveAt: number;
  latestUsageByTurnId: Map<string, unknown>;
  pendingTurnStart: {
    threadId: string | null;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
  } | null;
};

type Hooks = {
  publish: (roomId: string, event: RoomEvent) => void;
  setThreadId: (roomId: string, threadId: string) => void;
};

function isJsonRpcError(value: unknown): value is { code: number; message: string; data?: unknown } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).code === 'number' &&
    typeof (value as Record<string, unknown>).message === 'string'
  );
}

export function capturePendingTurnStart(
  room: RoomSessionState,
  params: unknown
) {
  const requestParams =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  room.pendingTurnStart = {
    threadId: typeof requestParams.threadId === 'string' ? requestParams.threadId : null,
    prompt: extractPromptFromInput(requestParams),
    model: typeof requestParams.model === 'string' ? requestParams.model : undefined,
    reasoningEffort:
      typeof requestParams.effort === 'string'
        ? requestParams.effort
        : typeof requestParams.reasoningEffort === 'string'
          ? requestParams.reasoningEffort
          : undefined
  };
}

export function handleSessionNotification(
  roomId: string,
  room: RoomSessionState,
  hooks: Hooks,
  message: CodexRpcMessage
) {
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  const at = new Date().toISOString();

  if (method === 'thread/started') {
    const thread = params.thread && typeof params.thread === 'object' ? (params.thread as Record<string, unknown>) : null;
    const threadId = typeof thread?.id === 'string' ? thread.id : null;
    if (threadId) hooks.setThreadId(roomId, threadId);
  }

  if (method === 'thread/tokenUsage/updated') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (turnId) room.latestUsageByTurnId.set(turnId, params.tokenUsage ?? params);
  }

  if (method === 'turn/started') {
    const turn = params.turn && typeof params.turn === 'object' ? (params.turn as Record<string, unknown>) : {};
    const turnId = typeof turn.id === 'string' ? turn.id : null;
    hooks.publish(roomId, {
      type: 'codex.turn.started',
      roomId,
      prompt: room.pendingTurnStart?.prompt?.trim() || '(running turn)',
      at,
      model: room.pendingTurnStart?.model ?? (typeof turn.model === 'string' ? turn.model : undefined),
      reasoningEffort:
        room.pendingTurnStart?.reasoningEffort ??
        (typeof turn.effort === 'string'
          ? turn.effort
          : typeof turn.reasoningEffort === 'string'
            ? turn.reasoningEffort
            : undefined)
    });
    if (turnId) room.latestUsageByTurnId.delete(turnId);
    room.pendingTurnStart = null;
  }

  if (method === 'item/completed') {
    const item = normalizeCodexItem(params.item);
    if (item) {
      hooks.publish(roomId, {
        type: 'codex.item.completed',
        item,
        at
      });
    }
  }

  if (method === 'turn/completed') {
    const turn = params.turn && typeof params.turn === 'object' ? (params.turn as Record<string, unknown>) : {};
    const turnId = typeof turn.id === 'string' ? turn.id : null;
    const status = typeof turn.status === 'string' ? turn.status : 'completed';
    const usage = turnId ? room.latestUsageByTurnId.get(turnId) : undefined;
    if (turnId) room.latestUsageByTurnId.delete(turnId);

    if (status === 'failed') {
      hooks.publish(roomId, {
        type: 'codex.turn.failed',
        error:
          turn.error && typeof turn.error === 'object' && typeof (turn.error as Record<string, unknown>).message === 'string'
            ? ((turn.error as Record<string, unknown>).message as string)
            : 'Turn failed',
        at
      });
    } else if (status === 'interrupted') {
      hooks.publish(roomId, {
        type: 'codex.turn.interrupted',
        at
      });
    } else {
      const items = Array.isArray(turn.items) ? turn.items : [];
      const finalAgentMessageItem = [...items]
        .reverse()
        .find((item) => normalizeCodexItemType((item as Record<string, unknown> | null)?.type) === 'agent_message');
      hooks.publish(roomId, {
        type: 'codex.turn.completed',
        finalResponse: extractFinalResponseFromItem(normalizeCodexItem(finalAgentMessageItem)),
        usage,
        at
      });
    }
  }

  hooks.publish(roomId, {
    type: 'codex.rpc.notification',
    message,
    at
  });
}

export async function handleSessionRequest(
  roomId: string,
  room: RoomSessionState,
  hooks: Hooks,
  message: CodexRpcMessage
): Promise<{ handled: true; result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined> {
  const id = message.id;
  if (id === undefined) return undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  room.lastActiveAt = Date.now();

  if (method === 'account/chatgptAuthTokens/refresh') {
    return {
      handled: true,
      error: {
        code: -32601,
        message: 'Externally-managed ChatGPT token refresh is not supported'
      }
    };
  }

  const key = String(id);
  const responsePromise = new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>(
    (resolve) => {
      const timer = setTimeout(() => {
        room.pendingServerRequests.delete(key);
        resolve({
          error: {
            code: -32002,
            message: 'Client did not respond to server request in time'
          }
        });
      }, 5 * 60 * 1000);

      room.pendingServerRequests.set(key, {
        message,
        resolve,
        timer
      });
    }
  );

  hooks.publish(roomId, {
    type: 'codex.rpc.serverRequest',
    message,
    at: new Date().toISOString()
  });

  const response = await responsePromise;
  if (response.error) return { handled: true, error: response.error };
  return { handled: true, result: response.result };
}

export function resolveServerRequest(
  roomId: string,
  room: RoomSessionState,
  hooks: Hooks,
  requestId: number | string,
  payload: { result?: unknown; error?: unknown }
) {
  const key = String(requestId);
  const pending = room.pendingServerRequests.get(key);
  if (!pending) throw new Error('Unknown or already resolved server request');

  room.pendingServerRequests.delete(key);
  clearTimeout(pending.timer);

  if (isJsonRpcError(payload.error)) {
    pending.resolve({ error: payload.error });
    hooks.publish(roomId, {
      type: 'codex.rpc.serverRequest.resolved',
      requestId,
      outcome: 'error',
      at: new Date().toISOString()
    });
    return;
  }

  pending.resolve({ result: payload.result });
  hooks.publish(roomId, {
    type: 'codex.rpc.serverRequest.resolved',
    requestId,
    outcome: 'result',
    at: new Date().toISOString()
  });
}
