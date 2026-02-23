import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RoomEvent } from '@codex-room/shared';
import { AppServerSession } from './codex-app-server-session';
import { AppLogger } from './logger';

export type CodexThreadSummary = {
  id: string;
  preview?: string;
  updatedAt?: number;
  createdAt?: number;
  model?: string;
  cwd?: string;
};

export type CodexThreadRead = {
  id: string;
  turns: any[];
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

function normalizeItemType(type: unknown): string {
  if (typeof type !== 'string') return 'unknown';
  const map: Record<string, string> = {
    userMessage: 'user_message',
    agentMessage: 'agent_message',
    plan: 'plan',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    collabToolCall: 'collab_tool_call',
    webSearch: 'web_search',
    imageView: 'image_view',
    enteredReviewMode: 'entered_review_mode',
    exitedReviewMode: 'exited_review_mode',
    contextCompaction: 'context_compaction'
  };
  return map[type] ?? type;
}

function normalizeItem(item: any): any {
  if (!item || typeof item !== 'object') return { type: 'unknown' };
  return {
    ...item,
    type: normalizeItemType(item.type)
  };
}

function extractAgentMessageText(item: any): string {
  if (!item || typeof item !== 'object') return '';

  if (typeof item.text === 'string' && item.text.trim()) {
    return item.text.trim();
  }

  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function itemIdFrom(value: any): string | null {
  const id =
    (typeof value?.id === 'string' && value.id) ||
    (typeof value?.itemId === 'string' && value.itemId) ||
    (typeof value?.item_id === 'string' && value.item_id) ||
    null;
  return id;
}

function appendTextField(target: Record<string, unknown>, key: string, chunk: unknown) {
  if (typeof chunk !== 'string' || !chunk) return;
  const prev = typeof target[key] === 'string' ? (target[key] as string) : '';
  target[key] = `${prev}${chunk}`;
}

function eventThreadIdFrom(paramsAny: any): string | null {
  if (typeof paramsAny?.threadId === 'string') return paramsAny.threadId;
  if (typeof paramsAny?.thread_id === 'string') return paramsAny.thread_id;
  if (typeof paramsAny?.thread?.id === 'string') return paramsAny.thread.id;
  return null;
}

function extractUsagePayload(paramsAny: any): any {
  if (!paramsAny || typeof paramsAny !== 'object') return null;
  const nested =
    paramsAny.usage ??
    paramsAny.tokenUsage ??
    paramsAny.token_usage ??
    paramsAny.turn?.usage ??
    paramsAny.turn?.tokenUsage ??
    paramsAny.turn?.token_usage ??
    null;
  if (nested) return nested;

  const hasDirectUsageFields = [
    'inputTokens',
    'input_tokens',
    'outputTokens',
    'output_tokens',
    'totalTokens',
    'total_tokens',
    'promptTokens',
    'prompt_tokens'
  ].some((key) => key in paramsAny);

  return hasDirectUsageFields ? paramsAny : null;
}

function safeJsonSnippet(value: unknown, maxLength = 1200): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return '';
    return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
  } catch {
    return '[unserializable]';
  }
}

function summarizeUsageForLog(value: unknown): Record<string, unknown> {
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!obj) return { exists: false };
  const nested =
    (obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : null) ??
    (obj.tokenUsage && typeof obj.tokenUsage === 'object'
      ? (obj.tokenUsage as Record<string, unknown>)
      : null) ??
    (obj.token_usage && typeof obj.token_usage === 'object'
      ? (obj.token_usage as Record<string, unknown>)
      : null);
  const target = nested ?? obj;

  const readNum = (k: string): number | null => {
    const v = target[k];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    exists: true,
    rootKeys: Object.keys(obj).slice(0, 40),
    nestedKeys: nested ? Object.keys(nested).slice(0, 40) : [],
    input: readNum('inputTokens') ?? readNum('input_tokens') ?? readNum('promptTokens') ?? readNum('prompt_tokens'),
    output:
      readNum('outputTokens') ?? readNum('output_tokens') ?? readNum('completionTokens') ?? readNum('completion_tokens'),
    total: readNum('totalTokens') ?? readNum('total_tokens'),
    contextWindow:
      readNum('contextWindowTokens') ??
      readNum('context_window_tokens') ??
      readNum('contextWindow') ??
      readNum('context_window') ??
      readNum('maxInputTokens') ??
      readNum('max_input_tokens') ??
      null,
    remaining:
      readNum('remainingTokens') ??
      readNum('remaining_tokens') ??
      readNum('availableTokens') ??
      readNum('available_tokens') ??
      readNum('contextRemainingTokens') ??
      readNum('context_remaining_tokens') ??
      null,
    remainingPercent:
      readNum('contextAvailablePercent') ??
      readNum('context_available_percent') ??
      readNum('remainingPercent') ??
      readNum('remaining_percent') ??
      null,
    raw: safeJsonSnippet(obj)
  };
}

function codexSessionsRoot(): string {
  const home = process.env.HOME ?? '';
  return resolve(home, '.codex', 'sessions');
}

function findRolloutPathForThreadId(threadId: string): string | null {
  const root = codexSessionsRoot();
  if (!threadId || !existsSync(root)) return null;

  const targetSuffix = `${threadId}.jsonl`;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('rollout-')) continue;
      if (!entry.name.endsWith(targetSuffix)) continue;
      return full;
    }
  }
  return null;
}

function normalizeRolloutUsage(info: Record<string, unknown>): Record<string, unknown> {
  const totalUsage =
    info.total_token_usage && typeof info.total_token_usage === 'object'
      ? (info.total_token_usage as Record<string, unknown>)
      : null;
  const lastUsage =
    info.last_token_usage && typeof info.last_token_usage === 'object'
      ? (info.last_token_usage as Record<string, unknown>)
      : null;
  const normalizedCounters = (src: Record<string, unknown> | null): Record<string, unknown> => {
    if (!src) return {};
    return {
      totalTokens: src.total_tokens ?? src.totalTokens,
      inputTokens: src.input_tokens ?? src.inputTokens,
      cachedInputTokens: src.cached_input_tokens ?? src.cachedInputTokens,
      outputTokens: src.output_tokens ?? src.outputTokens,
      reasoningOutputTokens: src.reasoning_output_tokens ?? src.reasoningOutputTokens
    };
  };
  return {
    total: normalizedCounters(totalUsage),
    last: normalizedCounters(lastUsage),
    modelContextWindow: info.model_context_window ?? info.modelContextWindow
  };
}

function loadTurnUsageFromRollout(threadId: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const path = findRolloutPathForThreadId(threadId);
  if (!path) return result;

  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return result;
  }

  const lines = raw.split('\n').filter(Boolean);
  let currentTurnId: string | null = null;
  let latestUsageForCurrentTurn: Record<string, unknown> | null = null;

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event?.payload;
    const type = payload?.type;
    if (type === 'task_started') {
      currentTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      latestUsageForCurrentTurn = null;
      continue;
    }
    if (type === 'token_count') {
      if (!currentTurnId) continue;
      if (payload.info && typeof payload.info === 'object') {
        latestUsageForCurrentTurn = normalizeRolloutUsage(payload.info as Record<string, unknown>);
      }
      continue;
    }
    if (type === 'task_complete') {
      const completedTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : currentTurnId;
      if (completedTurnId && latestUsageForCurrentTurn) {
        result.set(completedTurnId, latestUsageForCurrentTurn);
      }
      currentTurnId = null;
      latestUsageForCurrentTurn = null;
    }
  }

  return result;
}

export class CodexRunner {
  private runningRooms = new Set<string>();
  private activeTurns = new Map<
    string,
    { session: AppServerSession; threadId: string; turnId: string | null }
  >();
  constructor(
    private readonly logger: AppLogger,
    private readonly workingDirectory?: string,
    private readonly model?: string,
    private readonly reasoningEffort?: string
  ) {}

  isRoomRunning(roomId: string): boolean {
    return this.runningRooms.has(roomId);
  }

  private getActiveTurn(roomId: string) {
    return this.activeTurns.get(roomId) ?? null;
  }

  async steerRoomTurn(params: { roomId: string; prompt: string }): Promise<{ turnId: string }> {
    const active = this.getActiveTurn(params.roomId);
    if (!active) throw new Error('No active turn for this room');
    if (!active.turnId) throw new Error('Turn is starting; try again in a moment');

    const result = await active.session.request('turn/steer', {
      threadId: active.threadId,
      input: [{ type: 'text', text: params.prompt }],
      expectedTurnId: active.turnId
    });

    const turnId = typeof result?.turnId === 'string' ? result.turnId : active.turnId;
    return { turnId };
  }

  async interruptRoomTurn(params: { roomId: string }): Promise<void> {
    const active = this.getActiveTurn(params.roomId);
    if (!active) throw new Error('No active turn for this room');
    if (!active.turnId) throw new Error('Turn is starting; try again in a moment');

    await active.session.request('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId
    });
  }

  private allowedWorkspaceRoot(): string | null {
    return normalizePathForScope(this.workingDirectory);
  }

  private threadBelongsToWorkspace(thread: any): boolean {
    const allowed = this.allowedWorkspaceRoot();
    if (!allowed) return true;

    const threadCwd = normalizePathForScope(threadCwdFromValue(thread));
    if (!threadCwd) return false;
    return threadCwd === allowed;
  }

  private scopeError(threadId: string, threadCwd?: string | null): Error {
    const allowed = this.allowedWorkspaceRoot();
    const suffix =
      allowed || threadCwd
        ? ` (thread cwd: ${threadCwd ?? 'unknown'}, allowed cwd: ${allowed ?? 'unset'})`
        : '';
    return new Error(`Thread is outside allowed workspace scope${suffix}`);
  }

  private async readThreadRaw(
    session: AppServerSession,
    threadId: string,
    includeTurns: boolean
  ): Promise<any | null> {
    const response = await session.request('thread/read', {
      threadId,
      includeTurns
    });
    const thread = response?.thread;
    return thread && typeof thread === 'object' ? thread : null;
  }

  private async assertThreadScope(session: AppServerSession, threadId: string): Promise<void> {
    const allowed = this.allowedWorkspaceRoot();
    if (!allowed) return;

    const thread = await this.readThreadRaw(session, threadId, false);
    if (!thread) return;

    if (!this.threadBelongsToWorkspace(thread)) {
      const threadCwd = threadCwdFromValue(thread);
      this.logger.warn('codex.thread.scope.denied', {
        threadId,
        threadCwd: threadCwd ?? undefined,
        allowedCwd: allowed
      });
      throw this.scopeError(threadId, threadCwd);
    }
  }

  async listThreads(limit = 30): Promise<CodexThreadSummary[]> {
    const session = await AppServerSession.start(this.logger);
    try {
      const response = await session.request('thread/list', {
        limit,
        sortKey: 'updated_at',
        sourceKinds: ['appServer', 'cli', 'vscode'],
        ...(this.workingDirectory ? { cwd: this.workingDirectory } : {})
      });
      const data = Array.isArray(response?.data) ? response.data : [];

      return data
        .map((entry: any): CodexThreadSummary | null => {
          const id = typeof entry?.id === 'string' ? entry.id : '';
          if (!id) return null;
          return {
            id,
            preview: typeof entry?.preview === 'string' ? entry.preview : undefined,
            updatedAt:
              typeof entry?.updatedAt === 'number'
                ? entry.updatedAt
                : typeof entry?.updated_at === 'number'
                  ? entry.updated_at
                  : undefined,
            createdAt:
              typeof entry?.createdAt === 'number'
                ? entry.createdAt
                : typeof entry?.created_at === 'number'
                  ? entry.created_at
                  : undefined,
            model:
              typeof entry?.model === 'string'
                ? entry.model
                : typeof entry?.modelProvider === 'string'
                  ? entry.modelProvider
                  : undefined,
            cwd: typeof entry?.cwd === 'string' ? entry.cwd : undefined
          };
        })
        .filter((entry): entry is CodexThreadSummary => Boolean(entry));
    } finally {
      session.close();
    }
  }

  async startThread(): Promise<{ id: string }> {
    const requestedModel = this.model && this.model !== 'default' ? this.model : undefined;
    const session = await AppServerSession.start(this.logger);
    try {
      let started: any;
      try {
        started = await session.request('thread/start', {
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(this.workingDirectory ? { cwd: this.workingDirectory } : {}),
          persistExtendedHistory: true
        });
      } catch {
        started = await session.request('thread/start', {
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(this.workingDirectory ? { cwd: this.workingDirectory } : {})
        });
      }
      const id = started?.thread?.id;
      if (!id || typeof id !== 'string') throw new Error('Failed to create thread');
      return { id };
    } finally {
      session.close();
    }
  }

  async readThread(threadId: string): Promise<CodexThreadRead | null> {
    const session = await AppServerSession.start(this.logger);
    try {
      const thread = await this.readThreadRaw(session, threadId, true);
      if (!thread) return null;
      if (!this.threadBelongsToWorkspace(thread)) {
        throw this.scopeError(threadId, threadCwdFromValue(thread));
      }
      const id = typeof thread.id === 'string' ? thread.id : threadId;
      const turnsRaw = Array.isArray(thread.turns) ? thread.turns : [];
      const rolloutUsageByTurnId = loadTurnUsageFromRollout(id);
      const turns = turnsRaw.map((turn: any) => {
        if (!turn || typeof turn !== 'object') return turn;
        const turnId = typeof turn.id === 'string' ? turn.id : null;
        if (!turnId) return turn;
        const existingUsage = turn.usage ?? turn.tokenUsage ?? turn.token_usage;
        if (existingUsage) return turn;
        const rolloutUsage = rolloutUsageByTurnId.get(turnId);
        if (!rolloutUsage) return turn;
        return { ...turn, usage: rolloutUsage };
      });
      this.logger.debug('codex.thread.read.usage.enriched', {
        threadId: id,
        turns: turns.length,
        rolloutUsageEntries: rolloutUsageByTurnId.size
      });
      return { id, turns };
    } finally {
      session.close();
    }
  }

  async runRoomTurn(params: {
    roomId: string;
    prompt: string;
    threadId?: string;
    onThreadId?: (threadId: string) => void;
    publish: (event: RoomEvent) => void;
  }) {
    if (this.runningRooms.has(params.roomId)) {
      this.logger.warn('codex.turn.rejected.running', { roomId: params.roomId });
      throw new Error('Turn is already running for this room');
    }

    this.runningRooms.add(params.roomId);

    const requestedModel = this.model && this.model !== 'default' ? this.model : undefined;

    this.logger.info('codex.turn.queue.enter', {
      roomId: params.roomId,
      promptLength: params.prompt.length,
      hasThreadId: Boolean(params.threadId),
      model: requestedModel,
      reasoningEffort: this.reasoningEffort
    });

    const session = await AppServerSession.start(this.logger);
    let failurePublished = false;

    try {
      let threadId = params.threadId;

      if (threadId) {
        await this.assertThreadScope(session, threadId);
        let resumed: any = null;
        let resumeError: string | null = null;
        try {
          resumed = await session.request('thread/resume', {
            threadId,
            persistExtendedHistory: true
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn('codex.thread.resume.extended_history_fallback', {
            roomId: params.roomId,
            threadId,
            error: message
          });
          try {
            resumed = await session.request('thread/resume', { threadId });
          } catch (secondError) {
            resumeError = secondError instanceof Error ? secondError.message : String(secondError);
          }
        }

        if (resumed?.thread?.id) {
          threadId = resumed.thread.id;
        } else {
          this.logger.warn('codex.thread.resume.failed.fallback_to_start', {
            roomId: params.roomId,
            threadId,
            error: resumeError
          });
          threadId = undefined;
        }
      }

      if (!threadId) {
        let started: any;
        try {
          started = await session.request('thread/start', {
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(this.workingDirectory ? { cwd: this.workingDirectory } : {}),
            persistExtendedHistory: true
          });
        } catch (error) {
          this.logger.warn('codex.thread.start.extended_history_fallback', {
            roomId: params.roomId,
            error: error instanceof Error ? error.message : String(error)
          });
          started = await session.request('thread/start', {
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(this.workingDirectory ? { cwd: this.workingDirectory } : {})
          });
        }
        threadId = started?.thread?.id;
      }

      if (!threadId) throw new Error('Failed to start or resume thread');
      if (params.onThreadId) params.onThreadId(threadId);

      this.activeTurns.set(params.roomId, {
        session,
        threadId,
        turnId: null
      });

      params.publish({
        type: 'codex.turn.started',
        roomId: params.roomId,
        prompt: params.prompt,
        model: requestedModel ?? 'default',
        reasoningEffort: this.reasoningEffort,
        at: new Date().toISOString()
      });

      const turnResult = await session.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: params.prompt }],
        ...(this.reasoningEffort ? { effort: this.reasoningEffort } : {})
      });

      const turnId = turnResult?.turn?.id;
      if (!turnId) throw new Error('Failed to start turn');
      this.activeTurns.set(params.roomId, {
        session,
        threadId,
        turnId
      });

      let lastAgentMessageText = '';
      let latestUsage: any = null;
      const itemState = new Map<string, Record<string, unknown>>();
      const startedPublished = new Set<string>();
      const offServerRequests = session.onRequest((message) => {
        const method = message.method ?? '';
        const paramsAny = message.params ?? {};

        if (
          method === 'item/commandExecution/requestApproval' ||
          method === 'item/fileChange/requestApproval'
        ) {
          const itemId = itemIdFrom(paramsAny) ?? undefined;
          this.logger.info('codex.approval.auto_accepted', {
            roomId: params.roomId,
            threadId: eventThreadIdFrom(paramsAny) ?? threadId,
            turnId: typeof paramsAny?.turnId === 'string' ? paramsAny.turnId : undefined,
            itemId,
            method
          });
          params.publish({
            type: 'codex.item.completed',
            item: normalizeItem({
              type:
                method === 'item/fileChange/requestApproval' ? 'fileChange' : 'commandExecution',
              id: itemId,
              status: 'awaiting_approval',
              approval: {
                decision: 'acceptForSession',
                source: 'auto',
                method
              }
            }),
            at: new Date().toISOString()
          });
          return { handled: true, result: 'acceptForSession' } as const;
        }

        if (method === 'tool/requestUserInput') {
          this.logger.warn('codex.tool.request_user_input.unsupported', {
            roomId: params.roomId,
            threadId: eventThreadIdFrom(paramsAny) ?? threadId,
            payload: safeJsonSnippet(paramsAny)
          });
          return {
            handled: true,
            error: {
              code: -32601,
              message: 'tool/requestUserInput is not supported by this client'
            }
          } as const;
        }

        if (method === 'account/chatgptAuthTokens/refresh') {
          this.logger.warn('codex.auth.external_tokens_refresh.unsupported', {
            roomId: params.roomId
          });
          return {
            handled: true,
            error: {
              code: -32601,
              message: 'Externally-managed ChatGPT token refresh is not supported'
            }
          } as const;
        }

        return undefined;
      });

      await new Promise<void>((resolve, reject) => {
        const off = session.onNotification((message) => {
          const method = message.method ?? '';
          const paramsAny = message.params ?? {};

          if (method === 'thread/tokenUsage/updated') {
            const eventThreadId = eventThreadIdFrom(paramsAny);
            if (!eventThreadId || eventThreadId === threadId) {
              latestUsage = extractUsagePayload(paramsAny);
              this.logger.debug('codex.usage.updated', {
                roomId: params.roomId,
                threadId,
                eventThreadId: eventThreadId ?? undefined,
                ...summarizeUsageForLog(paramsAny)
              });
            }
            return;
          }

          if (method === 'item/completed') {
            const rawItem = paramsAny.item;
            const item = normalizeItem(rawItem) as Record<string, unknown>;
            const itemId = itemIdFrom(item);
            const base = itemId ? itemState.get(itemId) : undefined;
            const merged = base ? ({ ...base, ...item } as Record<string, unknown>) : item;
            if (itemId) itemState.delete(itemId);

            if (merged.type === 'agent_message') {
              const text = extractAgentMessageText(merged);
              if (text) lastAgentMessageText = text;
            }

            params.publish({
              type: 'codex.item.completed',
              item: merged,
              at: new Date().toISOString()
            });
            return;
          }

          if (method === 'item/started') {
            const rawItem = paramsAny.item;
            const item = normalizeItem(rawItem) as Record<string, unknown>;
            const itemId = itemIdFrom(item);
            if (itemId) itemState.set(itemId, item);
            const itemType = typeof item.type === 'string' ? item.type : 'unknown';
            if (
              itemId &&
              !startedPublished.has(itemId) &&
              (itemType === 'command_execution' || itemType === 'file_change')
            ) {
              startedPublished.add(itemId);
              params.publish({
                type: 'codex.item.completed',
                item,
                at: new Date().toISOString()
              });
            }
            return;
          }

          if (method === 'item/agentMessage/delta') {
            const delta =
              paramsAny.delta ??
              paramsAny.textDelta ??
              paramsAny.text ??
              '';
            if (typeof delta === 'string') {
              lastAgentMessageText = `${lastAgentMessageText}${delta}`.trim();
              const id = itemIdFrom(paramsAny);
              if (id) {
                const state = itemState.get(id) ?? { id, type: 'agent_message' };
                appendTextField(state, 'text', delta);
                itemState.set(id, state);
              }
            }
            return;
          }

          if (method === 'item/plan/delta') {
            const id = itemIdFrom(paramsAny);
            if (!id) return;
            const delta = paramsAny.delta ?? paramsAny.textDelta ?? paramsAny.text ?? '';
            const state = itemState.get(id) ?? { id, type: 'plan' };
            appendTextField(state, 'text', delta);
            itemState.set(id, state);
            return;
          }

          if (method === 'item/reasoning/summaryTextDelta') {
            const id = itemIdFrom(paramsAny);
            if (!id) return;
            const delta = paramsAny.delta ?? paramsAny.textDelta ?? '';
            const state = itemState.get(id) ?? { id, type: 'reasoning' };
            const summary = (state.summary ?? {}) as Record<string, unknown>;
            appendTextField(summary, 'text', delta);
            state.summary = summary;
            itemState.set(id, state);
            return;
          }

          if (method === 'item/reasoning/textDelta') {
            const id = itemIdFrom(paramsAny);
            if (!id) return;
            const delta = paramsAny.delta ?? paramsAny.textDelta ?? '';
            const state = itemState.get(id) ?? { id, type: 'reasoning' };
            const content = (state.content ?? {}) as Record<string, unknown>;
            appendTextField(content, 'text', delta);
            state.content = content;
            itemState.set(id, state);
            return;
          }

          if (method === 'item/commandExecution/outputDelta') {
            const id = itemIdFrom(paramsAny);
            if (!id) return;
            const delta = paramsAny.delta ?? paramsAny.outputDelta ?? paramsAny.output ?? '';
            const state = itemState.get(id) ?? { id, type: 'command_execution' };
            appendTextField(state, 'aggregatedOutput', delta);
            itemState.set(id, state);
            return;
          }

          if (method === 'item/fileChange/outputDelta') {
            const id = itemIdFrom(paramsAny);
            if (!id) return;
            const delta = paramsAny.delta ?? paramsAny.outputDelta ?? paramsAny.output ?? '';
            const state = itemState.get(id) ?? { id, type: 'file_change' };
            appendTextField(state, 'outputDelta', delta);
            itemState.set(id, state);
            return;
          }

          if (method === 'turn/diff/updated') {
            const eventTurnId = paramsAny.turnId;
            if (eventTurnId && eventTurnId !== turnId) return;
            params.publish({
              type: 'codex.item.completed',
              item: normalizeItem({
                type: 'fileChange',
                diff: paramsAny.diff,
                source: 'turn.diff.updated'
              }),
              at: new Date().toISOString()
            });
            return;
          }

          if (method === 'turn/plan/updated') {
            const eventTurnId = paramsAny.turnId;
            if (eventTurnId && eventTurnId !== turnId) return;
            const plan = Array.isArray(paramsAny.plan) ? paramsAny.plan : [];
            const explanation =
              typeof paramsAny.explanation === 'string' ? paramsAny.explanation.trim() : '';
            const planText = plan
              .map((entry: any, index: number) => {
                const step =
                  typeof entry?.step === 'string' && entry.step.trim()
                    ? entry.step.trim()
                    : `Step ${index + 1}`;
                const rawStatus = typeof entry?.status === 'string' ? entry.status : 'pending';
                const status =
                  rawStatus === 'inProgress'
                    ? 'in_progress'
                    : rawStatus === 'completed' || rawStatus === 'pending'
                      ? rawStatus
                      : rawStatus;
                return `${index + 1}. [${status}] ${step}`;
              })
              .join('\n');
            params.publish({
              type: 'codex.item.completed',
              item: normalizeItem({
                type: 'plan',
                id: `plan-${turnId}`,
                text: [explanation, planText].filter(Boolean).join('\n'),
                explanation: paramsAny.explanation,
                plan
              }),
              at: new Date().toISOString()
            });
            return;
          }

          if (method === 'model/rerouted') {
            params.publish({
              type: 'codex.item.completed',
              item: normalizeItem({
                type: 'reasoning',
                summary: {
                  text: `model rerouted: ${paramsAny.fromModel ?? 'unknown'} -> ${paramsAny.toModel ?? 'unknown'}`
                },
                content: { text: paramsAny.reason ?? '' }
              }),
              at: new Date().toISOString()
            });
            return;
          }

          if (method === 'turn/completed') {
            const turn = paramsAny.turn;
            if (!turn || turn.id !== turnId) return;

            offServerRequests();
            off();

            const status = turn.status ?? 'completed';
            if (status === 'failed') {
              const errorMessage = turn.error?.message ?? 'Turn failed';
              params.publish({
                type: 'codex.turn.failed',
                error: errorMessage,
                at: new Date().toISOString()
              });
              failurePublished = true;
              reject(new Error(errorMessage));
              return;
            }

            if (status === 'interrupted') {
              params.publish({
                type: 'codex.turn.failed',
                error: 'Turn interrupted',
                at: new Date().toISOString()
              });
              failurePublished = true;
              reject(new Error('Turn interrupted'));
              return;
            }

            const finalResponse =
              turn.finalResponse ??
              lastAgentMessageText ??
              '';

            params.publish({
              type: 'codex.turn.completed',
              finalResponse,
              usage: extractUsagePayload(turn) ?? latestUsage,
              at: new Date().toISOString()
            });
            this.logger.debug('codex.turn.usage.final', {
              roomId: params.roomId,
              threadId,
              turnId,
              ...summarizeUsageForLog(turn)
            });

            resolve();
          }
        });
      });

      this.logger.info('codex.turn.completed', {
        roomId: params.roomId,
        threadId,
        responseLength: lastAgentMessageText.length
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('codex.turn.failed', {
        roomId: params.roomId,
        error: errorMessage
      });
      if (!failurePublished) {
        params.publish({
          type: 'codex.turn.failed',
          error: errorMessage,
          at: new Date().toISOString()
        });
      }
      throw error;
    } finally {
      this.activeTurns.delete(params.roomId);
      // request handlers are cleared in close(), but explicit close ordering keeps
      // any late server-initiated requests from being handled against stale state.
      session.close();
      this.runningRooms.delete(params.roomId);
      this.logger.info('codex.turn.queue.leave', { roomId: params.roomId });
    }
  }
}
