import type { CodexRpcMessage, RoomEvent } from '@codex-room/shared';
import { resolve } from 'node:path';
import { AppServerSession } from './codex-app-server-session';
import { AppLogger } from './logger';

type PendingServerRequest = {
  message: CodexRpcMessage;
  resolve: (value: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RoomSession = {
  session: AppServerSession;
  pendingServerRequests: Map<string, PendingServerRequest>;
  lastActiveAt: number;
};

type Hooks = {
  publish: (roomId: string, event: RoomEvent) => void;
  getThreadId: (roomId: string) => string | undefined;
  setThreadId: (roomId: string, threadId: string) => void;
};

function normalizePathForScope(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  try {
    return resolve(trimmed);
  } catch {
    return trimmed;
  }
}

function threadCwdFromValue(thread: any): string | null {
  if (!thread || typeof thread !== 'object') return null;
  const candidates = [
    thread.cwd,
    thread.workingDirectory,
    thread.working_directory,
    thread.session?.cwd,
    thread.session?.workingDirectory,
    thread.session?.working_directory
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

function isJsonRpcError(value: unknown): value is { code: number; message: string; data?: unknown } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any).code === 'number' &&
    typeof (value as any).message === 'string'
  );
}

const ALLOWED_METHODS = new Set([
  'app/list',
  'command/exec',
  'experimentalFeature/list',
  'model/list',
  'review/start',
  'skills/list',
  'thread/archive',
  'thread/compact/start',
  'thread/fork',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/resume',
  'thread/rollback',
  'thread/start',
  'thread/unarchive',
  'turn/interrupt',
  'turn/start',
  'turn/steer'
]);

const THREAD_SCOPED_METHODS = new Set([
  'review/start',
  'thread/archive',
  'thread/compact/start',
  'thread/fork',
  'thread/read',
  'thread/resume',
  'thread/rollback',
  'thread/unarchive',
  'turn/interrupt',
  'turn/start',
  'turn/steer'
]);

export class CodexRoomProxyManager {
  private readonly rooms = new Map<string, RoomSession>();
  private readonly workspaceRoot: string | null;
  private readonly idleTtlMs = 15 * 60 * 1000;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(
    private readonly logger: AppLogger,
    private readonly hooks: Hooks,
    private readonly workingDirectory?: string,
    private readonly model?: string,
    private readonly reasoningEffort?: string
  ) {
    this.workspaceRoot = normalizePathForScope(workingDirectory);
    this.sweepInterval = setInterval(() => this.sweepIdleRooms(), 60_000);
    this.sweepInterval.unref?.();
  }

  async call(roomId: string, method: string, params?: unknown): Promise<unknown> {
    if (!method || typeof method !== 'string') {
      throw new Error('method is required');
    }
    if (method === 'initialize' || method === 'initialized') {
      throw new Error('initialize/initialized are managed by the backend');
    }

    const room = await this.ensureRoom(roomId);
    room.lastActiveAt = Date.now();
    const nextParams = await this.applyPolicy(roomId, room.session, method, params);
    const rawResult = await room.session.request(method, nextParams);
    const result = await this.applyResultPolicy(room.session, method, rawResult);

    const threadId =
      (typeof (result as any)?.thread?.id === 'string' && (result as any).thread.id) ||
      (typeof (result as any)?.reviewThreadId === 'string' && (result as any).reviewThreadId) ||
      null;
    if (threadId) this.hooks.setThreadId(roomId, threadId);

    return result;
  }

  async respond(roomId: string, requestId: number | string, payload: { result?: unknown; error?: unknown }) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('No active Codex session for this room');
    const key = String(requestId);
    const pending = room.pendingServerRequests.get(key);
    if (!pending) throw new Error('Unknown or already resolved server request');

    room.pendingServerRequests.delete(key);
    clearTimeout(pending.timer);

    if (isJsonRpcError(payload.error)) {
      pending.resolve({ error: payload.error });
      this.hooks.publish(roomId, {
        type: 'codex.rpc.serverRequest.resolved',
        requestId,
        outcome: 'error',
        at: new Date().toISOString()
      });
      return;
    }

    pending.resolve({ result: payload.result });
    this.hooks.publish(roomId, {
      type: 'codex.rpc.serverRequest.resolved',
      requestId,
      outcome: 'result',
      at: new Date().toISOString()
    });
  }

  private async ensureRoom(roomId: string): Promise<RoomSession> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const session = await AppServerSession.start(this.logger);
    const room: RoomSession = {
      session,
      pendingServerRequests: new Map(),
      lastActiveAt: Date.now()
    };

    session.onNotification((message) => {
      const method = typeof message.method === 'string' ? message.method : '';
      const params = (message.params ?? {}) as any;
      if (method === 'thread/started') {
        const threadId = typeof params?.thread?.id === 'string' ? params.thread.id : null;
        if (threadId) this.hooks.setThreadId(roomId, threadId);
      }
      if (method === 'thread/archived' || method === 'thread/unarchived') {
        // no-op, forwarded raw below
      }
      this.hooks.publish(roomId, {
        type: 'codex.rpc.notification',
        message: message as CodexRpcMessage,
        at: new Date().toISOString()
      });
    });

    session.onRequest(async (message) => {
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
        } as const;
      }

      const key = String(id);
      const responsePromise = new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>((resolve) => {
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
          message: message as CodexRpcMessage,
          resolve,
          timer
        });
      });

      this.hooks.publish(roomId, {
        type: 'codex.rpc.serverRequest',
        message: message as CodexRpcMessage,
        at: new Date().toISOString()
      });

      const response = await responsePromise;

      if (response.error) return { handled: true, error: response.error } as const;
      return { handled: true, result: response.result } as const;
    });

    this.rooms.set(roomId, room);
    return room;
  }

  private sweepIdleRooms() {
    const now = Date.now();
    for (const [roomId, room] of this.rooms) {
      if (room.pendingServerRequests.size > 0) continue;
      if (now - room.lastActiveAt < this.idleTtlMs) continue;
      this.logger.info('codex.room_proxy.idle_close', { roomId, idleMs: now - room.lastActiveAt });
      this.closeRoom(roomId, room);
    }
  }

  private closeRoom(roomId: string, room: RoomSession) {
    this.rooms.delete(roomId);
    for (const pending of room.pendingServerRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        error: { code: -32000, message: 'Codex room session closed due to inactivity' }
      });
    }
    room.pendingServerRequests.clear();
    room.session.close();
  }

  private async applyPolicy(
    _roomId: string,
    session: AppServerSession,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Method is not available in codex-room proxy: ${method}`);
    }

    const obj =
      params && typeof params === 'object' && !Array.isArray(params)
        ? ({ ...(params as Record<string, unknown>) } as Record<string, unknown>)
        : {};

    const threadId =
      (typeof obj.threadId === 'string' && obj.threadId) ||
      (typeof obj.reviewThreadId === 'string' && obj.reviewThreadId) ||
      null;

    if (threadId && THREAD_SCOPED_METHODS.has(method)) {
      await this.assertThreadScope(session, threadId);
    }

    if (method === 'thread/list') {
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    if (method === 'skills/list') {
      if (this.workingDirectory) obj.cwds = [this.workingDirectory];
      return obj;
    }

    if (method === 'thread/start') {
      if (this.model && this.model !== 'default' && !obj.model) obj.model = this.model;
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    if (method === 'thread/resume') {
      return obj;
    }

    if (method === 'turn/start') {
      if (this.reasoningEffort && !obj.effort) obj.effort = this.reasoningEffort;
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    if (method === 'command/exec') {
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    return Object.keys(obj).length > 0 ? obj : params;
  }

  private async applyResultPolicy(
    session: AppServerSession,
    method: string,
    result: unknown
  ): Promise<unknown> {
    if (method !== 'thread/loaded/list' || !this.workspaceRoot) {
      return result;
    }

    const data = Array.isArray((result as any)?.data) ? (result as any).data : null;
    if (!data) return result;

    const filtered: string[] = [];
    for (const threadId of data) {
      if (typeof threadId !== 'string' || !threadId) continue;
      try {
        await this.assertThreadScope(session, threadId);
        filtered.push(threadId);
      } catch {
        // Hide threads outside the room workspace.
      }
    }

    return {
      ...(result && typeof result === 'object' ? (result as Record<string, unknown>) : {}),
      data: filtered
    };
  }

  private async assertThreadScope(session: AppServerSession, threadId: string): Promise<void> {
    if (!this.workspaceRoot) return;
    const response = await session.request('thread/read', {
      threadId,
      includeTurns: false
    });
    const thread = (response as any)?.thread;
    if (!thread || typeof thread !== 'object') return;

    const threadCwd = normalizePathForScope(threadCwdFromValue(thread));
    if (!threadCwd || threadCwd !== this.workspaceRoot) {
      this.logger.warn('codex.thread.scope.denied', {
        threadId,
        threadCwd: threadCwd ?? undefined,
        allowedCwd: this.workspaceRoot
      });
      throw new Error(
        `Thread is outside allowed workspace scope (thread cwd: ${threadCwd ?? 'unknown'}, allowed cwd: ${this.workspaceRoot})`
      );
    }
  }
}
