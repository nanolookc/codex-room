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

    const room = await this.ensureRoom(roomId);
    room.lastActiveAt = Date.now();
    const nextParams = await this.policy.applyRequestPolicy(room.session, method, params);

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

  private async ensureRoom(roomId: string): Promise<RoomSession> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

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
}
