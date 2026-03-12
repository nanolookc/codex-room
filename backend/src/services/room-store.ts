import { nanoid } from 'nanoid';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ChatMessage, EditorCursor, EditorState, RoomEvent, RoomSummary, TimelineEntry } from '@codex-room/shared';
import { AppLogger } from './logger';

type Subscriber = (event: RoomEvent) => void;

interface RoomState {
  roomId: string;
  workspace: string;
  messages: ChatMessage[];
  timeline: TimelineEntry[];
  editor: EditorState;
  subscribers: Set<Subscriber>;
  threadId?: string;
  updatedAt: string;
}

export class EditorConflictError extends Error {
  constructor(
    message: string,
    public readonly editor: EditorState
  ) {
    super(message);
    this.name = 'EditorConflictError';
  }
}

interface PersistedRoomState {
  roomId: string;
  workspace?: string;
  messages: ChatMessage[];
  timeline: TimelineEntry[];
  editor: EditorState;
  threadId?: string;
  updatedAt: string;
}

const EDITOR_CURSOR_TTL_MS = 60_000;

function workspaceStorageKey(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 24);
}

function toFiniteNonNegativeInteger(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function normalizeSelection(
  selectionStart: unknown,
  selectionEnd: unknown,
  textLength: number
): { start: number; end: number } {
  const startRaw = toFiniteNonNegativeInteger(selectionStart);
  const endRaw = toFiniteNonNegativeInteger(selectionEnd);
  const start = Math.min(textLength, startRaw ?? endRaw ?? textLength);
  const end = Math.min(textLength, endRaw ?? startRaw ?? textLength);
  return start <= end ? { start, end } : { start: end, end: start };
}

function normalizeCursorEntry(
  cursor: unknown,
  textLength: number
): EditorCursor | null {
  if (!cursor || typeof cursor !== 'object') return null;
  const obj = cursor as Record<string, unknown>;
  const userId = typeof obj.userId === 'string' ? obj.userId.trim() : '';
  if (!userId) return null;
  const userName = typeof obj.userName === 'string' && obj.userName.trim() ? obj.userName.trim() : userId;
  const updatedAt = typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : new Date().toISOString();
  const selection = normalizeSelection(obj.selectionStart, obj.selectionEnd, textLength);
  return {
    userId,
    userName,
    selectionStart: selection.start,
    selectionEnd: selection.end,
    updatedAt
  };
}

function normalizeEditor(editor: EditorState | null | undefined, roomId: string): EditorState {
  const text = typeof editor?.text === 'string' ? editor.text : '';
  const versionRaw = typeof editor?.version === 'number' ? editor.version : Number((editor as any)?.version);
  const version = Number.isFinite(versionRaw) && versionRaw >= 0 ? Math.floor(versionRaw) : 0;
  const updatedAt =
    typeof editor?.updatedAt === 'string' && editor.updatedAt
      ? editor.updatedAt
      : new Date().toISOString();
  const updatedBy =
    typeof editor?.updatedBy === 'string' && editor.updatedBy
      ? editor.updatedBy
      : 'system';
  const now = Date.now();
  const minCursorAt = Number.isFinite(now) ? now - EDITOR_CURSOR_TTL_MS : Number.NEGATIVE_INFINITY;
  const cursors = Array.isArray(editor?.cursors)
    ? editor.cursors
        .map((cursor) => normalizeCursorEntry(cursor, text.length))
        .filter((cursor) => {
          if (!cursor) return false;
          const cursorAt = Date.parse(cursor.updatedAt);
          return Number.isFinite(cursorAt) && cursorAt >= minCursorAt;
        })
        .filter((cursor): cursor is EditorCursor => Boolean(cursor))
    : [];

  return { roomId, text, version, updatedAt, updatedBy, ...(cursors.length ? { cursors } : {}) };
}

function collectTextParts(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectTextParts(entry));
  if (typeof value !== 'object') return [];

  const obj = value as Record<string, unknown>;
  const direct = ['text', 'value', 'output_text', 'finalResponse', 'aggregatedOutput', 'outputDelta']
    .flatMap((key) => collectTextParts(obj[key]))
    .filter(Boolean);
  const nested = ['content', 'message', 'messages', 'delta', 'result', 'item', 'summary', 'review']
    .flatMap((key) => collectTextParts(obj[key]))
    .filter(Boolean);

  return [...direct, ...nested];
}

function extractItemText(item: unknown): string {
  return collectTextParts(item)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
}

function formatUnknown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractCommandExecutionDetails(item: Record<string, unknown>): string {
  const details: string[] = [];
  const command =
    formatUnknown(item.command) ||
    formatUnknown(item.cmd) ||
    formatUnknown(item.raw_command) ||
    formatUnknown(item.shell_command);
  if (command) details.push(`command: ${command}`);

  const exitCode =
    formatUnknown(item.exit_code) ||
    formatUnknown(item.exitCode) ||
    formatUnknown(item.status_code);
  if (exitCode) details.push(`exit: ${exitCode}`);

  const stdout = formatUnknown(item.stdout) || formatUnknown(item.output);
  if (stdout) details.push(`stdout:\n${stdout}`);

  const stderr = formatUnknown(item.stderr);
  if (stderr) details.push(`stderr:\n${stderr}`);

  const aggregatedOutput = formatUnknown(item.aggregatedOutput) || formatUnknown(item.aggregated_output);
  if (aggregatedOutput) details.push(`output:\n${aggregatedOutput}`);

  const duration = formatUnknown(item.duration_ms) || formatUnknown(item.durationMs);
  if (duration) details.push(`duration_ms: ${duration}`);

  return details.join('\n').trim();
}

function extractFileChangeDetails(item: Record<string, unknown>): string {
  const details: string[] = [];
  const path = formatUnknown(item.path) || formatUnknown(item.file) || formatUnknown(item.filename);
  if (path) details.push(`path: ${path}`);
  const changeType = formatUnknown(item.change_type) || formatUnknown(item.changeType);
  if (changeType) details.push(`change: ${changeType}`);

  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length > 0) {
    const lines = changes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const obj = entry as Record<string, unknown>;
        const entryPath =
          formatUnknown(obj.path) || formatUnknown(obj.file) || formatUnknown(obj.filename);
        const entryKind =
          formatUnknown(obj.kind) || formatUnknown(obj.change_type) || formatUnknown(obj.changeType);
        if (!entryPath && !entryKind) return '';
        if (entryPath && entryKind) return `- ${entryKind}: ${entryPath}`;
        return `- ${entryPath || entryKind}`;
      })
      .filter(Boolean);

    if (lines.length > 0) {
      details.push('files:');
      details.push(...lines);
    }
  }

  const summary = formatUnknown(item.summary);
  if (summary) details.push(summary);

  const diffSnippet = extractDiffSnippet(item);
  if (diffSnippet) details.push(`diff:\n${diffSnippet}`);

  return details.join('\n').trim();
}

function normalizeDiffText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeDiffText(entry)).join('\n');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((entry) => normalizeDiffText(entry))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function looksLikeDiffLine(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('@@') ||
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('+') ||
    line.startsWith('-')
  );
}

function compactDiff(diffText: string, maxLines = 40): string {
  const lines = diffText
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);

  const diffLines = lines.filter((line) => looksLikeDiffLine(line));
  const source = diffLines.length > 0 ? diffLines : lines;
  const sliced = source.slice(0, maxLines);
  const omitted = source.length - sliced.length;
  if (omitted > 0) sliced.push(`... (${omitted} more lines)`);
  return sliced.join('\n').trim();
}

function extractDiffSnippet(item: Record<string, unknown>): string {
  const directCandidates = ['diff', 'patch', 'unified_diff', 'unifiedDiff', 'file_diff', 'fileDiff'];
  for (const key of directCandidates) {
    const raw = item[key];
    if (typeof raw !== 'string') continue;
    const compacted = compactDiff(raw);
    if (compacted) return compacted;
  }

  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const diff = (change as Record<string, unknown>).diff;
    if (typeof diff !== 'string') continue;
    const compacted = compactDiff(diff);
    if (compacted) return compacted;
  }

  return '';
}

function extractUsageTokens(
  usage: unknown
): { input: number; output: number; total: number; cachedInput?: number } | null {
  const usageObj = normalizeUsageObject(usage);
  if (!usageObj) return null;
  const readNum = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const pick = (...values: unknown[]): number => {
    for (const value of values) {
      const n = readNum(value);
      if (n > 0) return n;
    }
    return 0;
  };

  const input = pick(
    usageObj.inputTokens,
    usageObj.input_tokens,
    usageObj.promptTokens,
    usageObj.prompt_tokens
  );
  const inputDetails =
    (usageObj.inputTokensDetails &&
    typeof usageObj.inputTokensDetails === 'object'
      ? (usageObj.inputTokensDetails as Record<string, unknown>)
      : null) ??
    (usageObj.input_tokens_details &&
    typeof usageObj.input_tokens_details === 'object'
      ? (usageObj.input_tokens_details as Record<string, unknown>)
      : null);
  const cachedInput = pick(
    usageObj.cachedInputTokens,
    usageObj.cached_input_tokens,
    inputDetails?.cachedTokens,
    inputDetails?.cached_tokens
  );
  const output = pick(
    usageObj.outputTokens,
    usageObj.output_tokens,
    usageObj.completionTokens,
    usageObj.completion_tokens
  );
  const total = pick(usageObj.totalTokens, usageObj.total_tokens) || input + output;

  if (!input && !output && !total && !cachedInput) return null;
  return { input, output, total, ...(cachedInput ? { cachedInput } : {}) };
}

function extractContextAvailabilityPercent(usage: unknown): number | null {
  const usageObj = normalizeUsageObject(usage);
  if (!usageObj) return null;

  const toNumber = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const pick = (...values: unknown[]): number | null => {
    for (const value of values) {
      const n = toNumber(value);
      if (n !== null) return n;
    }
    return null;
  };

  const percentDirect = pick(
    usageObj.contextAvailablePercent,
    usageObj.context_available_percent,
    usageObj.remainingPercent,
    usageObj.remaining_percent
  );
  if (percentDirect !== null) {
    return Math.min(100, Math.max(0, Math.round(percentDirect)));
  }

  const contextWindow = pick(
    usageObj.contextWindowTokens,
    usageObj.context_window_tokens,
    usageObj.contextWindow,
    usageObj.context_window,
    usageObj.modelContextWindow,
    usageObj.model_context_window,
    usageObj.maxInputTokens,
    usageObj.max_input_tokens,
    usageObj.maxTokens,
    usageObj.max_tokens
  );
  if (!contextWindow || contextWindow <= 0) return null;

  const remaining = pick(
    usageObj.remainingTokens,
    usageObj.remaining_tokens,
    usageObj.availableTokens,
    usageObj.available_tokens,
    usageObj.contextRemainingTokens,
    usageObj.context_remaining_tokens
  );
  if (remaining !== null) {
    return Math.min(100, Math.max(0, Math.round((remaining / contextWindow) * 100)));
  }

  const used = pick(
    usageObj.totalTokens,
    usageObj.total_tokens,
    usageObj.inputTokens,
    usageObj.input_tokens,
    usageObj.promptTokens,
    usageObj.prompt_tokens
  );
  if (used !== null) {
    return Math.min(100, Math.max(0, Math.round(((contextWindow - used) / contextWindow) * 100)));
  }

  return null;
}

function normalizeUsageObject(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const nestedBase =
    (u.usage && typeof u.usage === 'object' ? (u.usage as Record<string, unknown>) : null) ??
    (u.tokenUsage && typeof u.tokenUsage === 'object'
      ? (u.tokenUsage as Record<string, unknown>)
      : null) ??
    (u.token_usage && typeof u.token_usage === 'object'
      ? (u.token_usage as Record<string, unknown>)
      : null);
  const nested = nestedBase ?? u;

  const totalObj =
    nested.total && typeof nested.total === 'object'
      ? (nested.total as Record<string, unknown>)
      : null;
  const lastObj =
    nested.last && typeof nested.last === 'object'
      ? (nested.last as Record<string, unknown>)
      : null;

  // Some app-server variants wrap token counters under `total`/`last`.
  // Flatten preferred counters while preserving root-level fields
  // like `modelContextWindow`.
  if (totalObj || lastObj) {
    return {
      ...nested,
      ...(totalObj ?? lastObj ?? {})
    };
  }

  return nested;
}

function extractItemDetails(item: unknown, itemType: string): string {
  const asObject = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};

  if (itemType === 'reasoning') {
    const summary = extractItemText(asObject.summary);
    const content = extractItemText(asObject.content);
    const parts = [summary, content].filter(Boolean);
    return parts.join('\n').trim();
  }

  if (itemType === 'command_execution') {
    return extractCommandExecutionDetails(asObject);
  }

  if (itemType === 'file_change') {
    return extractFileChangeDetails(asObject);
  }

  if (itemType === 'mcp_tool_call' || itemType === 'collab_tool_call') {
    const parts = [
      formatUnknown(asObject.server) ? `server: ${formatUnknown(asObject.server)}` : '',
      formatUnknown(asObject.tool) ? `tool: ${formatUnknown(asObject.tool)}` : '',
      formatUnknown(asObject.status) ? `status: ${formatUnknown(asObject.status)}` : '',
      formatUnknown(asObject.arguments) ? `arguments: ${formatUnknown(asObject.arguments)}` : '',
      formatUnknown(asObject.result) ? `result: ${formatUnknown(asObject.result)}` : '',
      formatUnknown(asObject.error) ? `error: ${formatUnknown(asObject.error)}` : ''
    ].filter(Boolean);
    return parts.join('\n').trim();
  }

  if (itemType === 'web_search') {
    const parts = [
      formatUnknown(asObject.query) ? `query: ${formatUnknown(asObject.query)}` : '',
      formatUnknown(asObject.action) ? `action: ${formatUnknown(asObject.action)}` : ''
    ].filter(Boolean);
    return parts.join('\n').trim();
  }

  return '';
}

function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function normalizeItemType(type: unknown): string {
  if (typeof type !== 'string') return 'unknown';
  const map: Record<string, string> = {
    userMessage: 'user_message',
    agentMessage: 'agent_message',
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

function asIsoDate(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }

  return fallback;
}

function readUserPrompt(turn: any): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'userMessage' && item.type !== 'user_message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const parts = content
      .map((entry: any) => (entry?.type === 'text' && typeof entry?.text === 'string' ? entry.text : ''))
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n').trim();
  }

  const input = Array.isArray(turn?.input) ? turn.input : [];
  const parts = input
    .map((entry: any) => (entry?.type === 'text' && typeof entry?.text === 'string' ? entry.text : ''))
    .filter(Boolean);
  return parts.join('\n').trim();
}

function readFinalResponse(turn: any): string {
  if (typeof turn?.finalResponse === 'string') return turn.finalResponse;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    const type = normalizeItemType(item.type);
    if (type === 'agent_message') return extractItemText(item);
  }
  return '';
}

function extractTurnUsage(turn: any): { usage: unknown; source: string | null } {
  const candidates: Array<{ source: string; value: unknown }> = [
    { source: 'turn.usage', value: turn?.usage },
    { source: 'turn.tokenUsage', value: turn?.tokenUsage },
    { source: 'turn.token_usage', value: turn?.token_usage },
    { source: 'turn.result.usage', value: turn?.result?.usage },
    { source: 'turn.result.tokenUsage', value: turn?.result?.tokenUsage },
    { source: 'turn.result.token_usage', value: turn?.result?.token_usage },
    { source: 'turn.metadata.usage', value: turn?.metadata?.usage },
    { source: 'turn.metadata.tokenUsage', value: turn?.metadata?.tokenUsage },
    { source: 'turn.metadata.token_usage', value: turn?.metadata?.token_usage },
    { source: 'turn.stats.usage', value: turn?.stats?.usage },
    { source: 'turn.stats.tokenUsage', value: turn?.stats?.tokenUsage },
    { source: 'turn.stats.token_usage', value: turn?.stats?.token_usage }
  ];

  for (const candidate of candidates) {
    if (candidate.value && typeof candidate.value === 'object') {
      return { usage: candidate.value, source: candidate.source };
    }
  }

  return { usage: undefined, source: null };
}

export class RoomStore {
  private rooms = new Map<string, RoomState>();
  private readonly storagePath: string;
  private readonly workspace: string;
  private readonly legacyStoragePaths: string[];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly logger: AppLogger, workspace = process.env.NLK_WORKDIR ?? process.cwd()) {
    this.workspace = resolve(workspace);
    const explicitStoragePath = process.env.NLK_ROOMS_STORAGE_PATH?.trim();
    this.storagePath =
      explicitStoragePath ||
      resolve(homedir(), '.codex-room', 'workspaces', workspaceStorageKey(this.workspace), 'rooms.json');
    this.legacyStoragePaths = explicitStoragePath
      ? []
      : [...new Set([
          resolve(this.workspace, 'backend/.data/rooms.json'),
          resolve(this.workspace, '.data/rooms.json'),
          resolve(process.cwd(), 'backend/.data/rooms.json'),
          resolve(process.cwd(), '.data/rooms.json')
        ])].filter((candidate) => candidate !== this.storagePath);
    this.loadFromDisk();
  }

  getRoom(roomId: string): RoomState {
    const existing = this.rooms.get(roomId);
    if (existing) {
      if (existing.workspace && existing.workspace !== this.workspace) {
        throw new Error('Room belongs to a different workspace');
      }
      return existing;
    }

    const created: RoomState = {
      roomId,
      workspace: this.workspace,
      messages: [],
      timeline: [],
      editor: {
        roomId,
        text: '',
        version: 0,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
        cursors: []
      },
      subscribers: new Set(),
      updatedAt: new Date().toISOString()
    };

    this.rooms.set(roomId, created);
    this.logger.info('room.created', { roomId });
    return created;
  }

  getSnapshot(roomId: string) {
    const room = this.getRoom(roomId);
    this.logger.debug('room.snapshot.read', {
      roomId,
      messageCount: room.messages.length,
      timelineCount: room.timeline.length,
      subscriberCount: room.subscribers.size,
      hasThreadId: Boolean(room.threadId)
    });
    return {
      roomId,
      messages: room.messages,
      timeline: room.timeline,
      editor: room.editor,
      threadId: room.threadId,
      updatedAt: room.updatedAt
    };
  }

  listRooms(limit = 30): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.workspace === this.workspace)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((room) => ({
        roomId: room.roomId,
        updatedAt: room.updatedAt,
        messageCount: room.messages.length,
        timelineCount: room.timeline.length,
        hasThreadId: Boolean(room.threadId),
        preview: room.timeline.at(-1)?.text?.slice(0, 140)
      }));
  }

  setThreadId(roomId: string, threadId: string) {
    const room = this.getRoom(roomId);
    room.threadId = threadId;
    this.touchRoom(room);
    this.schedulePersist();
    this.logger.info('room.thread.updated', { roomId, threadId });
  }

  hydrateFromThreadRead(
    roomId: string,
    threadRead: { id: string; turns: any[] },
    options?: { replace?: boolean }
  ): number {
    const room = this.getRoom(roomId);
    const shouldReplace = options?.replace === true;
    if (room.timeline.length > 0 && !shouldReplace) {
      this.logger.info('room.thread.hydration.skipped', {
        roomId,
        threadId: threadRead.id,
        reason: 'timeline_not_empty'
      });
      return 0;
    }
    if (shouldReplace) {
      room.messages = [];
      room.timeline = [];
      this.touchRoom(room);
      this.logger.info('room.thread.hydration.reset', {
        roomId,
        threadId: threadRead.id
      });
    }

    let imported = 0;
    const turns = Array.isArray(threadRead.turns) ? threadRead.turns : [];
    for (const turn of turns) {
      const baseAt = asIsoDate(turn?.createdAt ?? turn?.created_at, new Date().toISOString());
      const prompt = readUserPrompt(turn);

      this.publish(roomId, {
        type: 'codex.turn.started',
        roomId,
        prompt: prompt || '(resumed turn)',
        at: baseAt
      });
      imported++;

      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const rawItem of items) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const itemType = normalizeItemType((rawItem as Record<string, unknown>).type);
        if (itemType === 'user_message') continue;

        this.publish(roomId, {
          type: 'codex.item.completed',
          item: { ...(rawItem as Record<string, unknown>), type: itemType },
          at: asIsoDate(
            (rawItem as Record<string, unknown>).createdAt ??
              (rawItem as Record<string, unknown>).created_at ??
              turn?.updatedAt ??
              turn?.updated_at,
            baseAt
          )
        });
        imported++;
      }

      const status = turn?.status;
      if (status === 'failed') {
        const error = turn?.error?.message ?? 'Turn failed';
        this.publish(roomId, {
          type: 'codex.turn.failed',
          error,
          at: asIsoDate(turn?.updatedAt ?? turn?.updated_at, baseAt)
        });
        imported++;
      } else {
        const turnUsage = extractTurnUsage(turn);
        this.logger.debug('room.thread.hydration.turn.usage', {
          roomId,
          threadId: threadRead.id,
          turnId: turn?.id,
          usageSource: turnUsage.source,
          hasUsage: Boolean(turnUsage.usage),
          turnKeys: turn && typeof turn === 'object' ? Object.keys(turn).slice(0, 40) : []
        });
        this.publish(roomId, {
          type: 'codex.turn.completed',
          finalResponse: readFinalResponse(turn),
          usage: turnUsage.usage,
          at: asIsoDate(turn?.updatedAt ?? turn?.updated_at, baseAt)
        });
        imported++;
      }
    }

    this.logger.info('room.thread.hydration.completed', {
      roomId,
      threadId: threadRead.id,
      turns: turns.length,
      imported
    });
    return imported;
  }

  addMessage(roomId: string, userId: string, userName: string, text: string) {
    const room = this.getRoom(roomId);
    const message: ChatMessage = {
      id: nanoid(),
      roomId,
      userId,
      userName,
      text,
      createdAt: new Date().toISOString()
    };

    room.messages.push(message);
    this.addTimelineEntry(
      roomId,
      {
        side: 'left',
        label: userName,
        text,
        at: message.createdAt,
        meta: { kind: 'user.message' }
      }
    );
    this.touchRoom(room);
    this.schedulePersist();
    this.logger.info('room.message.added', {
      roomId,
      messageId: message.id,
      userId,
      userName,
      length: text.length
    });
    this.publish(roomId, { type: 'chat.message', message });
    return message;
  }

  updateEditor(
    roomId: string,
    userId: string,
    text: string,
    options?: { userName?: string; selectionStart?: number; selectionEnd?: number; baseVersion?: number }
  ) {
    const room = this.getRoom(roomId);
    const currentVersion =
      typeof room.editor.version === 'number' && Number.isFinite(room.editor.version) ? room.editor.version : 0;
    const baseVersion = toFiniteNonNegativeInteger(options?.baseVersion);
    const isStaleWrite =
      baseVersion !== null &&
      baseVersion !== currentVersion &&
      room.editor.updatedBy !== userId &&
      room.editor.text !== text;
    if (isStaleWrite) {
      throw new EditorConflictError('Editor has been updated by another collaborator', room.editor);
    }
    const updatedAt = new Date().toISOString();
    const parsedUpdatedAt = Date.parse(updatedAt);
    const maxAge = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt - EDITOR_CURSOR_TTL_MS : Number.NEGATIVE_INFINITY;
    const currentCursors = Array.isArray(room.editor.cursors) ? room.editor.cursors : [];
    const nextCursors = currentCursors.filter((cursor) => {
      const cursorAt = Date.parse(cursor.updatedAt);
      return Number.isFinite(cursorAt) && cursorAt >= maxAge && cursor.userId !== userId;
    });
    const selection = normalizeSelection(options?.selectionStart, options?.selectionEnd, text.length);
    nextCursors.push({
      userId,
      userName: options?.userName?.trim() || userId,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      updatedAt
    });
    const editor: EditorState = {
      roomId,
      text,
      version: currentVersion + 1,
      updatedAt,
      updatedBy: userId,
      cursors: nextCursors
    };

    room.editor = editor;
    this.touchRoom(room);
    this.schedulePersist();
    this.logger.debug('room.editor.updated', {
      roomId,
      userId,
      length: text.length,
      cursorCount: nextCursors.length
    });
    this.publish(roomId, { type: 'editor.updated', editor });
    return editor;
  }

  publish(roomId: string, event: RoomEvent) {
    const room = this.getRoom(roomId);
    this.maybeAddCodexTimeline(roomId, event);
    this.logger.debug('room.event.published', {
      roomId,
      eventType: event.type,
      subscriberCount: room.subscribers.size
    });
    this.emit(room, event);
  }

  subscribe(roomId: string, subscriber: Subscriber) {
    const room = this.getRoom(roomId);
    room.subscribers.add(subscriber);
    this.logger.info('room.subscriber.joined', {
      roomId,
      subscriberCount: room.subscribers.size
    });
    return () => {
      room.subscribers.delete(subscriber);
      this.logger.info('room.subscriber.left', {
        roomId,
        subscriberCount: room.subscribers.size
      });
    };
  }

  private maybeAddCodexTimeline(roomId: string, event: RoomEvent) {
    if (event.type === 'codex.turn.started') {
      this.addTimelineEntry(roomId, {
        side: 'right',
        label: 'codex',
        text: `Started: ${event.prompt}`,
        at: event.at,
        meta: {
          kind: 'codex.started',
          model: event.model,
          reasoningEffort: event.reasoningEffort
        }
      });
      return;
    }

    if (event.type === 'codex.item.completed') {
      const itemType = event.item.type ?? 'unknown';
      if (itemType === 'user_message') return;
      if (itemType === 'file_change') {
        this.logger.info('codex.file_change.raw_item', {
          roomId,
          item: event.item
        });
      }
      const itemText = extractItemText(event.item);
      const details = extractItemDetails(event.item as unknown, itemType);
      const parts = itemType === 'file_change' ? [details] : [itemText, details];
      const seen = new Set<string>();
      const content = parts
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .filter((part) => {
          if (seen.has(part)) return false;
          seen.add(part);
          return true;
        })
        .join('\n');
      const fallback =
        !content && itemType !== 'agent_message' ? `raw:\n${safePrettyJson(event.item)}` : '';
      this.addTimelineEntry(roomId, {
        side: 'right',
        label: 'codex',
        text: `Item: ${itemType}${content ? `\n${content}` : fallback ? `\n${fallback}` : ''}`,
        at: event.at,
        meta: { kind: 'codex.item', itemType }
      });
      return;
    }

    if (event.type === 'codex.turn.completed') {
      const response = event.finalResponse?.trim() ?? '';
      const shouldIncludeFinal = response.length > 0 && !this.matchesLastAgentMessage(roomId, response);
      const usage = extractUsageTokens(event.usage);
      const contextAvailablePercent = extractContextAvailabilityPercent(event.usage);
      this.logger.debug('codex.turn.completed.usage.inspect', {
        roomId,
        hasUsage: Boolean(event.usage),
        usageParsed: Boolean(usage),
        contextPercentParsed: contextAvailablePercent ?? null,
        usageRaw: safeJsonSnippet(event.usage),
        usageNormalizedRaw: safeJsonSnippet(normalizeUsageObject(event.usage))
      });
      const usageText = usage
        ? `\nTokens: in ${usage.input}${usage.cachedInput ? ` (cached ${usage.cachedInput})` : ''} · out ${usage.output} · total ${usage.total}`
        : '';
      const contextText =
        contextAvailablePercent !== null ? `\nContext: ${contextAvailablePercent}% available` : '';
      this.addTimelineEntry(roomId, {
        side: 'right',
        label: 'codex',
        text: `Turn completed${usageText}${contextText}${shouldIncludeFinal ? `\nFinal response\n${event.finalResponse}` : ''}`,
        at: event.at,
        meta: { kind: 'codex.completed' }
      });
      return;
    }

    if (event.type === 'codex.turn.failed') {
      this.addTimelineEntry(roomId, {
        side: 'right',
        label: 'codex',
        text: `Error: ${event.error}`,
        at: event.at,
        meta: { kind: 'codex.failed' }
      });
      return;
    }

    if (event.type === 'codex.turn.interrupted') {
      this.addTimelineEntry(roomId, {
        side: 'right',
        label: 'codex',
        text: 'Turn interrupted',
        at: event.at,
        meta: { kind: 'codex.interrupted' }
      });
    }
  }

  private addTimelineEntry(
    roomId: string,
    input: Omit<TimelineEntry, 'id' | 'roomId'>,
    emit = true
  ): TimelineEntry {
    const room = this.getRoom(roomId);
    const entry: TimelineEntry = {
      id: nanoid(),
      roomId,
      ...input
    };

    room.timeline.push(entry);
    this.touchRoom(room);
    this.schedulePersist();
    this.logger.debug('room.timeline.entry.added', {
      roomId,
      entryId: entry.id,
      side: entry.side,
      label: entry.label
    });

    if (emit) this.emit(room, { type: 'timeline.entry', entry });
    return entry;
  }

  private emit(room: RoomState, event: RoomEvent) {
    for (const subscriber of room.subscribers) subscriber(event);
  }

  private touchRoom(room: RoomState) {
    room.updatedAt = new Date().toISOString();
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDisk();
    }, 150);
  }

  private loadFromDisk() {
    try {
      const sourcePath = existsSync(this.storagePath)
        ? this.storagePath
        : this.legacyStoragePaths.find((candidate) => existsSync(candidate));
      if (!sourcePath) return;
      const raw = readFileSync(sourcePath, 'utf-8');
      const parsed = JSON.parse(raw) as { rooms?: PersistedRoomState[] };
      const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      for (const room of rooms) {
        const roomWorkspace = typeof room.workspace === 'string' ? resolve(room.workspace) : '';
        if (!roomWorkspace || roomWorkspace !== this.workspace) {
          continue;
        }
        this.rooms.set(room.roomId, {
          roomId: room.roomId,
          workspace: roomWorkspace,
          messages: Array.isArray(room.messages) ? room.messages : [],
          timeline: Array.isArray(room.timeline) ? room.timeline : [],
          editor: normalizeEditor(room.editor, room.roomId),
          subscribers: new Set(),
          threadId: room.threadId,
          updatedAt: room.updatedAt ?? new Date().toISOString()
        });
      }
      this.logger.info('room.storage.loaded', {
        storagePath: sourcePath,
        rooms: rooms.length
      });
      if (sourcePath !== this.storagePath) {
        this.logger.info('room.storage.migrating', {
          from: sourcePath,
          to: this.storagePath
        });
        this.persistToDisk();
      }
    } catch (error) {
      this.logger.error('room.storage.load_failed', {
        storagePath: this.storagePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private persistToDisk() {
    try {
      const payload = {
        rooms: [...this.rooms.values()].map<PersistedRoomState>((room) => ({
          roomId: room.roomId,
          workspace: room.workspace,
          messages: room.messages,
          timeline: room.timeline,
          editor: room.editor,
          threadId: room.threadId,
          updatedAt: room.updatedAt
        }))
      };

      mkdirSync(dirname(this.storagePath), { recursive: true });
      writeFileSync(this.storagePath, JSON.stringify(payload), 'utf-8');
    } catch (error) {
      this.logger.error('room.storage.persist_failed', {
        storagePath: this.storagePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private matchesLastAgentMessage(roomId: string, finalResponse: string): boolean {
    const room = this.getRoom(roomId);
    for (let i = room.timeline.length - 1; i >= 0; i--) {
      const entry = room.timeline[i];
      if (entry.meta?.kind === 'codex.started') break;
      if (entry.meta?.kind === 'codex.item' && entry.meta?.itemType === 'agent_message') {
        const candidate = entry.text
          .replace(/^Item:\s*agent_message\n?/, '')
          .trim();
        return candidate === finalResponse.trim();
      }
    }
    return false;
  }
}
