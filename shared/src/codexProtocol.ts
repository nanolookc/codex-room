export type CodexUsageDisplay = {
  input: number;
  output: number;
  total: number;
  cachedInput?: number;
  contextAvailablePercent?: number;
};

export function normalizeCodexItemType(type: unknown): string {
  if (typeof type !== 'string') return 'unknown';
  const trimmed = type.trim();
  if (!trimmed) return 'unknown';
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s/-]+/g, '_')
    .toLowerCase();
}

export function normalizeCodexItem(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null;
  return {
    ...(item as Record<string, unknown>),
    type: normalizeCodexItemType((item as Record<string, unknown>).type)
  };
}

export function codexItemIdFrom(value: unknown): string | null {
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!obj) return null;
  return (
    (typeof obj.id === 'string' && obj.id) ||
    (typeof obj.itemId === 'string' && obj.itemId) ||
    (typeof obj.item_id === 'string' && obj.item_id) ||
    (typeof obj.call_id === 'string' && obj.call_id) ||
    null
  );
}

export function threadStatusTypeFromValue(status: unknown): string {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && typeof (status as Record<string, unknown>).type === 'string') {
    return ((status as Record<string, unknown>).type as string).trim();
  }
  return '';
}

export function extractTextFragments(value: unknown): string[] {
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
  }
  return [];
}

export function uniqueTextParts(parts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const normalized = part.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function extractCodexAgentMessageText(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const obj = item as Record<string, unknown>;
  if (typeof obj.text === 'string' && obj.text.trim()) return obj.text.trim();
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return (part as Record<string, unknown>).text as string;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

export function extractPromptFromInput(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const input = Array.isArray((params as Record<string, unknown>).input)
    ? ((params as Record<string, unknown>).input as unknown[])
    : [];
  return input
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      return typeof (entry as Record<string, unknown>).text === 'string'
        ? ((entry as Record<string, unknown>).text as string).trim()
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function extractFinalResponseFromItem(item: Record<string, unknown> | null): string {
  if (!item) return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object') return '';
      return typeof (entry as Record<string, unknown>).text === 'string'
        ? ((entry as Record<string, unknown>).text as string).trim()
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function readPromptFromTurn(turn: unknown): string {
  const obj = turn && typeof turn === 'object' ? (turn as Record<string, unknown>) : {};
  const items = Array.isArray(obj.items) ? obj.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (normalizeCodexItemType((item as Record<string, unknown>).type) !== 'user_message') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    const texts = content
      .map((entry) =>
        entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text' && typeof (entry as Record<string, unknown>).text === 'string'
          ? ((entry as Record<string, unknown>).text as string)
          : ''
      )
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n').trim();
  }

  const input = Array.isArray(obj.input) ? obj.input : [];
  return input
    .map((entry) =>
      entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text' && typeof (entry as Record<string, unknown>).text === 'string'
        ? ((entry as Record<string, unknown>).text as string)
        : ''
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function readFinalResponseFromTurn(turn: unknown): string {
  const obj = turn && typeof turn === 'object' ? (turn as Record<string, unknown>) : {};
  if (typeof obj.finalResponse === 'string') return obj.finalResponse;
  const items = Array.isArray(obj.items) ? obj.items : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    if (normalizeCodexItemType((item as Record<string, unknown>).type) !== 'agent_message') continue;
    return extractCodexAgentMessageText(item);
  }
  return '';
}

export function codexTurnIdFromValue(value: unknown, fallback: string | null = null): string | null {
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!obj) return fallback;
  const nestedTurn = obj.turn && typeof obj.turn === 'object' ? (obj.turn as Record<string, unknown>) : null;
  return (
    (typeof obj.turnId === 'string' && obj.turnId) ||
    (typeof obj.turn_id === 'string' && obj.turn_id) ||
    (typeof nestedTurn?.id === 'string' && nestedTurn.id) ||
    fallback
  );
}

export function extractCodexUsagePayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const nested =
    obj.usage ??
    obj.tokenUsage ??
    obj.token_usage ??
    ((obj.turn && typeof obj.turn === 'object' ? (obj.turn as Record<string, unknown>).usage : undefined) ?? undefined) ??
    ((obj.turn && typeof obj.turn === 'object' ? (obj.turn as Record<string, unknown>).tokenUsage : undefined) ?? undefined) ??
    ((obj.turn && typeof obj.turn === 'object' ? (obj.turn as Record<string, unknown>).token_usage : undefined) ?? undefined) ??
    undefined;
  if (!nested || typeof nested !== 'object') return nested;
  if (
    typeof obj.modelContextWindow === 'number' ||
    typeof obj.model_context_window === 'number' ||
    typeof obj.contextWindowTokens === 'number' ||
    typeof obj.context_window_tokens === 'number'
  ) {
    return {
      ...(nested as Record<string, unknown>),
      ...(typeof obj.modelContextWindow === 'number' ? { modelContextWindow: obj.modelContextWindow } : {}),
      ...(typeof obj.model_context_window === 'number' ? { model_context_window: obj.model_context_window } : {}),
      ...(typeof obj.contextWindowTokens === 'number' ? { contextWindowTokens: obj.contextWindowTokens } : {}),
      ...(typeof obj.context_window_tokens === 'number'
        ? { context_window_tokens: obj.context_window_tokens }
        : {})
    };
  }
  return nested;
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

export function normalizeUsagePayload(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object') return null;
  const obj = usage as Record<string, unknown>;
  const nested =
    (obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : null) ??
    (obj.tokenUsage && typeof obj.tokenUsage === 'object' ? (obj.tokenUsage as Record<string, unknown>) : null) ??
    (obj.token_usage && typeof obj.token_usage === 'object' ? (obj.token_usage as Record<string, unknown>) : null) ??
    obj;
  const totalObj =
    nested.total && typeof nested.total === 'object' ? (nested.total as Record<string, unknown>) : null;
  const lastObj =
    nested.last && typeof nested.last === 'object' ? (nested.last as Record<string, unknown>) : null;
  return { ...nested, ...(totalObj ?? lastObj ?? {}) };
}

export function extractContextAvailabilityPercent(usage: unknown): number | null {
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

export function usageFromEvent(usage: unknown): CodexUsageDisplay | null {
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
