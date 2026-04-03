import { type CodexRpcMessage } from '@codex-room/shared';
import { AppServerSession } from './codex-app-server-session';
import {
  capturePendingTurnStart,
  handleSessionNotification,
  handleSessionRequest,
  resolveServerRequest,
  type RoomSessionState
} from './codex-room-events';
import { CodexRoomPolicy } from './codex-room-policy';
import { AppLogger } from './logger';

type RoomSession = RoomSessionState & {
  session: AppServerSession;
};

const LIVE_THREAD_METHODS = new Set([
  'review/start',
  'thread/compact/start',
  'thread/rollback',
  'turn/start',
  'turn/steer'
]);

type Hooks = {
  publish: (roomId: string, event: import('@codex-room/shared').RoomEvent) => void;
  getThreadId: (roomId: string) => string | undefined;
  setThreadId: (roomId: string, threadId: string) => void;
};

export class CodexRoomProxyManager {
  private readonly rooms = new Map<string, RoomSession>();
  private readonly idleTtlMs = 15 * 60 * 1000;
  private readonly sweepInterval: ReturnType<typeof setInterval>;
  private readonly policy: CodexRoomPolicy;

  constructor(
    private readonly logger: AppLogger,
    private readonly hooks: Hooks,
    workingDirectory?: string,
    model?: string,
    reasoningEffort?: string
  ) {
    this.policy = new CodexRoomPolicy(logger, workingDirectory, model, reasoningEffort);
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

    const { room, created } = await this.ensureRoom(roomId);
    room.lastActiveAt = Date.now();
    const nextParams = await this.policy.applyRequestPolicy(room.session, method, params);
    await this.resumeThreadIfNeeded(roomId, room, created, method, nextParams);

    if (method === 'turn/start') {
      capturePendingTurnStart(room, nextParams);
    }

    const rawResult = await room.session.request(method, nextParams);
    const result = await this.policy.applyResultPolicy(room.session, method, rawResult);

    const resultObj = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
    const thread = resultObj?.thread && typeof resultObj.thread === 'object'
      ? (resultObj.thread as Record<string, unknown>)
      : null;
    const threadId =
      (typeof thread?.id === 'string' && thread.id) ||
      (typeof resultObj?.reviewThreadId === 'string' && resultObj.reviewThreadId) ||
      null;
    if (threadId) this.hooks.setThreadId(roomId, threadId);

    return result;
  }

  async respond(roomId: string, requestId: number | string, payload: { result?: unknown; error?: unknown }) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('No active Codex session for this room');
    resolveServerRequest(roomId, room, this.hooks, requestId, payload);
  }

  private async ensureRoom(roomId: string): Promise<{ room: RoomSession; created: boolean }> {
    const existing = this.rooms.get(roomId);
    if (existing) return { room: existing, created: false };

    const session = await AppServerSession.start(this.logger);
    const room: RoomSession = {
      session,
      pendingServerRequests: new Map(),
      lastActiveAt: Date.now(),
      latestUsageByTurnId: new Map(),
      pendingTurnStart: null
    };

    session.onNotification((message) => {
      handleSessionNotification(roomId, room, this.hooks, message as CodexRpcMessage);
    });

    session.onRequest(async (message) => {
      return handleSessionRequest(roomId, room, this.hooks, message as CodexRpcMessage);
    });

    this.rooms.set(roomId, room);
    return { room, created: true };
  }

  private async resumeThreadIfNeeded(
    roomId: string,
    room: RoomSession,
    created: boolean,
    method: string,
    params: unknown
  ) {
    if (!created || !LIVE_THREAD_METHODS.has(method)) return;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;

    const requestParams = params as Record<string, unknown>;
    const threadId = typeof requestParams.threadId === 'string' ? requestParams.threadId : null;
    if (!threadId) return;

    const rememberedThreadId = this.hooks.getThreadId(roomId);
    if (!rememberedThreadId || rememberedThreadId !== threadId) return;

    this.logger.info('codex.room_proxy.thread.resume', {
      roomId,
      threadId,
      method,
      reason: 'session_recreated'
    });

    const resumeParams = await this.policy.applyRequestPolicy(room.session, 'thread/resume', { threadId });
    await room.session.request('thread/resume', resumeParams);
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
}
