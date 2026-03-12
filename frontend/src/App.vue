<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import MarkdownIt from 'markdown-it';
import type {
  CodexRpcMessage,
  EditorCursor,
  RoomEvent,
  TimelineEntry
} from '@codex-room/shared';
import DiffPatch from './components/DiffPatch.vue';

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]?.attrSet('target', '_blank');
  tokens[idx]?.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const query = new URLSearchParams(window.location.search);
const API = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
const roomFromQuery = query.get('room');
const sessionKeyFromQuery = query.get('key')?.trim() ?? '';
const initialRoomId = roomFromQuery ?? 'main';
const roomId = ref(initialRoomId);
const view = ref<'home' | 'chat'>(roomFromQuery ? 'chat' : 'home');
const userId = ref(`u-${Math.random().toString(36).slice(2, 8)}`);
const USER_ADJECTIVES = [
  'Curious',
  'Sleepy',
  'Chaotic',
  'Tiny',
  'Cosmic',
  'Sneaky',
  'Wobbly',
  'Spicy',
  'Noisy',
  'Mellow',
  'Feral',
  'Glitchy'
];
const USER_ANIMALS = [
  'Raccoon',
  'Dinosaur',
  'Otter',
  'Capybara',
  'Lizard',
  'Pigeon',
  'Shark',
  'Badger',
  'Gecko',
  'Yak',
  'Mole',
  'Falcon'
];
const userName = ref(generateFunUserName());
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
  rawPatch?: string;
};

type DebugEventSnapshot = {
  type: string;
  at: string;
  payload: unknown;
};

type ParsedCommandExecution = {
  command: string;
  exit: string;
  output: string;
  stdout: string;
  stderr: string;
};

const logEntries = ref<LogEntry[]>([]);
const editorText = ref('');
const editorCursors = ref<EditorCursor[]>([]);
const editorVersion = ref(0);
const cursorOverlays = ref<CursorOverlay[]>([]);
const running = ref(false);
const timelineEl = ref<HTMLElement | null>(null);
const shouldAutoScrollTimeline = ref(true);
const activeTaskStartedAt = ref<number | null>(null);
const workingSeconds = ref(0);
type UsageDisplay = {
  input: number;
  output: number;
  total: number;
  cachedInput?: number;
  contextAvailablePercent?: number;
};
type EffortOption = {
  id: string;
  label: string;
  description?: string;
};
type ModelOption = {
  id: string;
  label: string;
  isDefault?: boolean;
  effortOptions?: EffortOption[];
  defaultEffort?: string;
};
type AccessMode = 'full-access' | 'need-approve';
const usageByTurnAt = ref(new Map<string, UsageDisplay>());
const latestUsageFromEvent = ref<UsageDisplay | null>(null);
const currentThreadId = ref<string | null>(null);
const debugCopyStatus = ref<'idle' | 'copied' | 'error'>('idle');
const apiError = ref<string | null>(null);
const modelOptions = ref<ModelOption[]>([]);
const selectedModel = ref('default');
const selectedEffort = ref('medium');
const accessMode = ref<AccessMode>('full-access');
const openMenu = ref<'model' | 'effort' | 'access' | null>(null);
const modelMenuEl = ref<HTMLElement | null>(null);
const effortMenuEl = ref<HTMLElement | null>(null);
const accessMenuEl = ref<HTMLElement | null>(null);

let eventsAbortController: AbortController | null = null;
let editorTimer: number | null = null;
let workingTimer: number | null = null;
let applyingRemoteEditorUpdate = false;
let eventsConnectionSeq = 0;
let activeCodexTurnId: string | null = null;
let latestThreadUsageRaw: unknown = null;
const liveCodexItemState = new Map<string, Record<string, unknown>>();
const latestTurnDiffPatchByTurnId = new Map<string, string>();
const recentDebugEvents: DebugEventSnapshot[] = [];
const MAX_DEBUG_EVENTS = 300;

const hasPrompt = computed(() => editorText.value.trim().length > 0);
const canRun = computed(() => hasPrompt.value && !running.value);
const canSteer = computed(() => hasPrompt.value && running.value);
const canSubmit = computed(() => canRun.value || canSteer.value);
const canInterrupt = computed(() => running.value);
const defaultModelOption = computed(() =>
  modelOptions.value.find((option) => option.isDefault && option.id !== 'default') ?? null
);
const activeModelOption = computed(() => {
  if (selectedModel.value === 'default') {
    return defaultModelOption.value ?? modelOptions.value.find((option) => option.id === 'default') ?? null;
  }
  return modelOptions.value.find((option) => option.id === selectedModel.value) ?? defaultModelOption.value ?? null;
});
const fallbackEffortOptions: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
];
const effortOptions = computed(() => {
  const options = activeModelOption.value?.effortOptions ?? [];
  if (options.length > 0) return options;
  return fallbackEffortOptions;
});
const selectedModelOptionLabel = computed(() => {
  if (selectedModel.value === 'default') {
    if (defaultModelOption.value?.label) return defaultModelOption.value.label;
    const fallbackLabel = modelOptions.value.find((option) => option.id === 'default')?.label ?? 'Project Default';
    return fallbackLabel.replace(/^Default\s*[·-]\s*/u, '').trim() || 'Project Default';
  }
  return modelOptions.value.find((option) => option.id === selectedModel.value)?.label ?? selectedModel.value;
});
const selectedEffortLabel = computed(() => {
  return effortOptions.value.find((option) => option.id === selectedEffort.value)?.label ?? selectedEffort.value;
});
const selectedAccessLabel = computed(() =>
  accessMode.value === 'full-access' ? 'Full Access' : 'Need Approve'
);

watch(
  [selectedModel, modelOptions],
  () => {
    if (effortOptions.value.some((option) => option.id === selectedEffort.value)) return;
    selectedEffort.value =
      activeModelOption.value?.defaultEffort ??
      effortOptions.value[0]?.id ??
      'medium';
  },
  { immediate: true }
);

function randomPick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function generateFunUserName(): string {
  const adjective = randomPick(USER_ADJECTIVES);
  const animal = randomPick(USER_ANIMALS);
  const suffix = Math.floor(Math.random() * 90) + 10;
  return `${adjective} ${animal} ${suffix}`;
}

function shortId(value: string | null | undefined, head = 4, tail = 5): string {
  if (!value) return '';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}***${value.slice(-tail)}`;
}

function resetCodexRuntimeState() {
  activeCodexTurnId = null;
  latestThreadUsageRaw = null;
  liveCodexItemState.clear();
  latestTurnDiffPatchByTurnId.clear();
  recentDebugEvents.length = 0;
}

function compactDebugValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    const limit = 2000;
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}… [truncated ${value.length - limit} chars]`;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 5) return '[max-depth]';

  if (Array.isArray(value)) {
    const maxItems = 50;
    const items = value.slice(0, maxItems).map((entry) => compactDebugValue(entry, depth + 1));
    if (value.length > maxItems) {
      items.push(`[truncated ${value.length - maxItems} items]`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'diff' || key === 'rawPatch' || key === 'patch' || key === 'unifiedDiff' || key === 'unified_diff') && typeof nested === 'string') {
      out[`${key}Preview`] = nested.slice(0, 500);
      out[`${key}Length`] = nested.length;
      continue;
    }
    out[key] = compactDebugValue(nested, depth + 1);
  }
  return out;
}

function pushDebugEvent(type: string, at: string, payload: unknown) {
  if (!(type === 'codex.rpc.notification' || type === 'codex.rpc.serverRequest')) return;
  recentDebugEvents.push({ type, at, payload: compactDebugValue(payload) });
  if (recentDebugEvents.length > MAX_DEBUG_EVENTS) {
    recentDebugEvents.splice(0, recentDebugEvents.length - MAX_DEBUG_EVENTS);
  }
}

async function copyDebugInfo() {
  const fileChangeEntries = logEntries.value
    .filter((entry) => normalizeMeta(entry).itemType === 'file_change')
    .slice(-10)
    .map((entry) => ({
      id: entry.id,
      at: entry.at,
      text: entry.text,
      rawPatch: entry.rawPatch ?? null,
      meta: entry.meta ?? null
    }));

  const payload = {
    roomId: roomId.value,
    threadId: currentThreadId.value,
    running: running.value,
    activeCodexTurnId,
    workingDirectory: workingDirectory.value,
    latestTurnDiffPatchByTurnId: Object.fromEntries(latestTurnDiffPatchByTurnId.entries()),
    recentDebugEvents: recentDebugEvents.slice(-80),
    fileChangeEntries
  };

  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    debugCopyStatus.value = 'copied';
  } catch {
    debugCopyStatus.value = 'error';
  }
  window.setTimeout(() => {
    if (debugCopyStatus.value !== 'idle') debugCopyStatus.value = 'idle';
  }, 2000);
}

function hasPatchFileHeaders(patch: string): boolean {
  const candidate = patch.trim();
  if (!candidate) return false;
  return (
    candidate.includes('diff --git ') ||
    (candidate.includes('\n--- ') && candidate.includes('\n+++ ')) ||
    candidate.startsWith('--- ')
  );
}

function normalizeCodexItemType(type: unknown): string {
  if (typeof type !== 'string') return 'unknown';
  const map: Record<string, string> = {
    userMessage: 'user_message',
    UserMessage: 'user_message',
    agentMessage: 'agent_message',
    AgentMessage: 'agent_message',
    reasoning: 'reasoning',
    Reasoning: 'reasoning',
    plan: 'plan',
    Plan: 'plan',
    commandExecution: 'command_execution',
    CommandExecution: 'command_execution',
    fileChange: 'file_change',
    FileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    McpToolCall: 'mcp_tool_call',
    collabToolCall: 'collab_tool_call',
    CollabToolCall: 'collab_tool_call',
    webSearch: 'web_search',
    WebSearch: 'web_search',
    imageView: 'image_view',
    ImageView: 'image_view',
    enteredReviewMode: 'entered_review_mode',
    EnteredReviewMode: 'entered_review_mode',
    exitedReviewMode: 'exited_review_mode',
    ExitedReviewMode: 'exited_review_mode',
    contextCompaction: 'context_compaction'
  };
  return map[type] ?? type;
}

function codexItemTypeForUi(item: any): string {
  return normalizeCodexItemType(item?.type);
}

function codexItemIdFrom(value: any): string | null {
  return (
    (typeof value?.id === 'string' && value.id) ||
    (typeof value?.itemId === 'string' && value.itemId) ||
    (typeof value?.item_id === 'string' && value.item_id) ||
    (typeof value?.call_id === 'string' && value.call_id) ||
    null
  );
}

function appendCodexTextField(target: Record<string, unknown>, key: string, chunk: unknown) {
  if (typeof chunk !== 'string' || !chunk) return;
  const prev = typeof target[key] === 'string' ? (target[key] as string) : '';
  target[key] = `${prev}${chunk}`;
}

function extractCodexAgentMessageText(item: any): string {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (Array.isArray(item.content)) {
    return item.content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function extractTextFragments(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextFragments(entry));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const direct =
      (typeof obj.text === 'string' && obj.text) ||
      (typeof obj.content === 'string' && obj.content) ||
      '';
    if (direct.trim()) return [direct.trim()];
    return [];
  }
  return [];
}

function uniqueTextParts(parts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const normalized = part.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractCodexUsagePayload(value: any): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const nested =
    value.usage ??
    value.tokenUsage ??
    value.token_usage ??
    value.turn?.usage ??
    value.turn?.tokenUsage ??
    value.turn?.token_usage ??
    undefined;
  if (!nested || typeof nested !== 'object') return nested;
  if (
    typeof value.modelContextWindow === 'number' ||
    typeof value.model_context_window === 'number' ||
    typeof value.contextWindowTokens === 'number' ||
    typeof value.context_window_tokens === 'number'
  ) {
    return {
      ...(nested as Record<string, unknown>),
      ...(typeof value.modelContextWindow === 'number'
        ? { modelContextWindow: value.modelContextWindow }
        : {}),
      ...(typeof value.model_context_window === 'number'
        ? { model_context_window: value.model_context_window }
        : {}),
      ...(typeof value.contextWindowTokens === 'number'
        ? { contextWindowTokens: value.contextWindowTokens }
        : {}),
      ...(typeof value.context_window_tokens === 'number'
        ? { context_window_tokens: value.context_window_tokens }
        : {})
    };
  }
  return nested;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function apiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (sessionKeyFromQuery) headers.set('x-codex-room-key', sessionKeyFromQuery);
  return headers;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: apiHeaders(init.headers)
  });
  if (response.status === 401) {
    apiError.value = 'Session key is missing or invalid. Re-open the room link from `codex-room start`.';
  }
  return response;
}

function compactDiffText(value: unknown): string {
  if (!value) return '';
  const raw =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((v) => compactDiffText(v)).join('\n')
        : typeof value === 'object'
          ? Object.values(value as Record<string, unknown>).map((v) => compactDiffText(v)).join('\n')
          : String(value);
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .slice(0, 40);
  return lines.join('\n').trim();
}

function pickRawPatchFromValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    return value.trim() ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const patch = pickRawPatchFromValue(entry);
      if (patch) return patch;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['diff', 'patch', 'unified_diff', 'unifiedDiff']) {
      const patch = pickRawPatchFromValue(obj[key]);
      if (patch) return patch;
    }
    return null;
  }
  return null;
}

function extractItemRawPatch(item: Record<string, unknown>, itemType: string): string | null {
  if (itemType !== 'file_change' && itemType !== 'turn_diff') return null;

  const direct = pickRawPatchFromValue(item.diff ?? item.patch ?? item.unified_diff ?? item.unifiedDiff);
  if (direct) return direct;

  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const patch = pickRawPatchFromValue(change);
    if (patch) return patch;
  }

  return null;
}

function codexItemDetailsText(item: Record<string, unknown>, itemType: string): string {
  if (itemType === 'agent_message') return extractCodexAgentMessageText(item);

  if (itemType === 'reasoning') {
    const summaryParts = uniqueTextParts([
      ...extractTextFragments((item.summary as any)?.text),
      ...extractTextFragments(item.summary_text),
      ...extractTextFragments(item.summary)
    ]);
    const summary = summaryParts.join('\n').trim();

    const contentParts = uniqueTextParts([
      ...extractTextFragments((item.content as any)?.text),
      ...extractTextFragments(item.content),
      ...extractTextFragments(item.raw_content)
    ]);
    const content = contentParts.join('\n').trim();

    const blocks = uniqueTextParts([summary, content]);
    return blocks.join('\n').trim();
  }

  if (itemType === 'plan') {
    return typeof item.text === 'string' ? item.text : safeJson(item.plan ?? item);
  }

  if (itemType === 'command_execution') {
    const parts: string[] = [];
    if (item.command !== undefined) parts.push(`command: ${typeof item.command === 'string' ? item.command : safeJson(item.command)}`);
    if (item.exitCode !== undefined || item.exit_code !== undefined) parts.push(`exit: ${String(item.exitCode ?? item.exit_code)}`);
    const output = item.aggregatedOutput ?? item.aggregated_output ?? item.output;
    if (typeof output === 'string' && output.trim()) parts.push(`output:\n${output.trim()}`);
    if (typeof item.stderr === 'string' && item.stderr.trim()) parts.push(`stderr:\n${item.stderr.trim()}`);
    if (typeof item.stdout === 'string' && item.stdout.trim()) parts.push(`stdout:\n${item.stdout.trim()}`);
    return parts.join('\n').trim() || safeJson(item);
  }

  if (itemType === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const fileLines = changes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const obj = entry as Record<string, unknown>;
        const p = typeof obj.path === 'string' ? obj.path : '';
        const kind = typeof obj.kind === 'string' ? obj.kind : '';
        return [kind, p].filter(Boolean).join(': ');
      })
      .filter(Boolean);
    const parts = [
      fileLines.length ? `files:\n${fileLines.map((l) => `- ${l}`).join('\n')}` : '',
      typeof item.outputDelta === 'string' && item.outputDelta.trim() ? item.outputDelta.trim() : ''
    ].filter(Boolean);
    return parts.join('\n').trim() || safeJson(item);
  }

  if (itemType === 'turn_diff') {
    const rawPatch = extractItemRawPatch(item, itemType);
    return rawPatch && hasPatchFileHeaders(rawPatch) ? '' : safeJson(item);
  }

  if (itemType === 'mcp_tool_call' || itemType === 'collab_tool_call') {
    return safeJson(item);
  }

  if (itemType === 'web_search' || itemType === 'image_view') {
    return safeJson(item);
  }

  if (itemType === 'entered_review_mode' || itemType === 'exited_review_mode') {
    return typeof item.review === 'string' ? item.review : safeJson(item);
  }

  return safeJson(item);
}

function appendCodexItemTimeline(itemInput: Record<string, unknown>, at: string, options: { turnId?: string | null; itemId?: string | null } = {}) {
  const item = itemInput && typeof itemInput === 'object' ? itemInput : ({ type: 'unknown' } as Record<string, unknown>);
  const itemType = codexItemTypeForUi(item);
  if (itemType === 'user_message') return;
  const details = codexItemDetailsText(item, itemType).trim();
  const rawPatch = extractItemRawPatch(item, itemType) ?? undefined;
  const meta = {
    kind: 'codex.item',
    itemType,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.itemId ? { itemId: options.itemId } : {})
  } as any;
  pushEntry({
    side: 'right',
    label: 'codex',
    text: `Item: ${itemType}${details ? `\n${details}` : ''}`,
    at,
    meta,
    rawPatch
  });
}

function upsertTurnDiffEntryForTurn(turnId: string | null, patch: string, at: string): boolean {
  if (!turnId || !patch.trim()) return false;
  for (let i = logEntries.value.length - 1; i >= 0; i--) {
    const entry = logEntries.value[i];
    const meta = normalizeMeta(entry) as any;
    if (meta.kind !== 'codex.item' || meta.itemType !== 'turn_diff') continue;
    if ((meta.turnId ?? null) !== turnId) continue;
    const prevPatch = typeof entry.rawPatch === 'string' ? entry.rawPatch : '';
    if (prevPatch === patch) return true;
    const next = [...logEntries.value];
    next[i] = {
      ...entry,
      text: 'Item: turn_diff',
      rawPatch: patch,
      at
    };
    logEntries.value = next;
    return true;
  }
  appendCodexItemTimeline(
    {
      type: 'turn_diff',
      diff: patch,
      source: 'turn.diff.updated'
    },
    at,
    { turnId }
  );
  return true;
}

function appendCodexTurnStarted(prompt: string, at: string, model?: string, reasoningEffort?: string) {
  pushEntry({
    side: 'right',
    label: 'codex',
    text: `Started: ${prompt || '(resumed turn)'}`,
    at,
    meta: { kind: 'codex.started', model, reasoningEffort }
  });
  running.value = true;
  startWorkingTimer(at);
}

function appendCodexTurnTerminal(
  kind: 'completed' | 'failed' | 'interrupted',
  at: string,
  options: { finalResponse?: string; usage?: unknown; error?: string } = {}
) {
  if (kind === 'failed') {
    pushEntry({
      side: 'right',
      label: 'codex',
      text: `Error: ${options.error ?? 'Turn failed'}`,
      at,
      meta: { kind: 'codex.failed' }
    });
    stopWorkingTimer(at);
    return;
  }

  if (kind === 'interrupted') {
    pushEntry({
      side: 'right',
      label: 'codex',
      text: 'Turn interrupted',
      at,
      meta: { kind: 'codex.interrupted' }
    });
    stopWorkingTimer(at);
    return;
  }

  const parsed = usageFromEvent(options.usage ?? latestThreadUsageRaw);
  if (parsed) {
    const next = new Map(usageByTurnAt.value);
    next.set(at, parsed);
    usageByTurnAt.value = next;
    latestUsageFromEvent.value = parsed;
  }
  const usageLine = parsed
    ? `\nTokens: in ${parsed.input}${parsed.cachedInput ? ` (cached ${parsed.cachedInput})` : ''} · out ${parsed.output} · total ${parsed.total}`
    : '';
  const contextLine =
    parsed?.contextAvailablePercent !== undefined
      ? `\nContext: ${parsed.contextAvailablePercent}% available`
      : '';
  const finalTextRaw = (options.finalResponse ?? '').trim();
  const finalText = turnAlreadyContainsAgentMessage(finalTextRaw) ? '' : finalTextRaw;
  pushEntry({
    side: 'right',
    label: 'codex',
    text: `Turn completed${usageLine}${contextLine}${finalText ? `\nFinal response\n${finalText}` : ''}`,
    at,
    meta: { kind: 'codex.completed' }
  });
  stopWorkingTimer(at);
}

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
  if (entry.text.startsWith('Turn interrupted')) return { kind: 'codex.interrupted' };
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
  if (normalized === 'Item: reasoning') return true;
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
  if (meta.kind === 'codex.interrupted') return 'stopped';
  if (meta.kind === 'codex.failed') return 'error';
  return meta.itemType ?? 'item';
}

function badgeClass(entry: LogEntry): string {
  const meta = normalizeMeta(entry);
  if (meta.kind === 'user.message') return 'bg-neutral-100 text-neutral-500';
  if (meta.kind === 'codex.started') return 'bg-blue-50 text-blue-600';
  if (meta.kind === 'codex.completed') return 'bg-emerald-50 text-emerald-600';
  if (meta.kind === 'codex.interrupted') return 'bg-amber-50 text-amber-700';
  if (meta.kind === 'codex.failed') return 'bg-red-50 text-red-600';
  if (meta.itemType === 'reasoning') return 'bg-amber-50 text-amber-600';
  if (meta.itemType === 'command_execution') return 'bg-indigo-50 text-indigo-600';
  if (meta.itemType === 'file_change') return 'bg-teal-50 text-teal-600';
  if (meta.itemType === 'agent_message') return 'bg-purple-50 text-purple-600';
  return 'bg-neutral-100 text-neutral-500';
}

function renderMarkdown(text: string): string {
  return markdown.render(text);
}

function itemRawBodyText(entry: LogEntry): string {
  if (!entry.text.startsWith('Item:')) return entry.text;
  return entry.text.split('\n').slice(1).join('\n').trim() || '(no details)';
}

function bodyText(entry: LogEntry): string {
  const meta = normalizeMeta(entry);
  if (meta.kind === 'codex.item' && entry.text.startsWith('Item:')) {
    let body = itemRawBodyText(entry);
    if (meta.itemType === 'file_change') {
      const diffMarker = '\ndiff:\n';
      const diffIndex = body.indexOf(diffMarker);
      if (diffIndex >= 0) {
        body = body.slice(0, diffIndex).trim();
      } else if (body.startsWith('diff:\n')) {
        body = '';
      } else {
        const diffHeaderIndex = body.indexOf('\ndiff --git');
        if (diffHeaderIndex >= 0) {
          body = body.slice(0, diffHeaderIndex).trim();
        } else if (body.startsWith('diff --git')) {
          body = '';
        }
      }
    }
    return body || '(no details)';
  }
  if (meta.kind === 'codex.completed' && entry.text.startsWith('Turn completed')) {
    return entry.text.replace(/^Turn completed\n?/, '').trim() || 'Turn completed';
  }
  if (meta.kind === 'codex.interrupted') return 'Turn interrupted';
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

function turnAlreadyContainsAgentMessage(finalText: string): boolean {
  const normalizedFinal = finalText.trim();
  if (!normalizedFinal) return false;
  for (let i = logEntries.value.length - 1; i >= 0; i -= 1) {
    const entry = logEntries.value[i];
    const kind = getEntryKind(entry);
    if (kind === 'codex.started') break;
    if (kind !== 'codex.item') continue;
    if (normalizeMeta(entry).itemType !== 'agent_message') continue;
    if (bodyText(entry).trim() === normalizedFinal) return true;
  }
  return false;
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

    if (kind === 'codex.completed' || kind === 'codex.failed' || kind === 'codex.interrupted') {
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
    if (kind === 'codex.completed' || kind === 'codex.failed' || kind === 'codex.interrupted') {
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
  const kind = getEntryKind(group.endEntry);
  if (kind === 'codex.completed') return 'bg-emerald-400';
  if (kind === 'codex.interrupted') return 'bg-amber-400';
  return 'bg-red-400';
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

function extractContextAvailabilityPercent(usage: unknown): number | null {
  const obj = normalizeUsagePayload(usage);
  if (!obj) return null;

  const directPercent = pickNumber(obj, [
    'contextAvailablePercent',
    'context_available_percent',
    'remainingPercent',
    'remaining_percent'
  ]);
  if (directPercent !== null) {
    return Math.min(100, Math.max(0, Math.round(directPercent)));
  }

  const contextWindow = pickNumber(obj, [
    'contextWindowTokens',
    'context_window_tokens',
    'contextWindow',
    'context_window',
    'modelContextWindow',
    'model_context_window',
    'maxInputTokens',
    'max_input_tokens',
    'maxTokens',
    'max_tokens'
  ]);
  if (!contextWindow || contextWindow <= 0) return null;

  const remaining = pickNumber(obj, [
    'remainingTokens',
    'remaining_tokens',
    'availableTokens',
    'available_tokens',
    'contextRemainingTokens',
    'context_remaining_tokens'
  ]);
  if (remaining !== null) {
    return Math.min(100, Math.max(0, Math.round((remaining / contextWindow) * 100)));
  }

  const used = pickNumber(obj, [
    'totalTokens',
    'total_tokens',
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens'
  ]);
  if (used !== null) {
    return Math.min(100, Math.max(0, Math.round(((contextWindow - used) / contextWindow) * 100)));
  }

  return null;
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
  const contextAvailablePercentRaw = extractContextAvailabilityPercent(usage);
  const contextAvailablePercent = contextAvailablePercentRaw === null ? undefined : contextAvailablePercentRaw;

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
  const fromLiveUsage = usageFromEvent(latestThreadUsageRaw)?.contextAvailablePercent;
  if (fromLiveUsage !== undefined) return fromLiveUsage;
  for (let i = groups.value.length - 1; i >= 0; i -= 1) {
    const group = groups.value[i];
    if (group.type !== 'turn' || !group.endEntry) continue;
    const fromReplayUsage = usageByTurnAt.value.get(group.endEntry.at)?.contextAvailablePercent;
    if (typeof fromReplayUsage === 'number') return fromReplayUsage;
  }
  return null;
});

const contextAvailabilityText = computed(() => {
  if (latestUsageFromEvent.value?.contextAvailablePercent !== undefined) {
    return `Context available: ${latestUsageFromEvent.value.contextAvailablePercent}%`;
  }
  if (running.value) {
    return 'Context available: --%';
  }
  if (latestContextAvailablePercent.value !== null) {
    return `Context available: ${latestContextAvailablePercent.value}%`;
  }
  return 'Context available: --%';
});

const contextAvailabilityTitle = computed(() => {
  const lines = [contextAvailabilityText.value];
  const usage = latestUsageFromEvent.value;
  if (usage) {
    lines.push(`Tokens: in ${usage.input}${usage.cachedInput ? ` (cached ${usage.cachedInput})` : ''} · out ${usage.output} · total ${usage.total}`);
  }

  const normalized = normalizeUsagePayload(latestThreadUsageRaw);
  if (normalized) {
    const contextWindow = pickNumber(normalized, [
      'contextWindowTokens',
      'context_window_tokens',
      'contextWindow',
      'context_window',
      'modelContextWindow',
      'model_context_window',
      'maxInputTokens',
      'max_input_tokens',
      'maxTokens',
      'max_tokens'
    ]);
    if (contextWindow !== null) {
      lines.push(`Context window: ${contextWindow}`);
    }

    const remaining = pickNumber(normalized, [
      'remainingTokens',
      'remaining_tokens',
      'availableTokens',
      'available_tokens',
      'contextRemainingTokens',
      'context_remaining_tokens'
    ]);
    if (remaining !== null) {
      lines.push(`Remaining tokens: ${remaining}`);
    }
  }

  return lines.join('\n');
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

const segmentExpansionOverrides = ref(new Map<string, boolean>());

function hasDiffItem(entry: LogEntry): boolean {
  const meta = normalizeMeta(entry);
  if (meta.itemType === 'file_change' || meta.itemType === 'turn_diff') return true;
  return itemPatch(entry) !== null;
}

function shouldCollapseTechSegment(items: LogEntry[]): boolean {
  if (items.length === 0) return false;
  const onlyReasoning = items.every((item) => normalizeMeta(item).itemType === 'reasoning');
  if (onlyReasoning && items.length <= 2) return false;
  return true;
}

function shouldAutoExpand(items: LogEntry[]): boolean {
  return false;
}

function isExpanded(id: string, items: LogEntry[]): boolean {
  const override = segmentExpansionOverrides.value.get(id);
  if (override !== undefined) return override;
  return shouldAutoExpand(items);
}

function toggleExpanded(id: string, items: LogEntry[]) {
  const next = new Map(segmentExpansionOverrides.value);
  next.set(id, !isExpanded(id, items));
  segmentExpansionOverrides.value = next;
}

function itemLabel(item: LogEntry): string {
  const meta = normalizeMeta(item);
  const map: Record<string, string> = {
    reasoning: 'think',
    command_execution: 'cmd',
    file_change: 'file',
    turn_diff: 'turn diff',
    mcp_tool_call: 'tool',
    collab_tool_call: 'tool',
    web_search: 'web',
    image_view: 'img'
  };
  return map[meta.itemType ?? ''] ?? (meta.itemType ?? 'item');
}

function techSegmentSummary(items: LogEntry[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const itemType = normalizeMeta(item).itemType ?? 'item';
    counts.set(itemType, (counts.get(itemType) ?? 0) + 1);
  }

  const entries = [...counts.entries()];
  const orderedKeys = [
    'file_change',
    'turn_diff',
    'command_execution',
    'reasoning',
    'plan',
    'permission_request',
    'mcp_tool_call',
    'collab_tool_call'
  ];
  entries.sort((a, b) => {
    const aIdx = orderedKeys.indexOf(a[0]);
    const bIdx = orderedKeys.indexOf(b[0]);
    return (aIdx === -1 ? Number.MAX_SAFE_INTEGER : aIdx) - (bIdx === -1 ? Number.MAX_SAFE_INTEGER : bIdx);
  });

  const format = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;
  return entries
    .map(([type, count]) => {
      switch (type) {
        case 'file_change':
          return format(count, 'file edited', 'files edited');
        case 'turn_diff':
          return format(count, 'diff', 'diffs');
        case 'command_execution':
          return format(count, 'cmd', 'cmds');
        case 'reasoning':
          return format(count, 'thought', 'thoughts');
        case 'plan':
          return format(count, 'plan', 'plans');
        case 'permission_request':
          return format(count, 'approval', 'approvals');
        case 'mcp_tool_call':
        case 'collab_tool_call':
          return format(count, 'tool call', 'tool calls');
        default:
          return format(count, type.replace(/_/g, ' '), `${type.replace(/_/g, ' ')}s`);
      }
    })
    .slice(0, 3)
    .join(' · ');
}

function itemBody(item: LogEntry): string {
  const meta = normalizeMeta(item);
  const text = bodyText(item);
  if (meta.itemType === 'command_execution') {
    const parsed = parseCommandExecutionText(text);
    const sections: string[] = [];
    if (parsed.output) sections.push(`output:\n${parsed.output}`);
    if (parsed.stdout) sections.push(`stdout:\n${parsed.stdout}`);
    if (parsed.stderr) sections.push(`stderr:\n${parsed.stderr}`);
    const header = parsed.exit ? `${parsed.command}  [${parsed.exit}]` : parsed.command;
    return sections.length > 0 ? `${header}\n${sections.join('\n\n')}` : header;
  }
  if (meta.itemType === 'reasoning') return text.replace(/\*\*/g, '');
  return text;
}

function parseCommandExecutionText(text: string): ParsedCommandExecution {
  const lines = text.split('\n');
  const command = lines.find((l) => l.startsWith('command:'))?.replace('command:', '').trim() ?? text.trim();
  const exit = lines.find((l) => l.startsWith('exit:'))?.replace('exit:', '').trim() ?? '';
  const markerPrefixes = ['command:', 'exit:', 'stdout:', 'stderr:', 'output:', 'duration_ms:'];

  const collectBlock = (marker: string): string => {
    const start = lines.findIndex((line) => line.startsWith(marker));
    if (start === -1) return '';
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (markerPrefixes.some((prefix) => line.startsWith(prefix))) break;
      out.push(line);
    }
    return out.join('\n').trim();
  };

  return {
    command,
    exit,
    output: collectBlock('output:'),
    stdout: collectBlock('stdout:'),
    stderr: collectBlock('stderr:')
  };
}

function itemCommandExecution(item: LogEntry): ParsedCommandExecution | null {
  if (normalizeMeta(item).itemType !== 'command_execution') return null;
  return parseCommandExecutionText(bodyText(item));
}

function itemTextClass(item: LogEntry): string {
  const meta = normalizeMeta(item);
  if (meta.itemType === 'reasoning') return 'text-neutral-500 italic';
  if (meta.itemType === 'command_execution') return 'font-mono text-neutral-700';
  if (meta.itemType === 'file_change') return 'font-mono text-teal-700';
  if (meta.itemType === 'turn_diff') return 'font-mono text-sky-700';
  return 'text-neutral-700';
}

function itemRowAlignClass(item: LogEntry): string {
  const meta = normalizeMeta(item);
  return meta.itemType === 'reasoning' ? 'items-center' : 'items-start';
}

function itemPatch(item: LogEntry): string | null {
  const meta = normalizeMeta(item) as any;
  if (meta.itemType === 'file_change' && typeof meta.turnId === 'string') {
    const hasTurnLevelDiff = logEntries.value.some((entry) => {
      const entryMeta = normalizeMeta(entry) as any;
      return entryMeta.kind === 'codex.item' && entryMeta.itemType === 'turn_diff' && entryMeta.turnId === meta.turnId;
    });
    if (hasTurnLevelDiff) return null;
  }

  if (typeof item.rawPatch === 'string' && item.rawPatch.trim()) {
    const candidate = item.rawPatch;
    return hasPatchFileHeaders(candidate) ? candidate : null;
  }

  const text = itemRawBodyText(item);
  const diffMarker = '\ndiff:\n';
  const diffMarkerIndex = text.indexOf(diffMarker);
  if (diffMarkerIndex >= 0) {
    const candidate = text.slice(diffMarkerIndex + diffMarker.length).trim();
    if (candidate) {
      if (hasPatchFileHeaders(candidate)) return candidate;
    }
  }
  const diffHeaderIndex = text.indexOf('diff --git');
  if (diffHeaderIndex >= 0) return text.slice(diffHeaderIndex).trim();
  const hunkIndex = text.indexOf('@@ ');
  if (hunkIndex >= 0) return null;
  return null;
}

function approvalPolicyForMode(mode: AccessMode): string {
  return mode === 'full-access' ? 'never' : 'unlessTrusted';
}

function toggleMenu(menu: 'model' | 'effort' | 'access') {
  openMenu.value = openMenu.value === menu ? null : menu;
}

function closeMenus() {
  openMenu.value = null;
}

function selectModelOption(optionId: string) {
  selectedModel.value = optionId;
  closeMenus();
}

function selectEffortOption(optionId: string) {
  selectedEffort.value = optionId;
  closeMenus();
}

function selectAccessMode(mode: AccessMode) {
  accessMode.value = mode;
  closeMenus();
}

function sandboxModeForMode(mode: AccessMode): string {
  return mode === 'full-access' ? 'dangerFullAccess' : 'workspaceWrite';
}

function sandboxPolicyForMode(mode: AccessMode): Record<string, unknown> {
  if (mode === 'full-access') {
    return { type: 'dangerFullAccess' };
  }

  return {
    type: 'workspaceWrite',
    ...(workingDirectory.value ? { writableRoots: [workingDirectory.value] } : {}),
    networkAccess: true
  };
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
  if (entry.text.startsWith('Turn interrupted')) return 'codex.interrupted';
  if (entry.text.startsWith('Error:')) return 'codex.failed';
  if (entry.text.startsWith('Item:')) return 'codex.item';
  return null;
}

async function codexRpc(method: string, params?: unknown): Promise<any> {
  const response = await apiFetch(`/api/rooms/${roomId.value}/codex/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Codex RPC failed: ${method}`);
  }
  return data.result;
}

async function codexRespond(requestId: number | string, payload: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) {
  const response = await apiFetch(`/api/rooms/${roomId.value}/codex/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, ...payload })
  });
  if (!response.ok && response.status !== 400) {
    throw new Error(`Failed to respond to Codex request (${response.status})`);
  }
}

function cloneJsonValue<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function promptForOptionSelection(
  question: string,
  options: Array<{ label?: unknown; description?: unknown }>,
  allowOther: boolean
): string[] | null {
  const lines = [
    question,
    '',
    ...options.map((option, index) => {
      const label = typeof option?.label === 'string' ? option.label : `Option ${index + 1}`;
      const description = typeof option?.description === 'string' && option.description.trim()
        ? ` — ${option.description.trim()}`
        : '';
      return `${index + 1}. ${label}${description}`;
    }),
    allowOther ? '' : '',
    allowOther ? 'Enter a number from the list or type your own answer.' : 'Enter a number from the list.'
  ].filter(Boolean);
  const raw = window.prompt(lines.join('\n'));
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return [];
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    const label = options[numeric - 1]?.label;
    return typeof label === 'string' && label.trim() ? [label.trim()] : [];
  }
  return allowOther ? [value] : [];
}

async function collectToolRequestUserInputResponse(params: any) {
  const questions = Array.isArray(params?.questions) ? params.questions.slice(0, 3) : [];
  const answers: Record<string, { answers: string[] }> = {};

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index] ?? {};
    const id =
      typeof question?.id === 'string' && question.id.trim()
        ? question.id.trim()
        : `q_${index + 1}`;
    const header =
      typeof question?.header === 'string' && question.header.trim()
        ? `${question.header.trim()}\n`
        : '';
    const promptText =
      typeof question?.question === 'string' && question.question.trim()
        ? question.question.trim()
        : `Question ${index + 1}`;
    const options = Array.isArray(question?.options) ? question.options : [];
    const allowOther = Boolean(question?.isOther);

    const selectedAnswers =
      options.length > 0
        ? promptForOptionSelection(`${header}${promptText}`.trim(), options, allowOther)
        : (() => {
            const raw = window.prompt(`${header}${promptText}`.trim());
            if (raw === null) return null;
            const value = raw.trim();
            return value ? [value] : [];
          })();

    if (selectedAnswers === null) {
      answers[id] = { answers: [] };
      continue;
    }

    answers[id] = { answers: selectedAnswers };
  }

  return { answers };
}

function summarizePermissionsRequest(params: any): string {
  const reason = typeof params?.reason === 'string' ? params.reason.trim() : '';
  const permissions =
    params?.permissions && typeof params.permissions === 'object'
      ? JSON.stringify(params.permissions, null, 2)
      : '{}';
  return [reason, permissions].filter(Boolean).join('\n\n').trim();
}

async function respondToPermissionsRequest(requestId: number | string, params: any) {
  const requestedPermissions =
    params?.permissions && typeof params.permissions === 'object'
      ? cloneJsonValue(params.permissions)
      : {};
  const accepted =
    accessMode.value === 'full-access'
      ? true
      : window.confirm(`Grant requested permissions?\n\n${summarizePermissionsRequest(params)}`);

  pushEntry({
    side: 'right',
    label: 'codex',
    text: accepted
      ? `Item: permission_request\nGranted permissions${typeof params?.reason === 'string' ? `\n${params.reason}` : ''}`
      : `Item: permission_request\nPermission request declined${typeof params?.reason === 'string' ? `\n${params.reason}` : ''}`,
    at: new Date().toISOString(),
    meta: { kind: 'codex.item', itemType: 'permission_request' }
  });

  await codexRespond(requestId, {
    result: accepted
      ? {
          scope: accessMode.value === 'full-access' ? 'session' : 'turn',
          permissions: requestedPermissions
        }
      : {
          scope: 'turn',
          permissions: {}
        }
  });
}

async function respondToMcpServerElicitation(requestId: number | string, params: any) {
  const mode = typeof params?.mode === 'string' ? params.mode : '';
  const message = typeof params?.message === 'string' ? params.message.trim() : 'MCP server requests input';

  if (mode === 'url' && typeof params?.url === 'string' && params.url.trim()) {
    const accepted = window.confirm(`${message}\n\nOpen URL?\n${params.url}`);
    if (accepted) {
      window.open(params.url, '_blank', 'noopener,noreferrer');
    }
    await codexRespond(requestId, {
      result: {
        action: accepted ? 'accept' : 'cancel',
        content: null
      }
    });
    return;
  }

  if (mode === 'form') {
    while (true) {
      const raw = window.prompt(
        `${message}\n\nProvide JSON matching the requested schema:`,
        '{}'
      );
      if (raw === null) {
        await codexRespond(requestId, {
          result: { action: 'cancel', content: null }
        });
        return;
      }
      const trimmed = raw.trim();
      try {
        const content = trimmed ? JSON.parse(trimmed) : {};
        await codexRespond(requestId, {
          result: { action: 'accept', content }
        });
        return;
      } catch {
        window.alert('Invalid JSON. Try again or press Cancel.');
      }
    }
  }
}

function readPromptFromTurn(turn: any): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = normalizeCodexItemType(item.type);
    if (type !== 'user_message') continue;
    const content = Array.isArray((item as any).content) ? (item as any).content : [];
    const texts = content
      .map((entry: any) => (entry?.type === 'text' && typeof entry?.text === 'string' ? entry.text : ''))
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n').trim();
  }
  const input = Array.isArray(turn?.input) ? turn.input : [];
  const texts = input
    .map((entry: any) => (entry?.type === 'text' && typeof entry?.text === 'string' ? entry.text : ''))
    .filter(Boolean);
  return texts.join('\n').trim();
}

function readFinalResponseFromTurn(turn: any): string {
  if (typeof turn?.finalResponse === 'string') return turn.finalResponse;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    const type = normalizeCodexItemType(item.type);
    if (type !== 'agent_message') continue;
    return extractCodexAgentMessageText(item);
  }
  return '';
}

function replayTurnsFromThreadRead(thread: any) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const turnId = typeof turn?.id === 'string' ? turn.id : null;
    const baseAt =
      typeof turn?.createdAt === 'string'
        ? turn.createdAt
        : typeof turn?.created_at === 'string'
          ? turn.created_at
          : new Date().toISOString();
    appendCodexTurnStarted(
      readPromptFromTurn(turn) || '(resumed turn)',
      baseAt,
      typeof turn?.model === 'string' ? turn.model : undefined,
      typeof turn?.effort === 'string'
        ? turn.effort
        : typeof turn?.reasoningEffort === 'string'
          ? turn.reasoningEffort
          : undefined
    );
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (codexItemTypeForUi(item) === 'user_message') continue;
      appendCodexItemTimeline(item as Record<string, unknown>, baseAt, {
        turnId,
        itemId: codexItemIdFrom(item)
      });
    }
    const status = typeof turn?.status === 'string' ? turn.status : 'completed';
    const endAt =
      typeof turn?.updatedAt === 'string'
        ? turn.updatedAt
        : typeof turn?.updated_at === 'string'
          ? turn.updated_at
          : baseAt;
    if (status === 'failed') {
      appendCodexTurnTerminal('failed', endAt, { error: turn?.error?.message ?? 'Turn failed' });
    } else if (status === 'interrupted') {
      appendCodexTurnTerminal('interrupted', endAt);
    } else if (status === 'completed') {
      appendCodexTurnTerminal('completed', endAt, {
        finalResponse: readFinalResponseFromTurn(turn),
        usage: extractCodexUsagePayload(turn) ?? turn?.usage ?? turn?.tokenUsage ?? turn?.token_usage
      });
    } else if (status === 'inProgress') {
      activeCodexTurnId = typeof turn?.id === 'string' ? turn.id : activeCodexTurnId;
    }
  }
}

function applyCodexNotification(message: CodexRpcMessage, at: string) {
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as any;
  const ensureLiveTurnStarted = () => {
    if (running.value) return;
    const lastUserEntry = [...logEntries.value]
      .reverse()
      .find((entry) => getEntryKind(entry) === 'user.message');
    appendCodexTurnStarted(lastUserEntry?.text ?? '(running turn)', at);
  };

  if (method.startsWith('codex/event/')) {
    const msg = params?.msg ?? {};
    const rawType = typeof msg?.type === 'string' ? msg.type : '';

    if (rawType === 'token_count') {
      if (msg?.info && typeof msg.info === 'object') {
        latestThreadUsageRaw = {
          total: {
            totalTokens: (msg.info as any)?.total_token_usage?.total_tokens,
            inputTokens: (msg.info as any)?.total_token_usage?.input_tokens,
            cachedInputTokens: (msg.info as any)?.total_token_usage?.cached_input_tokens,
            outputTokens: (msg.info as any)?.total_token_usage?.output_tokens,
            reasoningOutputTokens: (msg.info as any)?.total_token_usage?.reasoning_output_tokens
          },
          last: {
            totalTokens: (msg.info as any)?.last_token_usage?.total_tokens,
            inputTokens: (msg.info as any)?.last_token_usage?.input_tokens,
            cachedInputTokens: (msg.info as any)?.last_token_usage?.cached_input_tokens,
            outputTokens: (msg.info as any)?.last_token_usage?.output_tokens,
            reasoningOutputTokens: (msg.info as any)?.last_token_usage?.reasoning_output_tokens
          },
          modelContextWindow: (msg.info as any)?.model_context_window
        };
        latestUsageFromEvent.value = usageFromEvent(latestThreadUsageRaw);
      }
      return;
    }
    return;
  }

  if (method === 'thread/started') {
    const threadId = typeof params?.thread?.id === 'string' ? params.thread.id : null;
    if (threadId) currentThreadId.value = threadId;
    return;
  }

  if (method === 'thread/closed') {
    activeCodexTurnId = null;
    latestTurnDiffPatchByTurnId.clear();
    stopWorkingTimer(at);
    return;
  }

  if (method === 'thread/status/changed') {
    const status = typeof params?.status === 'string' ? params.status : '';
    if (status === 'notLoaded') {
      activeCodexTurnId = null;
      latestTurnDiffPatchByTurnId.clear();
      stopWorkingTimer(at);
    }
    return;
  }

  if (method === 'thread/tokenUsage/updated') {
    latestThreadUsageRaw = extractCodexUsagePayload(params) ?? params;
    latestUsageFromEvent.value = usageFromEvent(latestThreadUsageRaw);
    return;
  }

  if (method === 'turn/started') {
    const turn = params?.turn ?? {};
    if (typeof turn?.id === 'string') activeCodexTurnId = turn.id;
    latestThreadUsageRaw = null;
    latestUsageFromEvent.value = null;
    if (!running.value) {
      const lastUserEntry = [...logEntries.value]
        .reverse()
        .find((entry) => getEntryKind(entry) === 'user.message');
      appendCodexTurnStarted(
        lastUserEntry?.text ?? '(running turn)',
        at,
        typeof turn?.model === 'string' ? turn.model : undefined,
        typeof turn?.effort === 'string'
          ? turn.effort
          : typeof turn?.reasoningEffort === 'string'
            ? turn.reasoningEffort
            : undefined
      );
    }
    return;
  }

  if (method === 'item/started') {
    ensureLiveTurnStarted();
    const item = (params?.item && typeof params.item === 'object'
      ? params.item
      : { type: 'unknown' }) as Record<string, unknown>;
    const itemId = codexItemIdFrom(item);
    if (itemId) liveCodexItemState.set(itemId, item);
    return;
  }

  if (method === 'item/agentMessage/delta') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    const delta = params?.delta ?? params?.textDelta ?? params?.text ?? '';
    if (!itemId || typeof delta !== 'string') return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'agent_message' };
    appendCodexTextField(state, 'text', delta);
    liveCodexItemState.set(itemId, state);
    return;
  }

  if (method === 'item/plan/delta') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    const delta = params?.delta ?? params?.textDelta ?? params?.text ?? '';
    if (!itemId || typeof delta !== 'string') return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'plan' };
    appendCodexTextField(state, 'text', delta);
    liveCodexItemState.set(itemId, state);
    return;
  }

  if (method === 'item/reasoning/summaryTextDelta') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    const delta = params?.delta ?? params?.textDelta ?? params?.text ?? '';
    if (!itemId || typeof delta !== 'string') return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'reasoning' };
    const summary = (state.summary ?? {}) as Record<string, unknown>;
    appendCodexTextField(summary, 'text', delta);
    state.summary = summary;
    liveCodexItemState.set(itemId, state);
    return;
  }

  if (method === 'item/reasoning/textDelta') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    const delta = params?.delta ?? params?.textDelta ?? params?.text ?? '';
    if (!itemId || typeof delta !== 'string') return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'reasoning' };
    const content = (state.content ?? {}) as Record<string, unknown>;
    appendCodexTextField(content, 'text', delta);
    state.content = content;
    liveCodexItemState.set(itemId, state);
    return;
  }

  if (method === 'item/commandExecution/outputDelta') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    const delta = params?.delta ?? params?.outputDelta ?? params?.output ?? '';
    if (!itemId || typeof delta !== 'string') return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'command_execution' };
    appendCodexTextField(state, 'aggregatedOutput', delta);
    liveCodexItemState.set(itemId, state);
    return;
  }

  if (method === 'item/fileChange/outputDelta') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    const delta = params?.delta ?? params?.outputDelta ?? params?.output ?? '';
    if (!itemId || typeof delta !== 'string') return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'file_change' };
    appendCodexTextField(state, 'outputDelta', delta);
    liveCodexItemState.set(itemId, state);
    return;
  }

  if (method === 'item/completed') {
    ensureLiveTurnStarted();
    const item = (params?.item && typeof params.item === 'object'
      ? params.item
      : { type: 'unknown' }) as Record<string, unknown>;
    const itemId = codexItemIdFrom(item);
    const base = itemId ? liveCodexItemState.get(itemId) : undefined;
    const merged = base ? ({ ...base, ...item } as Record<string, unknown>) : item;
    if (itemId) liveCodexItemState.delete(itemId);
    appendCodexItemTimeline(merged, at, {
      turnId: typeof params?.turnId === 'string' ? params.turnId : activeCodexTurnId,
      itemId
    });
    return;
  }

  if (method === 'turn/diff/updated') {
    ensureLiveTurnStarted();
    const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
    const patch = typeof params?.diff === 'string' ? params.diff : '';
    if (turnId && patch.trim()) latestTurnDiffPatchByTurnId.set(turnId, patch);
    upsertTurnDiffEntryForTurn(turnId, patch, at);
    return;
  }

  if (method === 'turn/plan/updated') {
    ensureLiveTurnStarted();
    const plan = Array.isArray(params?.plan) ? params.plan : [];
    const explanation = typeof params?.explanation === 'string' ? params.explanation.trim() : '';
    const lines = plan.map((entry: any, i: number) => {
      const step = typeof entry?.step === 'string' && entry.step.trim() ? entry.step.trim() : `Step ${i + 1}`;
      const status = typeof entry?.status === 'string' ? entry.status : 'pending';
      return `${i + 1}. [${status}] ${step}`;
    });
    appendCodexItemTimeline({ type: 'plan', text: [explanation, ...lines].filter(Boolean).join('\n'), plan }, at);
    return;
  }

  if (method === 'model/rerouted') {
    ensureLiveTurnStarted();
    appendCodexItemTimeline(
      {
        type: 'reasoning',
        summary: { text: `model rerouted: ${params?.fromModel ?? 'unknown'} -> ${params?.toModel ?? 'unknown'}` },
        content: { text: typeof params?.reason === 'string' ? params.reason : '' }
      },
      at
    );
    return;
  }

  if (method === 'turn/completed') {
    if (!running.value) ensureLiveTurnStarted();
    const turn = params?.turn ?? {};
    if (turn?.id && activeCodexTurnId && turn.id === activeCodexTurnId) {
      activeCodexTurnId = null;
    }
    if (typeof turn?.id === 'string') {
      latestTurnDiffPatchByTurnId.delete(turn.id);
    }
    const status = typeof turn?.status === 'string' ? turn.status : 'completed';
    if (status === 'failed') {
      appendCodexTurnTerminal('failed', at, { error: turn?.error?.message ?? 'Turn failed' });
      return;
    }
    if (status === 'interrupted') {
      appendCodexTurnTerminal('interrupted', at);
      return;
    }
    appendCodexTurnTerminal('completed', at, {
      finalResponse:
        (typeof turn?.finalResponse === 'string' ? turn.finalResponse : '') ||
        '',
      usage: extractCodexUsagePayload(turn) ?? latestThreadUsageRaw
    });
  }
}

async function handleCodexServerRequest(message: CodexRpcMessage) {
  const requestId = message.id;
  if (requestId === undefined) return;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as any;

  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const decision =
      accessMode.value === 'full-access'
        ? 'acceptForSession'
        : window.confirm(
            method === 'item/fileChange/requestApproval'
              ? `Approve file change?\n\n${typeof params?.reason === 'string' ? params.reason : ''}`.trim()
              : `Approve command?\n\n${
                  typeof params?.command === 'string'
                    ? params.command
                    : Array.isArray(params?.commandActions)
                      ? params.commandActions
                          .map((entry: any) => entry?.command)
                          .filter((entry: unknown) => typeof entry === 'string')
                          .join('\n')
                      : ''
                }\n${typeof params?.reason === 'string' ? `\n${params.reason}` : ''}`.trim()
          )
          ? 'acceptForSession'
          : 'decline';

    appendCodexItemTimeline(
      {
        type: method === 'item/fileChange/requestApproval' ? 'fileChange' : 'commandExecution',
        id: codexItemIdFrom(params) ?? undefined,
        status: 'awaiting_approval',
        approval: {
          decision,
          source: accessMode.value === 'full-access' ? 'frontend-auto' : 'frontend-confirm',
          method
        }
      },
      new Date().toISOString()
    );
    await codexRespond(requestId, { result: { decision } });
    return;
  }

  if (method === 'item/permissions/requestApproval') {
    await respondToPermissionsRequest(requestId, params);
    return;
  }

  if (method === 'tool/requestUserInput') {
    const result = await collectToolRequestUserInputResponse(params);
    await codexRespond(requestId, { result });
    return;
  }

  if (method === 'mcpServer/elicitation/request') {
    await respondToMcpServerElicitation(requestId, params);
    return;
  }

  if (method === 'account/chatgptAuthTokens/refresh') {
    await codexRespond(requestId, {
      error: { code: -32601, message: 'Externally-managed ChatGPT token refresh is not supported' }
    });
    return;
  }

  await codexRespond(requestId, {
    error: { code: -32601, message: `Unsupported server-initiated request: ${method || 'unknown'}` }
  });
}

function isTimelineNearBottom(thresholdPx = 48): boolean {
  const el = timelineEl.value;
  if (!el) return true;
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distanceToBottom <= thresholdPx;
}

function onTimelineScroll() {
  shouldAutoScrollTimeline.value = isTimelineNearBottom();
}

async function scrollToBottom(force = false) {
  await nextTick();
  const el = timelineEl.value;
  if (!el) return;
  if (!force && !shouldAutoScrollTimeline.value) return;
  el.scrollTop = el.scrollHeight;
}

watch(logEntries, () => {
  void scrollToBottom(false);
});

async function loadState() {
  const response = await apiFetch(`/api/rooms/${roomId.value}/state`);
  if (!response.ok) throw new Error(`Failed to load room state (${response.status})`);
  const data = await response.json();
  usageByTurnAt.value = new Map();
  latestUsageFromEvent.value = null;
  resetCodexRuntimeState();
  currentThreadId.value = typeof data.threadId === 'string' ? data.threadId : null;
  const history = (data.timeline as TimelineEntry[])
    .filter((entry) => timelineEntryKind(entry) === 'user.message')
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
  editorVersion.value = typeof data.editor?.version === 'number' ? data.editor.version : 0;
  editorCursors.value = Array.isArray(data.editor?.cursors) ? data.editor.cursors : [];

  if (currentThreadId.value) {
    try {
      const replay = await codexRpc('thread/read', {
        threadId: currentThreadId.value,
        includeTurns: true
      });
      if (replay?.thread) {
        replayTurnsFromThreadRead(replay.thread);
      }
    } catch {
      // ignore replay errors; live stream may still work
    }
  }

  await nextTick();
  refreshCursorOverlays();

  let lastStarted: LogEntry | null = null;
  let hasTerminalAfterLastStart = false;

  for (const entry of logEntries.value) {
    const kind = getEntryKind(entry);
    if (kind === 'codex.started') {
      lastStarted = entry;
      hasTerminalAfterLastStart = false;
      continue;
    }
    if (lastStarted && (kind === 'codex.completed' || kind === 'codex.failed' || kind === 'codex.interrupted')) {
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
  const response = await apiFetch('/api/runtime');
  if (!response.ok) throw new Error(`Failed to load runtime (${response.status})`);
  const data = await response.json();
  workingDirectory.value = data.workingDirectory ?? '';
  const runtimeModel = typeof data.codexModel === 'string' ? data.codexModel : 'default';
  selectedModel.value = runtimeModel && runtimeModel !== 'default' ? runtimeModel : 'default';
  if (typeof data.codexReasoningEffort === 'string' && data.codexReasoningEffort.trim()) {
    selectedEffort.value = data.codexReasoningEffort;
  }
}

async function loadCodexThreads() {
  const response = await apiFetch('/api/codex/threads?limit=40');
  if (!response.ok) return;
  const data = (await response.json()) as { data?: CodexThreadSummary[] };
  codexThreads.value = Array.isArray(data.data) ? data.data : [];
}

async function loadModels() {
  try {
    const result = await codexRpc('model/list', {
      limit: 100,
      includeHidden: false
    });
    const data = Array.isArray(result?.data) ? result.data : [];
    const options: ModelOption[] = data
      .map((entry: any) => {
        const id = typeof entry?.id === 'string' ? entry.id : '';
        if (!id) return null;
        const effortOptions = Array.isArray(entry?.reasoningEffort)
          ? entry.reasoningEffort
              .map((effortEntry: any) => {
                const effortId = typeof effortEntry?.effort === 'string' ? effortEntry.effort : '';
                if (!effortId) return null;
                return {
                  id: effortId,
                  label: effortId.charAt(0).toUpperCase() + effortId.slice(1),
                  description:
                    typeof effortEntry?.description === 'string' && effortEntry.description.trim()
                      ? effortEntry.description.trim()
                      : undefined
                } satisfies EffortOption;
              })
              .filter((effortEntry: EffortOption | null): effortEntry is EffortOption => Boolean(effortEntry))
          : [];
        return {
          id,
          label:
            (typeof entry?.displayName === 'string' && entry.displayName.trim()) ||
            (typeof entry?.model === 'string' && entry.model.trim()) ||
            id,
          isDefault: Boolean(entry?.isDefault),
          effortOptions,
          defaultEffort:
            typeof entry?.defaultReasoningEffort === 'string' && entry.defaultReasoningEffort.trim()
              ? entry.defaultReasoningEffort
              : undefined
        } satisfies ModelOption;
      })
      .filter((entry: ModelOption | null): entry is ModelOption => Boolean(entry));
    const defaultVisibleOption = options.find((entry) => entry.isDefault) ?? null;
    const defaultPickerLabel = defaultVisibleOption
      ? `Default · ${defaultVisibleOption.label}`
      : 'Project Default';

    const withDefault =
      selectedModel.value === 'default' || !options.some((entry) => entry.id === selectedModel.value)
        ? [{
            id: 'default',
            label: defaultPickerLabel,
            effortOptions: defaultVisibleOption?.effortOptions ?? [],
            defaultEffort: defaultVisibleOption?.defaultEffort
          }, ...options]
        : options;

    modelOptions.value = withDefault;
    if (!withDefault.some((entry) => entry.id === selectedModel.value)) {
      selectedModel.value = withDefault[0]?.id ?? 'default';
    }
  } catch {
    modelOptions.value = [{ id: 'default', label: 'Project Default', isDefault: true, effortOptions: fallbackEffortOptions, defaultEffort: 'medium' }];
  }
}

function looksLikeCodexThreadId(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('thr_')) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function hydrateRoomFromThreadId(threadId: string) {
  const response = await apiFetch(`/api/rooms/${encodeURIComponent(threadId)}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId })
  });
  if (!response.ok) throw new Error(`Failed to hydrate room from thread (${response.status})`);
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
  await loadModels();
  shouldAutoScrollTimeline.value = true;
  connectEvents();
  scrollToBottom(true);
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

  const response = await apiFetch(`/api/rooms/${encodeURIComponent(room)}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: room })
  });
  if (!response.ok) throw new Error(`Failed to open Codex thread (${response.status})`);

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
        const response = await apiFetch(`/api/rooms/${roomId.value}/events`, {
          method: 'POST',
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`Events stream failed (${response.status})`);
        }

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
              let event:
                | RoomEvent
                | { type: 'system.connected'; at?: string }
                | { type: 'system.heartbeat'; at?: string }
                | null = null;
              try {
                event = JSON.parse(raw) as
                  | RoomEvent
                  | { type: 'system.connected'; at?: string }
                  | { type: 'system.heartbeat'; at?: string };
              } catch {
                event = null;
              }
              if (!event) {
                delimiterIndex = buffer.indexOf('\n\n');
                continue;
              }

              switch (event.type) {
                case 'timeline.entry':
                  {
                    const kind = timelineEntryKind(event.entry);
                    if (kind !== 'user.message') {
                      break;
                    }
                    addTimelineEntry(event.entry);
                    if (kind === 'codex.started') {
                      running.value = true;
                      startWorkingTimer(event.entry.at);
                    }
                    if (kind === 'codex.completed' || kind === 'codex.failed' || kind === 'codex.interrupted') {
                      stopWorkingTimer(event.entry.at);
                    }
                  }
                  break;
                case 'editor.updated':
                  editorVersion.value =
                    typeof event.editor.version === 'number' ? event.editor.version : editorVersion.value;
                  editorCursors.value = Array.isArray(event.editor.cursors) ? event.editor.cursors : [];
                  if (event.editor.updatedBy !== userId.value) {
                    applyingRemoteEditorUpdate = true;
                    editorText.value = event.editor.text;
                    await nextTick();
                  }
                  refreshCursorOverlays();
                  break;
                case 'codex.rpc.notification':
                  pushDebugEvent(event.type, event.at, event.message);
                  applyCodexNotification(event.message, event.at);
                  break;
                case 'codex.rpc.serverRequest':
                  pushDebugEvent(event.type, event.at, event.message);
                  void handleCodexServerRequest(event.message);
                  break;
                case 'system.connected':
                  apiError.value = null;
                  break;
                case 'system.queueOverflow':
                  apiError.value = 'Events backlog overflowed. Resyncing…';
                  await loadState();
                  break;
                case 'system.heartbeat':
                  break;
                default:
                  break;
              }
            }
            delimiterIndex = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          apiError.value = error instanceof Error ? `${error.message}. Reconnecting…` : 'Events stream disconnected. Reconnecting…';
        }
      }
      if (seq !== eventsConnectionSeq || controller.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  void read();
}

async function syncEditor() {
  const el = editorEl.value;
  try {
    const response = await apiFetch(`/api/rooms/${roomId.value}/editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId.value,
        userName: userName.value,
        text: editorText.value,
        baseVersion: editorVersion.value,
        selectionStart: el?.selectionStart ?? editorText.value.length,
        selectionEnd: el?.selectionEnd ?? editorText.value.length
      })
    });
    if (response.status === 409) {
      const data = (await response.json().catch(() => ({}))) as { editor?: any; error?: string };
      const serverEditor = data.editor;
      if (serverEditor && typeof serverEditor.text === 'string') {
        applyingRemoteEditorUpdate = true;
        editorText.value = serverEditor.text;
        editorVersion.value =
          typeof serverEditor.version === 'number' ? serverEditor.version : editorVersion.value;
        editorCursors.value = Array.isArray(serverEditor.cursors) ? serverEditor.cursors : editorCursors.value;
        apiError.value = data.error ?? 'Prompt was changed by another collaborator. Your local draft was refreshed.';
      }
      return;
    }
    if (!response.ok) {
      throw new Error(`Failed to sync editor (${response.status})`);
    }
    const editor = (await response.json().catch(() => null)) as any;
    if (editor && typeof editor.version === 'number') {
      editorVersion.value = editor.version;
    }
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
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

function onWindowPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (modelMenuEl.value?.contains(target)) return;
  if (effortMenuEl.value?.contains(target)) return;
  if (accessMenuEl.value?.contains(target)) return;
  closeMenus();
}

async function runCodex() {
  if (!canRun.value) return false;
  const prompt = editorText.value.trim();
  if (!prompt) return false;
  const messageResponse = await apiFetch(`/api/rooms/${roomId.value}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: userId.value,
      userName: userName.value,
      text: prompt
    })
  });
  if (!messageResponse.ok) throw new Error(`Failed to send message (${messageResponse.status})`);
  if (!currentThreadId.value) {
    const started = await codexRpc('thread/start', {
      ...(selectedModel.value !== 'default' ? { model: selectedModel.value } : {}),
      approvalPolicy: approvalPolicyForMode(accessMode.value),
      sandbox: sandboxModeForMode(accessMode.value)
    });
    const threadId = typeof started?.thread?.id === 'string' ? started.thread.id : null;
    if (!threadId) throw new Error('Failed to create thread');
    currentThreadId.value = threadId;
  }
  const result = await codexRpc('turn/start', {
    threadId: currentThreadId.value,
    input: [{ type: 'text', text: prompt }],
    ...(selectedModel.value !== 'default' ? { model: selectedModel.value } : {}),
    ...(selectedEffort.value ? { effort: selectedEffort.value } : {}),
    approvalPolicy: approvalPolicyForMode(accessMode.value),
    sandboxPolicy: sandboxPolicyForMode(accessMode.value)
  });
  activeCodexTurnId = typeof result?.turn?.id === 'string' ? result.turn.id : activeCodexTurnId;
  editorText.value = '';
  return true;
}

async function steerCodex() {
  if (!canSteer.value) return false;
  const prompt = editorText.value.trim();
  if (!prompt || !currentThreadId.value || !activeCodexTurnId) return false;
  const messageResponse = await apiFetch(`/api/rooms/${roomId.value}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: userId.value,
      userName: userName.value,
      text: prompt
    })
  });
  if (!messageResponse.ok) throw new Error(`Failed to send steer message (${messageResponse.status})`);
  await codexRpc('turn/steer', {
    threadId: currentThreadId.value,
    expectedTurnId: activeCodexTurnId,
    input: [{ type: 'text', text: prompt }]
  });
  editorText.value = '';
  return true;
}

async function sendToCodex() {
  if (!canSubmit.value) return;
  try {
    apiError.value = null;
    if (running.value) {
      await steerCodex();
      return;
    }
    await runCodex();
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
}

async function interruptCodex() {
  if (!canInterrupt.value) return;
  if (!currentThreadId.value || !activeCodexTurnId) return;
  try {
    await codexRpc('turn/interrupt', {
      threadId: currentThreadId.value,
      turnId: activeCodexTurnId
    });
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
}

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  void sendToCodex();
}

onMounted(async () => {
  window.addEventListener('resize', refreshCursorOverlays);
  window.addEventListener('pointerdown', onWindowPointerDown);
  try {
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
      await loadModels();
      shouldAutoScrollTimeline.value = true;
      connectEvents();
      scrollToBottom(true);
      await nextTick();
      refreshCursorOverlays();
    }
  } catch (error) {
    apiError.value = error instanceof Error ? error.message : String(error);
  }
});

onUnmounted(() => {
  eventsAbortController?.abort();
  window.removeEventListener('resize', refreshCursorOverlays);
  window.removeEventListener('pointerdown', onWindowPointerDown);
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
            <span v-if="view === 'chat'" :title="roomId">{{ shortId(roomId) }}</span>
            <span v-else>Rooms</span>
          </span>
          <span
            v-if="workingDirectory && view === 'chat'"
            class="max-w-[360px] truncate text-[11px] text-neutral-400"
            :title="workingDirectory"
          >
            {{ workingDirectory }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="view === 'chat'"
            type="button"
            class="inline-flex size-6 items-center justify-center rounded-md border border-neutral-200 text-[12px] text-neutral-600 hover:bg-neutral-100"
            :title="debugCopyStatus === 'copied' ? 'Copied debug info' : debugCopyStatus === 'error' ? 'Copy debug failed' : 'Copy debug info'"
            aria-label="Copy debug info"
            @click="copyDebugInfo"
          >
            {{ debugCopyStatus === 'copied' ? '✓' : debugCopyStatus === 'error' ? '!' : '⧉' }}
          </button>
          <span class="max-w-[180px] truncate text-xs text-neutral-400" :title="userName">{{ userName }}</span>
        </div>
      </div>
    </header>

    <div
      v-if="apiError"
      class="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12px] text-amber-800"
    >
      {{ apiError }}
    </div>

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
    <section v-else class="flex-1 overflow-y-auto" ref="timelineEl" @scroll.passive="onTimelineScroll">
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
                  <div
                    class="markdown-body text-sm leading-relaxed text-neutral-900"
                    v-html="renderMarkdown(bodyText(seg.entry))"
                  ></div>
                </div>

                <!-- Tech group -->
                <div v-else>
                  <div
                    v-if="!shouldCollapseTechSegment(seg.items)"
                    class="bg-neutral-100"
                  >
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
                          v-if="(normalizeMeta(item).itemType === 'file_change' || normalizeMeta(item).itemType === 'turn_diff') && itemPatch(item)"
                          :patch="itemPatch(item) || ''"
                        />
                        <div
                          v-else-if="normalizeMeta(item).itemType === 'command_execution' && itemCommandExecution(item)"
                          class="space-y-2"
                        >
                          <div class="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1.5">
                            <span class="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">command</span>
                            <code class="min-w-0 flex-1 break-all font-mono text-[11px] text-neutral-800">{{ itemCommandExecution(item)?.command }}</code>
                            <span
                              v-if="itemCommandExecution(item)?.exit"
                              class="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600"
                            >exit {{ itemCommandExecution(item)?.exit }}</span>
                          </div>

                          <div v-if="itemCommandExecution(item)?.output" class="overflow-hidden rounded border border-neutral-200 bg-white">
                            <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">output</div>
                            <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ itemCommandExecution(item)?.output }}</pre>
                          </div>

                          <div v-if="itemCommandExecution(item)?.stdout" class="overflow-hidden rounded border border-neutral-200 bg-white">
                            <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">stdout</div>
                            <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ itemCommandExecution(item)?.stdout }}</pre>
                          </div>

                          <div v-if="itemCommandExecution(item)?.stderr" class="overflow-hidden rounded border border-rose-200 bg-white">
                            <div class="border-b border-rose-200 bg-rose-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-rose-600">stderr</div>
                            <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-rose-700">{{ itemCommandExecution(item)?.stderr }}</pre>
                          </div>
                        </div>
                        <pre
                          v-else
                          class="m-0 whitespace-pre-wrap text-[12px] leading-relaxed"
                          :class="itemTextClass(item)"
                        >{{ itemBody(item) }}</pre>
                      </div>
                    </div>
                  </div>

                  <template v-else>
                  <button
                    class="flex w-full items-center gap-2 bg-neutral-100 px-4 py-2 text-left transition-colors hover:bg-neutral-200"
                    @click="toggleExpanded(seg.id, seg.items)"
                  >
                    <span class="text-[10px] text-neutral-400">{{ isExpanded(seg.id, seg.items) ? '▾' : '▸' }}</span>
                    <span class="text-[11px] font-medium text-neutral-500">
                      {{ isExpanded(seg.id, seg.items) ? `hide ${seg.items.length} step${seg.items.length > 1 ? 's' : ''}` : `${seg.items.length} step${seg.items.length > 1 ? 's' : ''}` }}
                    </span>
                    <span
                      v-if="!isExpanded(seg.id, seg.items)"
                      class="min-w-0 truncate text-[11px] text-neutral-400"
                    >
                      {{ techSegmentSummary(seg.items) }}
                    </span>
                  </button>

                  <div v-if="isExpanded(seg.id, seg.items)" class="border-t border-neutral-200 bg-neutral-100">
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
                          v-if="(normalizeMeta(item).itemType === 'file_change' || normalizeMeta(item).itemType === 'turn_diff') && itemPatch(item)"
                          :patch="itemPatch(item) || ''"
                        />
                        <div
                          v-else-if="normalizeMeta(item).itemType === 'command_execution' && itemCommandExecution(item)"
                          class="space-y-2"
                        >
                          <div class="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1.5">
                            <span class="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">command</span>
                            <code class="min-w-0 flex-1 break-all font-mono text-[11px] text-neutral-800">{{ itemCommandExecution(item)?.command }}</code>
                            <span
                              v-if="itemCommandExecution(item)?.exit"
                              class="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600"
                            >exit {{ itemCommandExecution(item)?.exit }}</span>
                          </div>

                          <div v-if="itemCommandExecution(item)?.output" class="overflow-hidden rounded border border-neutral-200 bg-white">
                            <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">output</div>
                            <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ itemCommandExecution(item)?.output }}</pre>
                          </div>

                          <div v-if="itemCommandExecution(item)?.stdout" class="overflow-hidden rounded border border-neutral-200 bg-white">
                            <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">stdout</div>
                            <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ itemCommandExecution(item)?.stdout }}</pre>
                          </div>

                          <div v-if="itemCommandExecution(item)?.stderr" class="overflow-hidden rounded border border-rose-200 bg-white">
                            <div class="border-b border-rose-200 bg-rose-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-rose-600">stderr</div>
                            <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-rose-700">{{ itemCommandExecution(item)?.stderr }}</pre>
                          </div>
                        </div>
                        <pre
                          v-else
                          class="m-0 whitespace-pre-wrap text-[12px] leading-relaxed"
                          :class="itemTextClass(item)"
                        >{{ itemBody(item) }}</pre>
                      </div>
                    </div>
                  </div>
                  </template>
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
        <div class="rounded-2xl border border-neutral-300 bg-white px-3 py-3">
          <div class="relative">
            <textarea
              ref="editorEl"
              v-model="editorText"
              rows="5"
              class="w-full resize-none border-0 bg-transparent px-0 pb-3 pt-0 font-sans text-sm text-neutral-900 outline-none placeholder:text-neutral-300"
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
                  class="absolute left-1 top-0 -translate-y-full whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                  :style="{ backgroundColor: cursor.color }"
                >
                  {{ cursor.userName }}
                </span>
              </div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <div ref="modelMenuEl" class="relative">
                <button
                  type="button"
                  class="inline-flex min-w-[9rem] items-center justify-between gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-left text-xs text-neutral-800 transition-colors hover:bg-neutral-50"
                  @click="toggleMenu('model')"
                >
                  <span class="truncate">{{ selectedModelOptionLabel }}</span>
                  <span class="text-[10px] text-neutral-400">{{ openMenu === 'model' ? '▴' : '▾' }}</span>
                </button>
                <div
                  v-if="openMenu === 'model'"
                  class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-[18rem] overflow-hidden rounded-2xl border border-neutral-200 bg-white"
                >
                  <button
                    v-for="option in modelOptions"
                    :key="option.id"
                    type="button"
                    class="flex w-full items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2 text-left text-[12px] text-neutral-700 last:border-0 hover:bg-neutral-50"
                    @click="selectModelOption(option.id)"
                  >
                    <span class="truncate">{{ option.label }}</span>
                    <span v-if="selectedModel === option.id" class="text-[10px] text-neutral-400">current</span>
                  </button>
                </div>
              </div>
              <div ref="effortMenuEl" class="relative">
                <button
                  type="button"
                  class="inline-flex min-w-[6.5rem] items-center justify-between gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-left text-xs text-neutral-800 transition-colors hover:bg-neutral-50"
                  @click="toggleMenu('effort')"
                >
                  <span class="truncate">{{ selectedEffortLabel }}</span>
                  <span class="text-[10px] text-neutral-400">{{ openMenu === 'effort' ? '▴' : '▾' }}</span>
                </button>
                <div
                  v-if="openMenu === 'effort'"
                  class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-[14rem] overflow-hidden rounded-2xl border border-neutral-200 bg-white"
                >
                  <button
                    v-for="option in effortOptions"
                    :key="option.id"
                    type="button"
                    class="flex w-full items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2 text-left text-[12px] text-neutral-700 last:border-0 hover:bg-neutral-50"
                    @click="selectEffortOption(option.id)"
                  >
                    <span class="truncate">{{ option.label }}</span>
                    <span v-if="selectedEffort === option.id" class="text-[10px] text-neutral-400">current</span>
                  </button>
                </div>
              </div>
              <div ref="accessMenuEl" class="relative">
                <button
                  type="button"
                  class="inline-flex min-w-[8.5rem] items-center justify-between gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-left text-xs text-neutral-800 transition-colors hover:bg-neutral-50"
                  @click="toggleMenu('access')"
                >
                  <span class="truncate">{{ selectedAccessLabel }}</span>
                  <span class="text-[10px] text-neutral-400">{{ openMenu === 'access' ? '▴' : '▾' }}</span>
                </button>
                <div
                  v-if="openMenu === 'access'"
                  class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-[14rem] overflow-hidden rounded-2xl border border-neutral-200 bg-white"
                >
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2 text-left text-[12px] text-neutral-700 hover:bg-neutral-50"
                    @click="selectAccessMode('full-access')"
                  >
                    <span>Full Access</span>
                    <span v-if="accessMode === 'full-access'" class="text-[10px] text-neutral-400">current</span>
                  </button>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] text-neutral-700 hover:bg-neutral-50"
                    @click="selectAccessMode('need-approve')"
                  >
                    <span>Need Approve</span>
                    <span v-if="accessMode === 'need-approve'" class="text-[10px] text-neutral-400">current</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="ml-auto flex items-center gap-2">
              <span class="text-[11px] text-neutral-400">
                <span :title="contextAvailabilityTitle">
                {{ contextAvailabilityText }}
                </span>
              </span>
              <button
                v-if="running"
                :disabled="!canInterrupt"
                @click="interruptCodex"
                class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30"
              >
                Stop
              </button>
              <button
                :disabled="!canSubmit"
                @click="sendToCodex"
                class="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
              >
                <span
                  v-if="running"
                  class="size-[10px] animate-spin rounded-full border-[1.5px] border-white/30 border-t-white"
                ></span>
                {{ running ? 'Steer' : 'Run' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </footer>

  </div>
</template>

<style scoped>
:deep(.markdown-body) {
  color: inherit;
}

:deep(.markdown-body > :first-child) {
  margin-top: 0;
}

:deep(.markdown-body > :last-child) {
  margin-bottom: 0;
}

:deep(.markdown-body p),
:deep(.markdown-body ul),
:deep(.markdown-body ol),
:deep(.markdown-body pre),
:deep(.markdown-body blockquote) {
  margin: 0 0 0.75rem;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  padding-left: 1.25rem;
}

:deep(.markdown-body li + li) {
  margin-top: 0.2rem;
}

:deep(.markdown-body code) {
  border-radius: 0.375rem;
  background: #f5f5f4;
  padding: 0.1rem 0.35rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
}

:deep(.markdown-body pre) {
  overflow-x: auto;
  border-radius: 0.75rem;
  border: 1px solid #e5e7eb;
  background: #f5f5f4;
  padding: 0.85rem 1rem;
  color: #1f2937;
}

:deep(.markdown-body pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
}

:deep(.markdown-body a) {
  color: #0f766e;
  text-decoration: underline;
  text-underline-offset: 0.12em;
}

:deep(.markdown-body blockquote) {
  border-left: 3px solid #d4d4d4;
  padding-left: 0.9rem;
  color: #525252;
}
</style>
