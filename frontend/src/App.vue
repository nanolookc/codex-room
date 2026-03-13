<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  CodexRpcMessage,
  EditorCursor,
  RoomEvent,
  TimelineEntry
} from '@codex-room/shared';
import {
  codexItemIdFrom,
  codexTurnIdFromValue,
  extractCodexUsagePayload,
  normalizeUsagePayload,
  readFinalResponseFromTurn,
  readPromptFromTurn,
  usageFromEvent
} from '@codex-room/shared';
import CodexComposer from './components/CodexComposer.vue';
import CodexErrorBanner from './components/CodexErrorBanner.vue';
import CodexHeaderBar from './components/CodexHeaderBar.vue';
import CodexHomeView from './components/CodexHomeView.vue';
import CodexTimelineView from './components/CodexTimelineView.vue';
import {
  approvalPolicyForMode,
  approvalDecisionOptionsFromValue,
  type AccessMode,
  buildGrantedPermissions,
  extractRequestedWriteRoots,
  parseModelEffortOptions,
  sandboxModeForMode,
  sandboxPolicyForMode,
  threadStatusTypeFromValue
} from './lib/codexProtocol';
import {
  appendCodexTextField,
  buildCodexItemTimelineEntry,
  type CodexLogEntry as LogEntry,
  codexItemTypeForUi,
  extractItemRawPatch,
  findLogEntryIndexForCodexItem,
  isHiddenItem,
  normalizeMeta,
  shouldRenderStartedItem,
  timelineEntryKind,
  turnAlreadyContainsAgentMessage,
  type UsageDisplay
} from './lib/codexTimeline';
import {
  generateFunUserName,
  shortId,
  type ApprovalPromptOutcome,
  type CodexThreadSummary,
  type EffortOption,
  type ModelOption,
  type PendingApproval,
  type PendingPermissionsRequest,
  type PermissionPromptOutcome
} from './lib/codexAppUi';
import { useCursorOverlays } from './composables/useCursorOverlays';

const query = new URLSearchParams(window.location.search);
const API = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
const roomFromQuery = query.get('room');
const sessionKeyFromQuery = query.get('key')?.trim() ?? '';
const publicRepoUrl = 'https://github.com/nanolookc/codex-room';
const publicStartCommand = 'bun run ./cli/src/index.ts start --publish';
const initialRoomId = roomFromQuery ?? 'main';

const roomId = ref(initialRoomId);
const view = ref<'home' | 'chat'>(roomFromQuery ? 'chat' : 'home');
const userId = ref(`u-${Math.random().toString(36).slice(2, 8)}`);
const userName = ref(generateFunUserName());
const workingDirectory = ref('');
const codexThreads = ref<CodexThreadSummary[]>([]);
const editorEl = ref<HTMLTextAreaElement | null>(null);

type DebugEventSnapshot = {
  type: string;
  at: string;
  payload: unknown;
};

type TimelineViewExposed = {
  scrollToBottom: (force?: boolean) => Promise<void>;
};

const logEntries = ref<LogEntry[]>([]);
const editorText = ref('');
const editorCursors = ref<EditorCursor[]>([]);
const editorVersion = ref(0);
const running = ref(false);
const activeTaskStartedAt = ref<number | null>(null);
const workingSeconds = ref(0);
const usageByTurnAt = ref(new Map<string, UsageDisplay>());
const latestUsageFromEvent = ref<UsageDisplay | null>(null);
const currentThreadId = ref<string | null>(null);
const debugCopyStatus = ref<'idle' | 'copied' | 'error'>('idle');
const apiError = ref<string | null>(null);
const conflictedEditorDraft = ref<string | null>(null);
const modelOptions = ref<ModelOption[]>([]);
const selectedModel = ref('default');
const selectedEffort = ref('');
const accessMode = ref<AccessMode>('full-access');
const pendingApproval = ref<PendingApproval | null>(null);
const pendingPermissionsRequest = ref<PendingPermissionsRequest | null>(null);
const timelineViewEl = ref<TimelineViewExposed | null>(null);

const { cursorOverlays, refreshCursorOverlays } = useCursorOverlays({
  editorEl,
  editorText,
  editorCursors,
  userId
});

let eventsAbortController: AbortController | null = null;
let editorTimer: number | null = null;
let workingTimer: number | null = null;
let applyingRemoteEditorUpdate = false;
let eventsConnectionSeq = 0;
let activeCodexTurnId: string | null = null;
const latestThreadUsageRaw = ref<unknown>(null);
const liveCodexItemState = new Map<string, Record<string, unknown>>();
const latestTurnDiffPatchByTurnId = new Map<string, string>();
const latestTurnPlanTextByTurnId = ref(new Map<string, { text: string; at: string }>());
const recentDebugEvents: DebugEventSnapshot[] = [];
const MAX_DEBUG_EVENTS = 300;
let pendingApprovalResolver: ((decision: ApprovalPromptOutcome) => void) | null = null;
let pendingPermissionsResolver: ((outcome: PermissionPromptOutcome) => void) | null = null;

const hasPrompt = computed(() => editorText.value.trim().length > 0);
const canRun = computed(() => hasPrompt.value && !running.value);
const canSteer = computed(() => hasPrompt.value && running.value);
const canSubmit = computed(() => canRun.value || canSteer.value);
const canInterrupt = computed(() => running.value);
const defaultModelOption = computed(() =>
  modelOptions.value.find((option) => option.isDefault) ?? null
);
const activeModelOption = computed(() => {
  if (selectedModel.value === 'default') {
    return defaultModelOption.value ?? null;
  }
  return modelOptions.value.find((option) => option.id === selectedModel.value) ?? defaultModelOption.value ?? null;
});
const effortOptions = computed(() => activeModelOption.value?.effortOptions ?? []);
const selectedModelOptionLabel = computed(() => {
  if (selectedModel.value === 'default') {
    return defaultModelOption.value?.label ?? 'Default';
  }
  return modelOptions.value.find((option) => option.id === selectedModel.value)?.label ?? selectedModel.value;
});
const selectedModelButtonLabel = computed(() => selectedModelOptionLabel.value.replace(/^gpt\b/u, 'GPT'));
const selectedEffortLabel = computed(() => {
  return effortOptions.value.find((option) => option.id === selectedEffort.value)?.label ?? selectedEffort.value;
});
const selectedAccessLabel = computed(() =>
  accessMode.value === 'full-access' ? 'Full Access' : 'Need Approve'
);
const shortRoomId = computed(() => shortId(roomId.value));
const showPublicLanding = computed(() => !sessionKeyFromQuery && !roomFromQuery && view.value === 'home');

watch(
  [selectedModel, modelOptions],
  () => {
    if (effortOptions.value.some((option) => option.id === selectedEffort.value)) return;
    selectedEffort.value =
      activeModelOption.value?.defaultEffort ??
      effortOptions.value[0]?.id ??
      '';
  },
  { immediate: true }
);

function syncComposerDefaults(model?: string, reasoningEffort?: string) {
  if (typeof model === 'string' && model.trim()) {
    selectedModel.value = model.trim();
  }
  if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) {
    selectedEffort.value = reasoningEffort.trim();
  }
}

function commandTextFromApprovalParams(params: any): string {
  if (typeof params?.command === 'string' && params.command.trim()) return params.command.trim();
  if (Array.isArray(params?.commandActions)) {
    const commands = params.commandActions
      .map((entry: any) => (typeof entry?.command === 'string' ? entry.command.trim() : ''))
      .filter(Boolean);
    if (commands.length > 0) return commands.join('\n');
  }
  return '';
}

function fileLinesFromApprovalItem(item: Record<string, unknown> | null): string[] {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const obj = entry as Record<string, unknown>;
      const kind = typeof obj.kind === 'string' ? obj.kind : '';
      const path = typeof obj.path === 'string' ? obj.path : '';
      return [kind, path].filter(Boolean).join(': ');
    })
    .filter(Boolean);
}

function openApprovalPrompt(request: PendingApproval): Promise<ApprovalPromptOutcome> {
  if (pendingApprovalResolver) {
    pendingApprovalResolver('cleared');
    pendingApprovalResolver = null;
  }
  pendingApproval.value = request;
  return new Promise((resolve) => {
    pendingApprovalResolver = (decision) => {
      pendingApproval.value = null;
      pendingApprovalResolver = null;
      resolve(decision);
    };
  });
}

function resolvePendingApproval(decision: ApprovalPromptOutcome) {
  pendingApprovalResolver?.(decision);
}

function openPermissionsPrompt(request: PendingPermissionsRequest): Promise<PermissionPromptOutcome> {
  if (pendingPermissionsResolver) {
    pendingPermissionsResolver('cleared');
    pendingPermissionsResolver = null;
  }
  pendingPermissionsRequest.value = request;
  return new Promise((resolve) => {
    pendingPermissionsResolver = (outcome) => {
      pendingPermissionsRequest.value = null;
      pendingPermissionsResolver = null;
      resolve(outcome);
    };
  });
}

function resolvePendingPermissions(outcome: PermissionPromptOutcome) {
  pendingPermissionsResolver?.(outcome);
}

function resetCodexRuntimeState() {
  activeCodexTurnId = null;
  latestThreadUsageRaw.value = null;
  liveCodexItemState.clear();
  latestTurnDiffPatchByTurnId.clear();
  latestTurnPlanTextByTurnId.value = new Map();
  recentDebugEvents.length = 0;
  pendingApproval.value = null;
  pendingApprovalResolver = null;
  pendingPermissionsRequest.value = null;
  pendingPermissionsResolver = null;
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

function replaceLogEntry(index: number, entry: LogEntry) {
  const next = [...logEntries.value];
  next[index] = entry;
  logEntries.value = next;
}

function apiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (sessionKeyFromQuery) headers.set('x-codex-room-key', sessionKeyFromQuery);
  return headers;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: apiHeaders(init.headers)
  });
}

function unauthorizedAccessMessage() {
  if (sessionKeyFromQuery) {
    return 'Session key is missing or invalid. Re-open the room link from `codex-room start`.';
  }
  return 'Room access is missing or expired. Open the invite link again.';
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

function appendCodexItemTimeline(itemInput: Record<string, unknown>, at: string, options: { turnId?: string | null; itemId?: string | null } = {}) {
  const entry = buildCodexItemTimelineEntry(itemInput, at, options);
  if (!entry) return;
  pushEntry(entry);
}

function upsertCodexItemTimeline(itemInput: Record<string, unknown>, at: string, options: { turnId?: string | null; itemId?: string | null } = {}) {
  const entry = buildCodexItemTimelineEntry(itemInput, at, options);
  if (!entry) return;
  const itemId = options.itemId ?? codexItemIdFrom(itemInput);
  const index = findLogEntryIndexForCodexItem(logEntries.value, itemId, options.turnId);
  if (index === -1) {
    pushEntry(entry);
    return;
  }
  const existing = logEntries.value[index];
  replaceLogEntry(index, {
    ...existing,
    ...entry,
    id: existing.id
  });
}

function upsertTurnDiffEntryForTurn(turnId: string | null, patch: string, at: string): boolean {
  if (!turnId || !patch.trim()) return false;
  for (let i = logEntries.value.length - 1; i >= 0; i -= 1) {
    const entry = logEntries.value[i];
    const meta = normalizeMeta(entry) as Record<string, unknown>;
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

function appendCodexTurnStarted(prompt: string, at: string, model?: string, reasoningEffort?: string, turnId?: string | null) {
  pushEntry({
    side: 'right',
    label: 'codex',
    text: `Started: ${prompt || '(resumed turn)'}`,
    at,
    meta: { kind: 'codex.started', model, reasoningEffort, ...(turnId ? { turnId } : {}) } as Record<string, unknown>
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

  const parsed = usageFromEvent(options.usage ?? latestThreadUsageRaw.value);
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
  const finalText = turnAlreadyContainsAgentMessage(logEntries.value, finalTextRaw) ? '' : finalTextRaw;
  pushEntry({
    side: 'right',
    label: 'codex',
    text: `Turn completed${usageLine}${contextLine}${finalText ? `\nFinal response\n${finalText}` : ''}`,
    at,
    meta: { kind: 'codex.completed' }
  });
  stopWorkingTimer(at);
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

function stopWorkingTimer(_endedAtIso?: string) {
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
      const description =
        typeof option?.description === 'string' && option.description.trim()
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

async function respondToPermissionsRequest(requestId: number | string, params: any) {
  const requestedPermissions =
    params?.permissions && typeof params.permissions === 'object'
      ? cloneJsonValue(params.permissions)
      : {};
  const requestedWriteRoots = extractRequestedWriteRoots(requestedPermissions);
  const outcome =
    accessMode.value === 'full-access'
          ? ({ action: 'grant', scope: 'session', grantedWriteRoots: requestedWriteRoots } satisfies PermissionPromptOutcome)
      : await openPermissionsPrompt({
          requestId,
          turnId:
            typeof params?.turnId === 'string' && params.turnId.trim()
              ? params.turnId
              : activeCodexTurnId,
          reason: typeof params?.reason === 'string' ? params.reason.trim() : '',
          permissions: requestedPermissions,
          requestedWriteRoots,
          selectedWriteRoots: [...requestedWriteRoots]
        });
  if (outcome === 'cleared') return;
  const accepted = outcome.action === 'grant';
  const grantedPermissions = accepted
    ? buildGrantedPermissions(requestedPermissions, outcome.grantedWriteRoots)
    : {};

  await codexRespond(requestId, {
    result: accepted
      ? {
          scope: accessMode.value === 'full-access' ? 'session' : outcome.scope,
          permissions: grantedPermissions
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
        content: null,
        _meta: null
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
          result: { action: 'cancel', content: null, _meta: null }
        });
        return;
      }
      const trimmed = raw.trim();
      try {
        const content = trimmed ? JSON.parse(trimmed) : {};
        await codexRespond(requestId, {
          result: { action: 'accept', content, _meta: null }
        });
        return;
      } catch {
        window.alert('Invalid JSON. Try again or press Cancel.');
      }
    }
  }
}

function replayTurnsFromThreadRead(thread: any) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const turnModel = typeof turn?.model === 'string' ? turn.model : undefined;
    const turnEffort =
      typeof turn?.effort === 'string'
        ? turn.effort
        : typeof turn?.reasoningEffort === 'string'
          ? turn.reasoningEffort
          : undefined;
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
      turnModel,
      turnEffort,
      turnId
    );
    syncComposerDefaults(turnModel, turnEffort);
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
    latestThreadUsageRaw.value = {
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
        latestUsageFromEvent.value = usageFromEvent(latestThreadUsageRaw.value);
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
    currentThreadId.value = null;
    activeCodexTurnId = null;
    latestTurnDiffPatchByTurnId.clear();
    stopWorkingTimer(at);
    return;
  }

  if (method === 'thread/status/changed') {
    const status = threadStatusTypeFromValue(params?.status);
    if (status === 'notLoaded') {
      currentThreadId.value = null;
      activeCodexTurnId = null;
      latestTurnDiffPatchByTurnId.clear();
      stopWorkingTimer(at);
    }
    return;
  }

  if (method === 'thread/tokenUsage/updated') {
    latestThreadUsageRaw.value = extractCodexUsagePayload(params) ?? params;
    latestUsageFromEvent.value = usageFromEvent(latestThreadUsageRaw.value);
    return;
  }

  if (method === 'turn/started') {
    const turn = params?.turn ?? {};
    const turnModel = typeof turn?.model === 'string' ? turn.model : undefined;
    const turnEffort =
      typeof turn?.effort === 'string'
        ? turn.effort
        : typeof turn?.reasoningEffort === 'string'
          ? turn.reasoningEffort
          : undefined;
    if (typeof turn?.id === 'string') activeCodexTurnId = turn.id;
    latestThreadUsageRaw.value = null;
    latestUsageFromEvent.value = null;
    syncComposerDefaults(turnModel, turnEffort);
    if (!running.value) {
      const lastUserEntry = [...logEntries.value]
        .reverse()
        .find((entry) => getEntryKind(entry) === 'user.message');
      appendCodexTurnStarted(
        lastUserEntry?.text ?? '(running turn)',
        at,
        turnModel,
        turnEffort,
        typeof turn?.id === 'string' ? turn.id : null
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
    const turnId = codexTurnIdFromValue(params, activeCodexTurnId);
    if (shouldRenderStartedItem(codexItemTypeForUi(item))) {
      upsertCodexItemTimeline(item, at, { turnId, itemId });
    }
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
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
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
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
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
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
    return;
  }

  if (method === 'item/reasoning/summaryPartAdded') {
    ensureLiveTurnStarted();
    const itemId = codexItemIdFrom(params);
    if (!itemId) return;
    const state = liveCodexItemState.get(itemId) ?? { id: itemId, type: 'reasoning' };
    const summary = (state.summary ?? {}) as Record<string, unknown>;
    const current = typeof summary.text === 'string' ? summary.text : '';
    if (current.trim() && !current.endsWith('\n\n')) {
      summary.text = `${current}\n\n`;
    }
    state.summary = summary;
    liveCodexItemState.set(itemId, state);
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
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
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
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
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
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
    upsertCodexItemTimeline(state, at, { turnId: codexTurnIdFromValue(params, activeCodexTurnId), itemId });
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
    const turnId = codexTurnIdFromValue(params, activeCodexTurnId);
    if (codexItemTypeForUi(merged) === 'plan' && turnId) {
      const next = new Map(latestTurnPlanTextByTurnId.value);
      next.delete(turnId);
      latestTurnPlanTextByTurnId.value = next;
    }
    upsertCodexItemTimeline(merged, at, {
      turnId,
      itemId
    });
    return;
  }

  if (method === 'turn/diff/updated') {
    ensureLiveTurnStarted();
    const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
    const patch =
      typeof params?.diff === 'string'
        ? params.diff
        : typeof params?.diffPreview === 'string'
          ? params.diffPreview
          : '';
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
    const turnId = codexTurnIdFromValue(params, activeCodexTurnId);
    if (!turnId) return;
    latestTurnPlanTextByTurnId.value = new Map(latestTurnPlanTextByTurnId.value).set(turnId, {
      text: [explanation, ...lines].filter(Boolean).join('\n'),
      at
    });
    return;
  }

  if (method === 'model/rerouted') {
    ensureLiveTurnStarted();
    appendCodexItemTimeline(
      {
        type: 'model_reroute',
        fromModel: typeof params?.fromModel === 'string' ? params.fromModel : 'unknown',
        toModel: typeof params?.toModel === 'string' ? params.toModel : 'unknown',
        reason: typeof params?.reason === 'string' ? params.reason : ''
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
      const next = new Map(latestTurnPlanTextByTurnId.value);
      next.delete(turn.id);
      latestTurnPlanTextByTurnId.value = next;
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
      usage: extractCodexUsagePayload(turn) ?? latestThreadUsageRaw.value
    });
  }
}

async function handleCodexServerRequest(message: CodexRpcMessage) {
  const requestId = message.id;
  if (requestId === undefined) return;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as any;

  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const itemId = codexItemIdFrom(params);
    const pendingItem = itemId ? liveCodexItemState.get(itemId) ?? null : null;
    const decision =
      accessMode.value === 'full-access'
        ? 'acceptForSession'
        : await openApprovalPrompt({
            requestId,
            method,
            turnId:
              typeof params?.turnId === 'string' && params.turnId.trim()
                ? params.turnId
                : activeCodexTurnId,
            itemId,
            title: method === 'item/fileChange/requestApproval' ? 'Approve File Change' : 'Approve Command',
            reason: typeof params?.reason === 'string' ? params.reason.trim() : '',
            command: method === 'item/commandExecution/requestApproval' ? commandTextFromApprovalParams(params) : undefined,
            patch:
              method === 'item/fileChange/requestApproval' && pendingItem
                ? extractItemRawPatch(pendingItem, 'file_change') ?? undefined
                : undefined,
            files:
              method === 'item/fileChange/requestApproval'
                ? fileLinesFromApprovalItem(pendingItem)
                : undefined,
            decisions: approvalDecisionOptionsFromValue(params?.availableDecisions)
          });
    if (decision === 'cleared') return;
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
  if (response.status === 401) {
    throw new Error(unauthorizedAccessMessage());
  }
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
        const effortOptions = parseModelEffortOptions(entry) as EffortOption[];
        return {
          id,
          label:
            (typeof entry?.displayName === 'string' && entry.displayName.trim()) ||
            (typeof entry?.model === 'string' && entry.model.trim()) ||
            id,
          description:
            typeof entry?.description === 'string' && entry.description.trim()
              ? entry.description.trim()
              : undefined,
          isDefault: Boolean(entry?.isDefault),
          effortOptions,
          defaultEffort:
            typeof entry?.defaultReasoningEffort === 'string' && entry.defaultReasoningEffort.trim()
              ? entry.defaultReasoningEffort
              : undefined
        } satisfies ModelOption;
      })
      .filter((entry: ModelOption | null): entry is ModelOption => Boolean(entry));
    modelOptions.value = options;
    if (selectedModel.value !== 'default' && !options.some((entry) => entry.id === selectedModel.value)) {
      selectedModel.value = defaultModelOption.value?.id ?? 'default';
    }
  } catch {
    modelOptions.value = [];
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
    conflictedEditorDraft.value = null;
    stopWorkingTimer();
  }

  const url = new URL(window.location.href);
  url.searchParams.set('room', cleanRoomId);
  window.history.replaceState({}, '', url.toString());

  view.value = 'chat';
  await loadState();
  await loadModels();
  connectEvents();
  await timelineViewEl.value?.scrollToBottom(true);
}

function goHome() {
  eventsAbortController?.abort();
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url.toString());
  view.value = 'home';
  if (showPublicLanding.value) return;
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
                case 'timeline.entry': {
                  const kind = timelineEntryKind(event.entry);
                  if (kind !== 'user.message') {
                    break;
                  }
                  addTimelineEntry(event.entry);
                  break;
                }
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
                case 'codex.rpc.serverRequest.resolved':
                  if (pendingApproval.value && String(pendingApproval.value.requestId) === String(event.requestId)) {
                    resolvePendingApproval('cleared');
                  }
                  if (
                    pendingPermissionsRequest.value &&
                    String(pendingPermissionsRequest.value.requestId) === String(event.requestId)
                  ) {
                    resolvePendingPermissions('cleared');
                  }
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
  try {
    const response = await apiFetch(`/api/rooms/${roomId.value}/editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId.value,
        userName: userName.value,
        text: editorText.value,
        baseVersion: editorVersion.value,
        selectionStart: editorEl.value?.selectionStart ?? editorText.value.length,
        selectionEnd: editorEl.value?.selectionEnd ?? editorText.value.length
      })
    });
    if (response.status === 409) {
      const data = (await response.json().catch(() => ({}))) as { editor?: any; error?: string };
      const serverEditor = data.editor;
      if (serverEditor && typeof serverEditor.text === 'string') {
        if (editorText.value && editorText.value !== serverEditor.text) {
          conflictedEditorDraft.value = editorText.value;
        }
        applyingRemoteEditorUpdate = true;
        editorText.value = serverEditor.text;
        editorVersion.value =
          typeof serverEditor.version === 'number' ? serverEditor.version : editorVersion.value;
        editorCursors.value = Array.isArray(serverEditor.cursors) ? serverEditor.cursors : editorCursors.value;
        apiError.value =
          data.error ??
          (conflictedEditorDraft.value
            ? 'Prompt was changed by another collaborator. Server text was loaded; your previous draft can be restored.'
            : 'Prompt was changed by another collaborator. Your local draft was refreshed.');
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

watch(
  editorCursors,
  () => {
    refreshCursorOverlays();
  },
  { deep: true }
);

function onEditorSelectionChange() {
  refreshCursorOverlays();
  scheduleEditorSync(80);
}

function onEditorScroll() {
  refreshCursorOverlays();
}

function setEditorEl(el: Element | null) {
  editorEl.value = el as HTMLTextAreaElement | null;
}

function restoreConflictedDraft() {
  if (typeof conflictedEditorDraft.value !== 'string') return;
  applyingRemoteEditorUpdate = true;
  editorText.value = conflictedEditorDraft.value;
  conflictedEditorDraft.value = null;
  apiError.value = null;
}

function selectModelOption(optionId: string) {
  selectedModel.value = optionId;
}

function selectEffortOption(optionId: string) {
  selectedEffort.value = optionId;
}

function selectAccessMode(mode: AccessMode) {
  accessMode.value = mode;
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

const latestContextAvailablePercent = computed(() => {
  const fromLiveUsage = usageFromEvent(latestThreadUsageRaw.value)?.contextAvailablePercent;
  if (fromLiveUsage !== undefined) return fromLiveUsage;
  for (let i = logEntries.value.length - 1; i >= 0; i -= 1) {
    const entry = logEntries.value[i];
    if (getEntryKind(entry) !== 'codex.completed') continue;
    const replayUsage = usageByTurnAt.value.get(entry.at)?.contextAvailablePercent;
    if (typeof replayUsage === 'number') return replayUsage;
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

  const normalized = normalizeUsagePayload(latestThreadUsageRaw.value);
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
    sandboxPolicy: sandboxPolicyForMode(accessMode.value, workingDirectory.value)
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
  if (showPublicLanding.value) return;
  if (view.value === 'chat') {
    try {
      await loadRuntime();
      await loadCodexThreads();
      if (looksLikeCodexThreadId(roomId.value)) {
        try {
          await hydrateRoomFromThreadId(roomId.value);
        } catch {
          // Fall back to persisted room state if hydration fails.
        }
      }
      await loadState();
      await loadModels();
      connectEvents();
      await timelineViewEl.value?.scrollToBottom(true);
      await nextTick();
      refreshCursorOverlays();
    } catch (error) {
      apiError.value = error instanceof Error ? error.message : String(error);
    }
    return;
  }

  try {
    await loadRuntime();
    await loadCodexThreads();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'Room access is missing or expired. Open the invite link again.') {
      apiError.value = message;
    }
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
  <div class="mx-auto flex h-dvh max-w-[720px] flex-col">
    <CodexHeaderBar
      :view="view"
      :running="running"
      :room-id="roomId"
      :short-room-id="shortRoomId"
      :working-directory="workingDirectory"
      :debug-copy-status="debugCopyStatus"
      :user-name="userName"
      @go-home="goHome"
      @copy-debug="copyDebugInfo"
    />

    <CodexErrorBanner
      v-if="apiError"
      :api-error="apiError"
      :has-conflicted-draft="Boolean(conflictedEditorDraft)"
      @restore-draft="restoreConflictedDraft"
    />

    <CodexHomeView
      v-if="view === 'home'"
      :public-landing="showPublicLanding"
      :repo-url="publicRepoUrl"
      :start-command="publicStartCommand"
      :codex-threads="codexThreads"
      @open-new-room="openNewRoom"
      @open-thread="openCodexThread"
    />

    <template v-else>
      <CodexTimelineView
        ref="timelineViewEl"
        :room-id="roomId"
        :log-entries="logEntries"
        :running="running"
        :working-seconds="workingSeconds"
        :usage-by-turn-at="usageByTurnAt"
        :latest-usage-from-event="latestUsageFromEvent"
        :latest-thread-usage-raw="latestThreadUsageRaw"
        :latest-turn-plan-text-by-turn-id="latestTurnPlanTextByTurnId"
        :pending-approval="pendingApproval"
        :pending-permissions-request="pendingPermissionsRequest"
        @resolve-approval="resolvePendingApproval"
        @resolve-permissions="resolvePendingPermissions"
      />

      <CodexComposer
        v-model="editorText"
        :cursor-overlays="cursorOverlays"
        :model-options="modelOptions"
        :selected-model="selectedModel"
        :selected-model-button-label="selectedModelButtonLabel"
        :effort-options="effortOptions"
        :selected-effort="selectedEffort"
        :selected-effort-label="selectedEffortLabel"
        :access-mode="accessMode"
        :selected-access-label="selectedAccessLabel"
        :context-availability-text="contextAvailabilityText"
        :context-availability-title="contextAvailabilityTitle"
        :running="running"
        :can-interrupt="canInterrupt"
        :can-submit="canSubmit"
        :set-textarea-el="setEditorEl"
        @editor-keydown="onEditorKeydown"
        @editor-selection-change="onEditorSelectionChange"
        @editor-scroll="onEditorScroll"
        @select-model="selectModelOption"
        @select-effort="selectEffortOption"
        @select-access="selectAccessMode"
        @interrupt="interruptCodex"
        @submit="sendToCodex"
      />
    </template>
  </div>
</template>
