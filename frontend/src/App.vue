<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { EditorCursor, RoomEvent, TimelineEntry } from '@codex-room/shared';
import DiffPatch from './components/DiffPatch.vue';

const query = new URLSearchParams(window.location.search);
const API = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
const CONTEXT_WINDOW_TOKENS = Number((import.meta.env.VITE_CONTEXT_WINDOW_TOKENS as string | undefined) ?? '200000');
const roomFromQuery = query.get('room');
const initialRoomId = roomFromQuery ?? 'main';
const roomId = ref(initialRoomId);
const view = ref<'home' | 'chat'>(roomFromQuery ? 'chat' : 'home');
const userId = ref(`u-${Math.random().toString(36).slice(2, 8)}`);
const userName = ref(`user-${Math.random().toString(36).slice(2, 5)}`);
const workingDirectory = ref<string>('');
type CodexThreadSummary = {
  id: string;
  preview?: string;
  updatedAt?: number;
  createdAt?: number;
  model?: string;
  cwd?: string;
};
const codexThreads = ref<CodexThreadSummary[]>([]);
const editorEl = ref<HTMLTextAreaElement | null>(null);

const CURSOR_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
];
const REMOTE_CURSOR_MAX_AGE_MS = 20_000;

type CursorOverlay = {
  userId: string;
  userName: string;
  color: string;
  left: number;
  top: number;
  height: number;
};

type LogEntry = {
  id: string;
  side: 'left' | 'right';
  label: string;
  text: string;
  at: string;
  meta?: TimelineEntry['meta'];
};

const logEntries = ref<LogEntry[]>([]);
const editorText = ref('');
const editorCursors = ref<EditorCursor[]>([]);
const cursorOverlays = ref<CursorOverlay[]>([]);
const running = ref(false);
const timelineEl = ref<HTMLElement | null>(null);
const activeTaskStartedAt = ref<number | null>(null);
const workingSeconds = ref(0);
type UsageDisplay = {
  input: number;
  output: number;
  total: number;
  cachedInput?: number;
  contextAvailablePercent?: number;
};
const usageByTurnAt = ref(new Map<string, UsageDisplay>());
const latestUsageFromEvent = ref<UsageDisplay | null>(null);

let eventsAbortController: AbortController | null = null;
let editorTimer: number | null = null;
let workingTimer: number | null = null;
let applyingRemoteEditorUpdate = false;
let eventsConnectionSeq = 0;

const canSend = computed(() => editorText.value.trim().length > 0 && !running.value);

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorForUser(user: string): string {
  return CURSOR_COLORS[hashString(user) % CURSOR_COLORS.length] ?? CURSOR_COLORS[0];
}

function toMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function clampCursorPosition(position: number, textLength: number): number {
  return Math.min(textLength, Math.max(0, Math.floor(position)));
}

function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number) {
  const doc = textarea.ownerDocument;
  const mirror = doc.createElement('div');
  const marker = doc.createElement('span');
  const style = window.getComputedStyle(textarea);

  const text = textarea.value;
  const before = text.slice(0, position);

  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordBreak = 'break-word';
  mirror.style.overflow = 'hidden';
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = `${textarea.clientHeight}px`;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.style.font = style.font;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.textTransform = style.textTransform;
  mirror.style.textIndent = style.textIndent;
  mirror.style.tabSize = style.tabSize;

  mirror.textContent = before;
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;
  const lineHeight = Number.parseFloat(style.lineHeight) || Math.ceil(Number.parseFloat(style.fontSize) * 1.3);

  doc.body.removeChild(mirror);
  return { left, top, height: lineHeight };
}

function refreshCursorOverlays() {
  const el = editorEl.value;
  if (!el) {
    cursorOverlays.value = [];
    return;
  }
  const now = Date.now();
  const next: CursorOverlay[] = [];

  for (const cursor of editorCursors.value) {
    if (!cursor || cursor.userId === userId.value) continue;
    if (!cursor.updatedAt || now - toMs(cursor.updatedAt) > REMOTE_CURSOR_MAX_AGE_MS) continue;
    const index = clampCursorPosition(cursor.selectionEnd ?? cursor.selectionStart ?? 0, editorText.value.length);
    const coords = getCaretCoordinates(el, index);
    if (coords.top + coords.height < 0 || coords.top > el.clientHeight) continue;
    next.push({
      userId: cursor.userId,
      userName: cursor.userName || cursor.userId,
      color: colorForUser(cursor.userId),
      left: Math.max(0, coords.left),
      top: Math.max(0, coords.top),
      height: coords.height
    });
  }

  cursorOverlays.value = next;
}

function normalizeMeta(entry: Pick<LogEntry, 'meta' | 'text' | 'side'>): NonNullable<LogEntry['meta']> {
  if (entry.meta) return entry.meta;
  if (entry.side === 'left') return { kind: 'user.message' };
  if (entry.text.startsWith('Started:')) return { kind: 'codex.started' };
  if (entry.text.startsWith('Turn completed')) return { kind: 'codex.completed' };
  if (entry.text.startsWith('Error:')) return { kind: 'codex.failed' };
  if (entry.text.startsWith('Item:')) {
    const firstLine = entry.text.split('\n')[0] ?? '';
    const itemType = firstLine.replace('Item:', '').trim() || 'unknown';
    return { kind: 'codex.item', itemType };
  }
  return { kind: 'codex.item', itemType: 'unknown' };
}

function isEmptyRawReasoning(text: string): boolean {
  const normalized = text.trim();
  if (!normalized.startsWith('Item: reasoning')) return false;
  if (!normalized.includes('\nraw:\n')) return false;
  return (
    /"summary"\s*:\s*\[\s*\]/.test(normalized) &&
    /"content"\s*:\s*\[\s*\]/.test(normalized)
  );
}

function isHiddenItem(entry: Pick<LogEntry, 'meta' | 'text' | 'side'>): boolean {
  const meta = normalizeMeta(entry);
  if (meta.kind !== 'codex.item') return false;
  const itemType = (meta.itemType ?? '').toLowerCase();
  if (itemType === 'user_message' || itemType === 'usermessage') return true;
  if (itemType === 'reasoning' && isEmptyRawReasoning(entry.text)) return true;
  const firstLine = entry.text.split('\n')[0]?.trim().toLowerCase() ?? '';
  return firstLine === 'item: user_message' || firstLine === 'item: usermessage';
}

function badgeText(entry: LogEntry): string {
  const meta = normalizeMeta(entry);
  if (meta.kind === 'user.message') return 'user';
  if (meta.kind === 'codex.started') return 'started';
  if (meta.kind === 'codex.completed') return 'done';
  if (meta.kind === 'codex.failed') return 'error';
  return meta.itemType ?? 'item';
}

function badgeClass(entry: LogEntry): string {
  const meta = normalizeMeta(entry);
  if (meta.kind === 'user.message') return 'bg-neutral-100 text-neutral-500';
  if (meta.kind === 'codex.started') return 'bg-blue-50 text-blue-600';
  if (meta.kind === 'codex.completed') return 'bg-emerald-50 text-emerald-600';
  if (meta.kind === 'codex.failed') return 'bg-red-50 text-red-600';
  if (meta.itemType === 'reasoning') return 'bg-amber-50 text-amber-600';
  if (meta.itemType === 'command_execution') return 'bg-indigo-50 text-indigo-600';
  if (meta.itemType === 'file_change') return 'bg-teal-50 text-teal-600';
  if (meta.itemType === 'agent_message') return 'bg-purple-50 text-purple-600';
  return 'bg-neutral-100 text-neutral-500';
}

function bodyText(entry: LogEntry): string {
  const meta = normalizeMeta(entry);
  if (meta.kind === 'codex.item' && entry.text.startsWith('Item:')) {
    const parts = entry.text.split('\n');
    return parts.slice(1).join('\n').trim() || '(no details)';
  }
  if (meta.kind === 'codex.completed' && entry.text.startsWith('Turn completed')) {
    return entry.text.replace(/^Turn completed\n?/, '').trim() || 'Turn completed';
  }
  return entry.text;
}

function pushEntry(entry: Omit<LogEntry, 'id'>) {
  logEntries.value = [
    ...logEntries.value,
    {
      id: `${entry.side}-${entry.at}-${Math.random().toString(36).slice(2, 7)}`,
      ...entry
    }
  ];
}

function getEntryKind(entry: LogEntry): NonNullable<LogEntry['meta']>['kind'] {
  return normalizeMeta(entry).kind;
}

function formatDuration(totalSeconds: number, prefix = ''): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${prefix}${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

const turnDurationByEntryId = computed(() => {
  const map = new Map<string, string>();
  let startedAtMs: number | null = null;
  let lastCodexEntryId: string | null = null;

  for (const entry of logEntries.value) {
    const kind = getEntryKind(entry);

    if (kind === 'user.message') {
      continue;
    }

    if (kind === 'codex.started') {
      const started = new Date(entry.at).getTime();
      startedAtMs = Number.isNaN(started) ? null : started;
      lastCodexEntryId = entry.id;
      continue;
    }

    if (startedAtMs === null) continue;

    if (kind === 'codex.item') {
      lastCodexEntryId = entry.id;
      continue;
    }

    if (kind === 'codex.completed' || kind === 'codex.failed') {
      const ended = new Date(entry.at).getTime();
      const endedMs = Number.isNaN(ended) ? Date.now() : ended;
      const totalSeconds = Math.floor((endedMs - startedAtMs) / 1000);
      map.set(entry.id, formatDuration(totalSeconds, 'Worked '));
      startedAtMs = null;
      lastCodexEntryId = null;
    }
  }

  if (running.value && activeTaskStartedAt.value && lastCodexEntryId) {
    map.set(lastCodexEntryId, formatDuration(workingSeconds.value, 'Working '));
  }

  return map;
});

function durationLabel(entry: LogEntry): string | null {
  return turnDurationByEntryId.value.get(entry.id) ?? null;
}

function formatThreadTime(unixSeconds?: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return 'unknown';
  return new Date(unixSeconds * 1000).toLocaleString();
}

// ── Display groups ────────────────────────────────────────────────

type TurnGroup = {
  type: 'turn';
  id: string;
  startEntry: LogEntry;
  items: LogEntry[];
  endEntry?: LogEntry;
};

type MessageGroup = {
  type: 'message';
  id: string;
  entry: LogEntry;
};

type DisplayGroup = TurnGroup | MessageGroup;

const groups = computed<DisplayGroup[]>(() => {
  const result: DisplayGroup[] = [];
  let current: TurnGroup | null = null;

  for (const entry of logEntries.value) {
    const kind = getEntryKind(entry);

    if (kind === 'user.message') {
      if (current) { result.push(current); current = null; }
      result.push({ type: 'message', id: entry.id, entry });
      continue;
    }
    if (kind === 'codex.started') {
      if (current) result.push(current);
      current = { type: 'turn', id: entry.id, startEntry: entry, items: [] };
      continue;
    }
    if (kind === 'codex.completed' || kind === 'codex.failed') {
      if (current) { current.endEntry = entry; result.push(current); current = null; }
      continue;
    }
    if (current) current.items.push(entry);
    else result.push({ type: 'message', id: entry.id, entry });
  }

  if (current) result.push(current);
  return result;
});

function turnPrompt(group: TurnGroup): string {
  const t = group.startEntry.text;
  return t.startsWith('Started:') ? t.slice(8).trim() : t;
}

function turnIsRunning(group: TurnGroup): boolean {
  return !group.endEntry && running.value;
}

function turnStatusClass(group: TurnGroup): string {
  if (turnIsRunning(group)) return 'bg-amber-400 animate-pulse';
  if (!group.endEntry) return 'bg-neutral-300';
  return getEntryKind(group.endEntry) === 'codex.completed' ? 'bg-emerald-400' : 'bg-red-400';
}

function turnMeta(group: TurnGroup): string {
  const meta = group.startEntry.meta;
  const time = new Date(group.startEntry.at).toLocaleTimeString();
  const modelPart = meta?.model ? ` · ${meta.model}` : '';
  const effortPart = meta?.reasoningEffort ? ` · effort:${meta.reasoningEffort}` : '';
  if (turnIsRunning(group)) return `${time} · ${formatDuration(workingSeconds.value)}${modelPart}${effortPart}`;
  if (!group.endEntry) return `${time}${modelPart}${effortPart}`;
  const dur = durationLabel(group.endEntry)?.replace('Worked ', '') ?? '';
  const base = dur ? `${time} · ${dur}` : time;
  return `${base}${modelPart}${effortPart}`;
}

function turnUsage(group: TurnGroup): string | null {
  const end = group.endEntry;
  if (!end || getEntryKind(end) !== 'codex.completed') return null;
  const usageFromEvent = usageByTurnAt.value.get(end.at);
  if (usageFromEvent) {
    return `in ${usageFromEvent.input}${usageFromEvent.cachedInput ? ` (cached ${usageFromEvent.cachedInput})` : ''} · out ${usageFromEvent.output} · total ${usageFromEvent.total}`;
  }
  const match = end.text.match(/^Tokens:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function turnContext(group: TurnGroup): string | null {
  const end = group.endEntry;
  if (!end || getEntryKind(end) !== 'codex.completed') return null;
  const fromUsage = usageByTurnAt.value.get(end.at)?.contextAvailablePercent;
  if (typeof fromUsage === 'number') return `${fromUsage}% available`;
  const match = end.text.match(/^Context:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function turnMetaTitle(group: TurnGroup): string {
  const details: string[] = [turnMeta(group)];
  const usage = turnUsage(group);
  if (usage) details.push(`Tokens: ${usage}`);
  const context = turnContext(group);
  if (context) details.push(`Context: ${context}`);
  return details.join('\n');
}

function parseContextAvailablePercent(text: string): number | null {
  const match = text.match(/^Context:\s*(\d{1,3})%\s*available$/m);
  if (!match) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function parseTotalTokens(text: string): number | null {
  const match = text.match(/^Tokens:\s*.*\btotal\s+(\d+)\b/m);
  if (!match) return null;
  const total = Number(match[1]);
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
}

function estimateContextAvailablePercent(totalTokens: number): number | null {
  if (!Number.isFinite(CONTEXT_WINDOW_TOKENS) || CONTEXT_WINDOW_TOKENS <= 0) return null;
  const available = ((CONTEXT_WINDOW_TOKENS - totalTokens) / CONTEXT_WINDOW_TOKENS) * 100;
  return Math.min(100, Math.max(0, Math.round(available)));
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = toFiniteNumber(obj[key]);
    if (n !== null) return n;
  }
  return null;
}

function normalizeUsagePayload(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const nested =
    (u.usage && typeof u.usage === 'object' ? (u.usage as Record<string, unknown>) : null) ??
    (u.tokenUsage && typeof u.tokenUsage === 'object' ? (u.tokenUsage as Record<string, unknown>) : null) ??
    (u.token_usage && typeof u.token_usage === 'object' ? (u.token_usage as Record<string, unknown>) : null) ??
    u;
  const totalObj =
    nested.total && typeof nested.total === 'object' ? (nested.total as Record<string, unknown>) : null;
  const lastObj =
    nested.last && typeof nested.last === 'object' ? (nested.last as Record<string, unknown>) : null;
  return { ...nested, ...(totalObj ?? lastObj ?? {}) };
}

function usageFromEvent(usage: unknown): UsageDisplay | null {
  const obj = normalizeUsagePayload(usage);
  if (!obj) return null;

  const input = pickNumber(obj, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) ?? 0;
  const output = pickNumber(obj, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) ?? 0;
  const total = pickNumber(obj, ['totalTokens', 'total_tokens']) ?? input + output;
  const cachedInput =
    pickNumber(obj, ['cachedInputTokens', 'cached_input_tokens']) ??
    (obj.inputTokensDetails && typeof obj.inputTokensDetails === 'object'
      ? pickNumber(obj.inputTokensDetails as Record<string, unknown>, ['cachedTokens', 'cached_tokens'])
      : null) ??
    (obj.input_tokens_details && typeof obj.input_tokens_details === 'object'
      ? pickNumber(obj.input_tokens_details as Record<string, unknown>, ['cachedTokens', 'cached_tokens'])
      : null) ??
    null;

  const directPercent = pickNumber(obj, [
    'contextAvailablePercent',
    'context_available_percent',
    'remainingPercent',
    'remaining_percent'
  ]);
  const contextWindow = pickNumber(obj, [
    'modelContextWindow',
    'model_context_window',
    'contextWindowTokens',
    'context_window_tokens',
    'contextWindow',
    'context_window',
    'maxInputTokens',
    'max_input_tokens',
    'maxTokens',
    'max_tokens'
  ]);
  const remaining = pickNumber(obj, [
    'remainingTokens',
    'remaining_tokens',
    'availableTokens',
    'available_tokens',
    'contextRemainingTokens',
    'context_remaining_tokens'
  ]);
  const derivedPercent =
    directPercent ??
    (contextWindow && remaining !== null ? (remaining / contextWindow) * 100 : null) ??
    (contextWindow ? ((contextWindow - total) / contextWindow) * 100 : null);
  const contextAvailablePercent =
    derivedPercent === null ? undefined : Math.min(100, Math.max(0, Math.round(derivedPercent)));

  if (!input && !output && !total && contextAvailablePercent === undefined) return null;
  return {
    input,
    output,
    total,
    ...(cachedInput && cachedInput > 0 ? { cachedInput } : {}),
    ...(contextAvailablePercent !== undefined ? { contextAvailablePercent } : {})
  };
}

const latestContextAvailablePercent = computed(() => {
  for (let i = groups.value.length - 1; i >= 0; i -= 1) {
    const group = groups.value[i];
    if (group.type !== 'turn' || !group.endEntry) continue;
    const percent = parseContextAvailablePercent(group.endEntry.text);
    if (percent !== null) return percent;
  }
  return null;
});

const contextAvailabilityText = computed(() => {
  if (latestUsageFromEvent.value?.contextAvailablePercent !== undefined) {
    return `Context available: ${latestUsageFromEvent.value.contextAvailablePercent}%`;
  }
  if (latestContextAvailablePercent.value !== null) {
    return `Context available: ${latestContextAvailablePercent.value}%`;
  }
  for (let i = groups.value.length - 1; i >= 0; i -= 1) {
    const group = groups.value[i];
    if (group.type !== 'turn' || !group.endEntry) continue;
    const total = parseTotalTokens(group.endEntry.text);
    if (total === null) continue;
    const estimated = estimateContextAvailablePercent(total);
    if (estimated !== null) return `Context available: ~${estimated}%`;
  }
  return 'Context available: --%';
});

type TurnSegment =
  | { type: 'message'; id: string; entry: LogEntry }
  | { type: 'tech'; id: string; items: LogEntry[] };

function turnSegments(group: TurnGroup): TurnSegment[] {
  const result: TurnSegment[] = [];
  let batch: LogEntry[] = [];

  const flushBatch = () => {
    if (batch.length > 0) {
      result.push({ type: 'tech', id: batch[0].id, items: batch });
      batch = [];
    }
  };

  for (const item of group.items) {
    if (isHiddenItem(item)) continue;
    if (normalizeMeta(item).itemType === 'agent_message') {
      flushBatch();
      result.push({ type: 'message', id: item.id, entry: item });
    } else {
      batch.push(item);
    }
  }
  flushBatch();

  return result;
}

const expandedIds = ref(new Set<string>());

function toggleExpanded(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

function isExpanded(id: string): boolean {
  return !expandedIds.value.has(id);
}

function itemLabel(item: LogEntry): string {
  const meta = normalizeMeta(item);
  const map: Record<string, string> = {
    reasoning: 'think',
    command_execution: 'cmd',
    file_change: 'file',
    mcp_tool_call: 'tool',
    collab_tool_call: 'tool',
    web_search: 'web',
    image_view: 'img'
  };
  return map[meta.itemType ?? ''] ?? (meta.itemType ?? 'item');
}

function itemBody(item: LogEntry): string {
  const meta = normalizeMeta(item);
  const text = bodyText(item);
  if (meta.itemType === 'command_execution') {
    const lines = text.split('\n');
    const cmd = lines.find(l => l.startsWith('command:'))?.replace('command:', '').trim() ?? text;
    const exit = lines.find(l => l.startsWith('exit:'))?.trim() ?? '';
    const markerSet = new Set(['command:', 'exit:', 'stdout:', 'stderr:', 'output:', 'duration_ms:']);
    const collectBlock = (marker: string): string => {
      const start = lines.findIndex((line) => line.startsWith(marker));
      if (start === -1) return '';
      const out: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if ([...markerSet].some((prefix) => line.startsWith(prefix))) break;
        out.push(line);
      }
      return out.join('\n').trim();
    };

    const output = collectBlock('output:');
    const stdout = collectBlock('stdout:');
    const stderr = collectBlock('stderr:');
    const sections: string[] = [];
    if (output) sections.push(`output:\n${output}`);
    if (stdout) sections.push(`stdout:\n${stdout}`);
    if (stderr) sections.push(`stderr:\n${stderr}`);

    const header = exit ? `${cmd}  [${exit}]` : cmd;
    return sections.length > 0 ? `${header}\n${sections.join('\n\n')}` : header;
  }
  if (meta.itemType === 'reasoning') return text.replace(/\*\*/g, '');
  return text;
}

function itemTextClass(item: LogEntry): string {
  const meta = normalizeMeta(item);
  if (meta.itemType === 'reasoning') return 'text-neutral-500 italic';
  if (meta.itemType === 'command_execution') return 'font-mono text-neutral-700';
  if (meta.itemType === 'file_change') return 'font-mono text-teal-700';
  return 'text-neutral-700';
}

function itemRowAlignClass(item: LogEntry): string {
  const meta = normalizeMeta(item);
  return meta.itemType === 'reasoning' ? 'items-center' : 'items-start';
}

function itemPatch(item: LogEntry): string | null {
  const text = bodyText(item);
  const diffMarker = '\ndiff:\n';
  const diffMarkerIndex = text.indexOf(diffMarker);
  if (diffMarkerIndex >= 0) {
    const candidate = text.slice(diffMarkerIndex + diffMarker.length).trim();
    if (candidate) return candidate;
  }
  const diffHeaderIndex = text.indexOf('diff --git');
  if (diffHeaderIndex >= 0) return text.slice(diffHeaderIndex).trim();
  const hunkIndex = text.indexOf('@@ ');
  if (hunkIndex >= 0) return text.slice(hunkIndex).trim();
  return null;
}

function startWorkingTimer(startedAtIso?: string) {
  const startMs = startedAtIso ? new Date(startedAtIso).getTime() : Date.now();
  activeTaskStartedAt.value = Number.isNaN(startMs) ? Date.now() : startMs;
  workingSeconds.value = Math.max(0, Math.floor((Date.now() - activeTaskStartedAt.value) / 1000));

  if (workingTimer) window.clearInterval(workingTimer);
  workingTimer = window.setInterval(() => {
    if (!activeTaskStartedAt.value) return;
    workingSeconds.value = Math.max(0, Math.floor((Date.now() - activeTaskStartedAt.value) / 1000));
  }, 1000);
}

function stopWorkingTimer(endedAtIso?: string) {
  activeTaskStartedAt.value = null;
  running.value = false;

  if (workingTimer) {
    window.clearInterval(workingTimer);
    workingTimer = null;
  }
}

function addTimelineEntry(entry: TimelineEntry) {
  if (isHiddenItem({ side: entry.side, text: entry.text, meta: entry.meta })) return;
  pushEntry({
    side: entry.side,
    label: entry.label,
    text: entry.text,
    at: entry.at,
    meta: entry.meta
  });
}

function timelineEntryKind(entry: TimelineEntry): TimelineEntry['meta']['kind'] | null {
  if (entry.meta?.kind) return entry.meta.kind;
  if (entry.side === 'left') return 'user.message';
  if (entry.text.startsWith('Started:')) return 'codex.started';
  if (entry.text.startsWith('Turn completed')) return 'codex.completed';
  if (entry.text.startsWith('Error:')) return 'codex.failed';
  if (entry.text.startsWith('Item:')) return 'codex.item';
  return null;
}

async function scrollToBottom() {
  await nextTick();
  if (timelineEl.value) {
    timelineEl.value.scrollTop = timelineEl.value.scrollHeight;
  }
}

watch(logEntries, scrollToBottom);

async function loadState() {
  const response = await fetch(`${API}/api/rooms/${roomId.value}/state`);
  const data = await response.json();
  usageByTurnAt.value = new Map();
  latestUsageFromEvent.value = null;
  const history = (data.timeline as TimelineEntry[])
    .filter((entry) => !isHiddenItem({ side: entry.side, text: entry.text, meta: entry.meta }))
    .map<LogEntry>((entry) => ({
      id: `timeline-${entry.id}`,
      side: entry.side,
      label: entry.label,
      text: entry.text,
      at: entry.at,
      meta: entry.meta
    }));

  logEntries.value = history;
  editorText.value = data.editor.text;
  editorCursors.value = Array.isArray(data.editor?.cursors) ? data.editor.cursors : [];
  await nextTick();
  refreshCursorOverlays();

  let lastStarted: LogEntry | null = null;
  let hasTerminalAfterLastStart = false;

  for (const entry of history) {
    const kind = getEntryKind(entry);
    if (kind === 'codex.started') {
      lastStarted = entry;
      hasTerminalAfterLastStart = false;
      continue;
    }
    if (lastStarted && (kind === 'codex.completed' || kind === 'codex.failed')) {
      hasTerminalAfterLastStart = true;
    }
  }

  if (lastStarted && !hasTerminalAfterLastStart) {
    running.value = true;
    startWorkingTimer(lastStarted.at);
  } else {
    stopWorkingTimer();
  }
}

async function loadRuntime() {
  const response = await fetch(`${API}/api/runtime`);
  const data = await response.json();
  workingDirectory.value = data.workingDirectory ?? '';
}

async function loadCodexThreads() {
  const response = await fetch(`${API}/api/codex/threads?limit=40`);
  if (!response.ok) return;
  const data = (await response.json()) as { data?: CodexThreadSummary[] };
  codexThreads.value = Array.isArray(data.data) ? data.data : [];
}

function looksLikeCodexThreadId(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('thr_')) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function hydrateRoomFromThreadId(threadId: string) {
  await fetch(`${API}/api/rooms/${encodeURIComponent(threadId)}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId })
  });
}

async function switchRoom(nextRoomId: string) {
  const cleanRoomId = nextRoomId.trim();
  if (!cleanRoomId) return;

  eventsAbortController?.abort();
  if (cleanRoomId !== roomId.value) {
    roomId.value = cleanRoomId;
    logEntries.value = [];
    running.value = false;
    stopWorkingTimer();
  }

  const url = new URL(window.location.href);
  url.searchParams.set('room', cleanRoomId);
  window.history.replaceState({}, '', url.toString());

  view.value = 'chat';
  await loadState();
  connectEvents();
  scrollToBottom();
}

function goHome() {
  eventsAbortController?.abort();
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url.toString());
  view.value = 'home';
  void loadCodexThreads();
}

async function openNewRoom() {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await switchRoom(id);
}

async function openCodexThread(threadId: string) {
  const room = threadId.trim();
  if (!room) return;

  await fetch(`${API}/api/rooms/${encodeURIComponent(room)}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: room })
  });

  await switchRoom(room);
  await loadCodexThreads();
}

function connectEvents() {
  eventsAbortController?.abort();
  eventsConnectionSeq += 1;
  const seq = eventsConnectionSeq;
  const controller = new AbortController();
  eventsAbortController = controller;

  const read = async () => {
    while (!controller.signal.aborted && seq === eventsConnectionSeq) {
      try {
        const response = await fetch(`${API}/api/rooms/${roomId.value}/events`, {
          method: 'POST',
          signal: controller.signal
        });

        if (!response.body) break;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!controller.signal.aborted && seq === eventsConnectionSeq) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let delimiterIndex = buffer.indexOf('\n\n');
          while (delimiterIndex !== -1) {
            const rawChunk = buffer.slice(0, delimiterIndex);
            buffer = buffer.slice(delimiterIndex + 2);

            const dataLines = rawChunk
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart());

            if (dataLines.length > 0) {
              const raw = dataLines.join('\n');
              let event: RoomEvent | { type: 'system.connected' } | null = null;
              try {
                event = JSON.parse(raw) as RoomEvent | { type: 'system.connected' };
              } catch {
                event = null;
              }
              if (!event) {
                delimiterIndex = buffer.indexOf('\n\n');
                continue;
              }

              switch (event.type) {
                case 'timeline.entry':
                  addTimelineEntry(event.entry);
                  {
                    const kind = timelineEntryKind(event.entry);
                    if (kind === 'codex.started') {
                      running.value = true;
                      startWorkingTimer(event.entry.at);
                    }
                    if (kind === 'codex.completed' || kind === 'codex.failed') {
                      stopWorkingTimer(event.entry.at);
                    }
                  }
                  break;
                case 'editor.updated':
                  editorCursors.value = Array.isArray(event.editor.cursors) ? event.editor.cursors : [];
                  if (event.editor.updatedBy !== userId.value) {
                    applyingRemoteEditorUpdate = true;
                    editorText.value = event.editor.text;
                    await nextTick();
                  }
                  refreshCursorOverlays();
                  break;
                case 'codex.turn.started':
                  running.value = true;
                  startWorkingTimer(event.at);
                  break;
                case 'codex.turn.completed':
                  {
                    const parsed = usageFromEvent(event.usage);
                    if (parsed) {
                      const next = new Map(usageByTurnAt.value);
                      next.set(event.at, parsed);
                      usageByTurnAt.value = next;
                      latestUsageFromEvent.value = parsed;
                    }
                  }
                  stopWorkingTimer(event.at);
                  break;
                case 'codex.turn.failed':
                  stopWorkingTimer(event.at);
                  break;
                default:
                  break;
              }
            }
            delimiterIndex = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // reconnect below
      }
      if (seq !== eventsConnectionSeq || controller.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  void read();
}

async function syncEditor() {
  const el = editorEl.value;
  await fetch(`${API}/api/rooms/${roomId.value}/editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: userId.value,
      userName: userName.value,
      text: editorText.value,
      selectionStart: el?.selectionStart ?? editorText.value.length,
      selectionEnd: el?.selectionEnd ?? editorText.value.length
    })
  });
}

function scheduleEditorSync(delayMs = 120) {
  if (editorTimer) window.clearTimeout(editorTimer);
  editorTimer = window.setTimeout(syncEditor, delayMs);
}

watch(editorText, () => {
  if (applyingRemoteEditorUpdate) {
    applyingRemoteEditorUpdate = false;
    refreshCursorOverlays();
    return;
  }
  refreshCursorOverlays();
  scheduleEditorSync(120);
});

watch(editorCursors, () => {
  refreshCursorOverlays();
}, { deep: true });

function onEditorSelectionChange() {
  refreshCursorOverlays();
  scheduleEditorSync(80);
}

function onEditorScroll() {
  refreshCursorOverlays();
}

async function sendToCodex() {
  if (!canSend.value) return;
  const response = await fetch(`${API}/api/rooms/${roomId.value}/codex/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: userId.value,
      userName: userName.value,
      prompt: editorText.value
    })
  });
  if (response.ok) {
    editorText.value = '';
  }
}

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  void sendToCodex();
}

onMounted(async () => {
  window.addEventListener('resize', refreshCursorOverlays);
  await loadRuntime();
  await loadCodexThreads();
  if (view.value === 'chat') {
    if (looksLikeCodexThreadId(roomId.value)) {
      try {
        await hydrateRoomFromThreadId(roomId.value);
      } catch {
        // Fall back to persisted room state if hydration fails.
      }
    }
    await loadState();
    connectEvents();
    scrollToBottom();
    await nextTick();
    refreshCursorOverlays();
  }
});

onUnmounted(() => {
  eventsAbortController?.abort();
  window.removeEventListener('resize', refreshCursorOverlays);
  if (workingTimer) {
    window.clearInterval(workingTimer);
    workingTimer = null;
  }
});
</script>

<template>
  <div class="flex flex-col h-dvh max-w-[720px] mx-auto">

    <!-- Header -->
    <header class="shrink-0 sticky top-0 z-10 border-b border-neutral-200 bg-white/90 backdrop-blur-sm">
      <div class="flex items-center justify-between px-5 py-3">
        <div class="flex items-center gap-2">
          <button
            v-if="view === 'chat'"
            type="button"
            class="rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
            @click="goHome"
          >
            ← Chats
          </button>
          <span
            class="size-[7px] rounded-full transition-colors"
            :class="running ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'"
          ></span>
          <span class="text-[13px] font-medium tracking-tight text-neutral-900">
            {{ view === 'chat' ? roomId : 'Rooms' }}
          </span>
          <span
            v-if="workingDirectory && view === 'chat'"
            class="max-w-[360px] truncate text-[11px] text-neutral-400"
            :title="workingDirectory"
          >
            {{ workingDirectory }}
          </span>
        </div>
        <span class="text-xs text-neutral-400">{{ userName }}</span>
      </div>
    </header>

    <section v-if="view === 'home'" class="flex-1 overflow-y-auto">
      <div class="px-5 py-5 space-y-3">
        <div class="rounded-xl border border-neutral-200 bg-white p-3">
          <button
            type="button"
            class="rounded-lg bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:opacity-80"
            @click="openNewRoom"
          >
            New session
          </button>
        </div>

        <div class="space-y-2">
          <p class="text-[11px] uppercase tracking-wide text-neutral-400">Codex sessions</p>
          <button
            v-for="thread in codexThreads"
            :key="thread.id"
            type="button"
            class="flex w-full items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left hover:bg-neutral-50"
            @click="openCodexThread(thread.id)"
          >
            <span class="min-w-0">
              <span class="block truncate text-[13px] text-neutral-800">{{ thread.preview || thread.id }}</span>
              <span class="block truncate text-[11px] text-neutral-400">{{ thread.id }}</span>
            </span>
            <span class="ml-3 shrink-0 text-[11px] text-neutral-400">
              {{ formatThreadTime(thread.updatedAt ?? thread.createdAt) }}
            </span>
          </button>
          <p v-if="codexThreads.length === 0" class="text-sm text-neutral-400">No Codex sessions found.</p>
        </div>
      </div>
    </section>

    <!-- Timeline -->
    <section v-else class="flex-1 overflow-y-auto" ref="timelineEl">
      <div class="flex flex-col gap-3 px-5 py-5">

        <div v-if="groups.length === 0" class="py-10 text-sm text-neutral-500">
          <p class="mb-3">No messages yet in `{{ roomId }}`.</p>
        </div>

        <template v-for="group in groups" :key="group.id">

          <!-- User message -->
          <div v-if="group.type === 'message'" class="flex justify-start">
            <div class="max-w-[78%] rounded-xl bg-neutral-200 px-4 py-3">
              <pre class="m-0 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-900">{{ group.entry.text }}</pre>
            </div>
          </div>

          <!-- Codex turn -->
          <div v-else class="overflow-hidden rounded-xl border border-neutral-300 bg-white">

            <!-- Turn header -->
            <div class="flex items-center gap-2.5 border-b border-neutral-200 px-4 py-2.5">
              <span class="size-[6px] shrink-0 rounded-full" :class="turnStatusClass(group)"></span>
              <span class="flex-1 truncate text-[12.5px] font-medium text-neutral-700">{{ turnPrompt(group) }}</span>
              <span
                class="shrink-0 cursor-help text-[11px] text-neutral-500"
                :title="turnMetaTitle(group)"
              >{{ turnMeta(group) }}</span>
            </div>

            <!-- Segments: agent messages + collapsible tech groups in order -->
            <div class="divide-y divide-neutral-200">
              <template v-for="seg in turnSegments(group)" :key="seg.id">

                <!-- Agent message — always visible -->
                <div v-if="seg.type === 'message'" class="px-4 py-3">
                  <pre class="m-0 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-900">{{ bodyText(seg.entry) }}</pre>
                </div>

                <!-- Tech group — collapsible -->
                <div v-else>
                  <button
                    class="flex w-full items-center gap-2 bg-neutral-100 px-4 py-2 text-left transition-colors hover:bg-neutral-200"
                    @click="toggleExpanded(seg.id)"
                  >
                    <span class="text-[10px] text-neutral-400">{{ isExpanded(seg.id) ? '▾' : '▸' }}</span>
                    <span class="text-[11px] font-medium text-neutral-500">
                      {{ isExpanded(seg.id) ? `hide ${seg.items.length} step${seg.items.length > 1 ? 's' : ''}` : `${seg.items.length} step${seg.items.length > 1 ? 's' : ''}` }}
                    </span>
                  </button>

                  <div v-if="isExpanded(seg.id)" class="border-t border-neutral-200 bg-neutral-100">
                    <div
                      v-for="item in seg.items"
                      :key="item.id"
                      class="flex gap-3 border-b border-neutral-200 px-4 py-2 last:border-0"
                      :class="itemRowAlignClass(item)"
                    >
                      <span class="w-9 shrink-0 text-right text-[9px] font-semibold uppercase tracking-wide text-neutral-400">
                        {{ itemLabel(item) }}
                      </span>
                      <div class="flex-1">
                        <DiffPatch
                          v-if="normalizeMeta(item).itemType === 'file_change' && itemPatch(item)"
                          :patch="itemPatch(item) || ''"
                        />
                        <pre
                          v-else
                          class="m-0 whitespace-pre-wrap text-[12px] leading-relaxed"
                          :class="itemTextClass(item)"
                        >{{ itemBody(item) }}</pre>
                      </div>
                    </div>
                  </div>
                </div>

              </template>
            </div>

          </div>

        </template>
      </div>
    </section>

    <!-- Input -->
    <footer v-if="view === 'chat'" class="shrink-0 border-t border-neutral-200 bg-white/95 backdrop-blur-sm">
      <div class="px-5 py-4">
        <div class="relative">
          <textarea
            ref="editorEl"
            v-model="editorText"
            rows="5"
            class="w-full resize-none rounded-xl border border-neutral-200 bg-neutral-50 px-4 pb-11 pr-28 pt-3 font-sans text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-300 focus:border-neutral-400 focus:bg-white"
            placeholder="Write a prompt..."
            @keydown="onEditorKeydown"
            @click="onEditorSelectionChange"
            @keyup="onEditorSelectionChange"
            @select="onEditorSelectionChange"
            @scroll="onEditorScroll"
          />
          <div class="pointer-events-none absolute inset-0 z-10 overflow-visible rounded-xl">
            <div
              v-for="cursor in cursorOverlays"
              :key="cursor.userId"
              class="absolute"
              :style="{ left: `${cursor.left}px`, top: `${cursor.top}px` }"
            >
              <span
                class="absolute left-0 top-0 w-0.5 rounded-full"
                :style="{ height: `${cursor.height}px`, backgroundColor: cursor.color }"
              ></span>
              <span
                class="absolute left-1 top-0 -translate-y-full rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
                :style="{ backgroundColor: cursor.color }"
              >
                {{ cursor.userName }}
              </span>
            </div>
          </div>
          <span class="pointer-events-none absolute bottom-3 left-4 text-[11px] text-neutral-400">
            {{ contextAvailabilityText }}
          </span>
          <button
            :disabled="!canSend"
            @click="sendToCodex"
            class="absolute bottom-2 right-2 inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
          >
            <span
              v-if="running"
              class="size-[10px] animate-spin rounded-full border-[1.5px] border-white/30 border-t-white"
            ></span>
            {{ running ? 'Running' : 'Run' }}
          </button>
        </div>
      </div>
    </footer>

  </div>
</template>
