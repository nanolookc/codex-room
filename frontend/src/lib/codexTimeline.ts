import type { TimelineEntry } from '@codex-room/shared';
import {
  codexItemIdFrom,
  extractCodexAgentMessageText,
  extractTextFragments,
  normalizeCodexItemType,
  type CodexUsageDisplay,
  uniqueTextParts
} from '@codex-room/shared';

export type CodexLogEntry = {
  id: string;
  side: 'left' | 'right';
  label: string;
  text: string;
  at: string;
  meta?: TimelineEntry['meta'];
  rawPatch?: string;
};

export type ParsedCommandExecution = {
  command: string;
  exit: string;
  output: string;
  stdout: string;
  stderr: string;
};

export type UsageDisplay = CodexUsageDisplay;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function hasPatchFileHeaders(patch: string): boolean {
  const candidate = patch.trim();
  if (!candidate) return false;
  return (
    candidate.includes('diff --git ') ||
    (candidate.includes('\n--- ') && candidate.includes('\n+++ ')) ||
    candidate.startsWith('--- ')
  );
}

export function codexItemTypeForUi(item: unknown): string {
  return normalizeCodexItemType((item as Record<string, unknown> | null)?.type);
}

export function findLogEntryIndexForCodexItem(
  entries: CodexLogEntry[],
  itemId: string | null,
  turnId?: string | null
): number {
  if (!itemId) return -1;
  let fallbackIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const meta = normalizeMeta(entry) as Record<string, unknown>;
    if (meta.kind !== 'codex.item') continue;
    if ((meta.itemId ?? null) !== itemId) continue;
    if (turnId !== undefined && (meta.turnId ?? null) !== (turnId ?? null)) {
      if (fallbackIndex === -1) fallbackIndex = i;
      continue;
    }
    return i;
  }
  return fallbackIndex;
}

export function shouldRenderStartedItem(itemType: string): boolean {
  return [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'collab_tool_call',
    'web_search',
    'image_view',
    'entered_review_mode',
    'exited_review_mode',
    'context_compaction'
  ].includes(itemType);
}

export function appendCodexTextField(target: Record<string, unknown>, key: string, chunk: unknown) {
  if (typeof chunk !== 'string' || !chunk) return;
  const prev = typeof target[key] === 'string' ? (target[key] as string) : '';
  target[key] = `${prev}${chunk}`;
}

function pickRawPatchFromValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() ? value : null;
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
  }
  return null;
}

export function extractItemRawPatch(item: Record<string, unknown>, itemType: string): string | null {
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
      ...extractTextFragments((item.summary as Record<string, unknown> | undefined)?.text),
      ...extractTextFragments(item.summary_text),
      ...extractTextFragments(item.summary)
    ]);
    const contentParts = uniqueTextParts([
      ...extractTextFragments((item.content as Record<string, unknown> | undefined)?.text),
      ...extractTextFragments(item.content),
      ...extractTextFragments(item.raw_content)
    ]);
    return uniqueTextParts([summaryParts.join('\n').trim(), contentParts.join('\n').trim()]).join('\n').trim();
  }

  if (itemType === 'plan') {
    return typeof item.text === 'string' ? item.text : safeJson(item.plan ?? item);
  }

  if (itemType === 'command_execution') {
    const parts: string[] = [];
    if (item.command !== undefined) {
      parts.push(`command: ${typeof item.command === 'string' ? item.command : safeJson(item.command)}`);
    }
    if (typeof item.status === 'string' && item.status.trim()) parts.push(`status: ${item.status.trim()}`);
    if (item.approval && typeof item.approval === 'object') {
      const approval = item.approval as Record<string, unknown>;
      if (typeof approval.decision === 'string' && approval.decision.trim()) {
        parts.push(`approval: ${approval.decision.trim()}`);
      }
      if (typeof approval.reason === 'string' && approval.reason.trim()) {
        parts.push(`reason: ${approval.reason.trim()}`);
      }
    }
    if (item.exitCode !== undefined || item.exit_code !== undefined) {
      parts.push(`exit: ${String(item.exitCode ?? item.exit_code)}`);
    }
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
        const path = typeof obj.path === 'string' ? obj.path : '';
        const kind = typeof obj.kind === 'string' ? obj.kind : '';
        return [kind, path].filter(Boolean).join(': ');
      })
      .filter(Boolean);
    const parts = [
      typeof item.status === 'string' && item.status.trim() ? `status: ${item.status.trim()}` : '',
      item.approval && typeof item.approval === 'object' && typeof (item.approval as Record<string, unknown>).decision === 'string'
        ? `approval: ${String((item.approval as Record<string, unknown>).decision)}`
        : '',
      fileLines.length ? `files:\n${fileLines.map((line) => `- ${line}`).join('\n')}` : '',
      typeof item.status === 'string' &&
      item.status === 'failed' &&
      typeof item.outputDelta === 'string' &&
      item.outputDelta.trim()
        ? `error:\n${item.outputDelta.trim()}`
        : ''
    ].filter(Boolean);
    return parts.join('\n').trim() || safeJson(item);
  }

  if (itemType === 'turn_diff') {
    const rawPatch = extractItemRawPatch(item, itemType);
    return rawPatch && hasPatchFileHeaders(rawPatch) ? '' : safeJson(item);
  }

  if (itemType === 'mcp_tool_call') {
    return [
      typeof item.server === 'string' ? `server: ${item.server}` : '',
      typeof item.tool === 'string' ? `tool: ${item.tool}` : '',
      typeof item.status === 'string' ? `status: ${item.status}` : '',
      item.arguments !== undefined ? `arguments:\n${safeJson(item.arguments)}` : '',
      item.result !== undefined ? `result:\n${safeJson(item.result)}` : '',
      item.error !== undefined ? `error:\n${safeJson(item.error)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (itemType === 'collab_tool_call') {
    return [
      typeof item.tool === 'string' ? `tool: ${item.tool}` : '',
      typeof item.status === 'string' ? `status: ${item.status}` : '',
      typeof item.senderThreadId === 'string' ? `sender: ${item.senderThreadId}` : '',
      typeof item.receiverThreadId === 'string' ? `receiver: ${item.receiverThreadId}` : '',
      typeof item.newThreadId === 'string' ? `new thread: ${item.newThreadId}` : '',
      typeof item.agentStatus === 'string' ? `agent: ${item.agentStatus}` : '',
      typeof item.prompt === 'string' && item.prompt.trim() ? `prompt:\n${item.prompt.trim()}` : ''
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (itemType === 'model_reroute') {
    const fromModel = typeof item.fromModel === 'string' ? item.fromModel : 'unknown';
    const toModel = typeof item.toModel === 'string' ? item.toModel : 'unknown';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    return [`from: ${fromModel}`, `to: ${toModel}`, reason ? `reason: ${reason}` : '']
      .filter(Boolean)
      .join('\n');
  }

  if (itemType === 'web_search' || itemType === 'image_view') {
    if (itemType === 'web_search') {
      const action = item.action && typeof item.action === 'object' ? (item.action as Record<string, unknown>) : null;
      const actionType =
        typeof action?.type === 'string'
          ? action.type
          : typeof action?.action === 'string'
            ? action.action
            : '';
      return [
        typeof item.query === 'string' ? `query: ${item.query}` : '',
        actionType ? `action: ${actionType}` : '',
        typeof action?.url === 'string' ? `url: ${action.url}` : '',
        typeof action?.pattern === 'string' ? `pattern: ${action.pattern}` : ''
      ]
        .filter(Boolean)
        .join('\n')
        .trim() || safeJson(item);
    }
    const path = typeof item.path === 'string' ? item.path : '';
    return path ? `path: ${path}` : safeJson(item);
  }

  if (itemType === 'entered_review_mode' || itemType === 'exited_review_mode') {
    return typeof item.review === 'string' ? item.review : safeJson(item);
  }

  if (itemType === 'context_compaction') {
    return 'Conversation history compacted.';
  }

  return safeJson(item);
}

export function buildCodexItemTimelineEntry(
  itemInput: Record<string, unknown>,
  at: string,
  options: { turnId?: string | null; itemId?: string | null } = {}
): Omit<CodexLogEntry, 'id'> | null {
  const item = itemInput && typeof itemInput === 'object' ? itemInput : ({ type: 'unknown' } as Record<string, unknown>);
  const itemType = codexItemTypeForUi(item);
  if (itemType === 'user_message') return null;
  const details = codexItemDetailsText(item, itemType).trim();
  const rawPatch = extractItemRawPatch(item, itemType) ?? undefined;
  return {
    side: 'right',
    label: 'codex',
    text: `Item: ${itemType}${details ? `\n${details}` : ''}`,
    at,
    meta: {
      kind: 'codex.item',
      itemType,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      ...(options.itemId ? { itemId: options.itemId } : {})
    } as TimelineEntry['meta'],
    rawPatch
  };
}

export function normalizeMeta(
  entry: Pick<CodexLogEntry, 'meta' | 'text' | 'side'>
): NonNullable<CodexLogEntry['meta']> {
  if (entry.meta) return entry.meta;
  if (entry.side === 'left') return { kind: 'user.message' };
  if (entry.text.startsWith('Started:')) return { kind: 'codex.started' };
  if (entry.text.startsWith('Turn completed')) return { kind: 'codex.completed' };
  if (entry.text.startsWith('Turn interrupted')) return { kind: 'codex.interrupted' };
  if (entry.text.startsWith('Error:')) return { kind: 'codex.failed' };
  if (entry.text.startsWith('Item:')) {
    const firstLine = entry.text.split('\n')[0] ?? '';
    return { kind: 'codex.item', itemType: firstLine.replace('Item:', '').trim() || 'unknown' };
  }
  return { kind: 'codex.item', itemType: 'unknown' };
}

function isEmptyRawReasoning(text: string): boolean {
  const normalized = text.trim();
  if (normalized === 'Item: reasoning') return true;
  if (!normalized.startsWith('Item: reasoning')) return false;
  if (!normalized.includes('\nraw:\n')) return false;
  return /"summary"\s*:\s*\[\s*\]/.test(normalized) && /"content"\s*:\s*\[\s*\]/.test(normalized);
}

export function isHiddenItem(entry: Pick<CodexLogEntry, 'meta' | 'text' | 'side'>): boolean {
  const meta = normalizeMeta(entry);
  if (meta.kind !== 'codex.item') return false;
  const itemType = (meta.itemType ?? '').toLowerCase();
  if (itemType === 'user_message' || itemType === 'usermessage') return true;
  if (itemType === 'reasoning' && isEmptyRawReasoning(entry.text)) return true;
  const firstLine = entry.text.split('\n')[0]?.trim().toLowerCase() ?? '';
  return firstLine === 'item: user_message' || firstLine === 'item: usermessage';
}

export function timelineEntryKind(entry: TimelineEntry): TimelineEntry['meta']['kind'] | null {
  if (entry.meta?.kind) return entry.meta.kind;
  if (entry.side === 'left') return 'user.message';
  if (entry.text.startsWith('Started:')) return 'codex.started';
  if (entry.text.startsWith('Turn completed')) return 'codex.completed';
  if (entry.text.startsWith('Turn interrupted')) return 'codex.interrupted';
  if (entry.text.startsWith('Error:')) return 'codex.failed';
  if (entry.text.startsWith('Item:')) return 'codex.item';
  return null;
}

export function itemRawBodyText(entry: CodexLogEntry): string {
  if (!entry.text.startsWith('Item:')) return entry.text;
  return entry.text.split('\n').slice(1).join('\n').trim() || '(no details)';
}

export function bodyText(entry: CodexLogEntry): string {
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

export function turnAlreadyContainsAgentMessage(entries: CodexLogEntry[], finalText: string): boolean {
  const normalizedFinal = finalText.trim();
  if (!normalizedFinal) return false;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const kind = normalizeMeta(entry).kind;
    if (kind === 'codex.started') break;
    if (kind !== 'codex.item') continue;
    if (normalizeMeta(entry).itemType !== 'agent_message') continue;
    if (bodyText(entry).trim() === normalizedFinal) return true;
  }
  return false;
}

export function parseCommandExecutionText(text: string): ParsedCommandExecution {
  const lines = text.split('\n');
  const command = lines.find((line) => line.startsWith('command:'))?.replace('command:', '').trim() ?? text.trim();
  const exit = lines.find((line) => line.startsWith('exit:'))?.replace('exit:', '').trim() ?? '';
  const markerPrefixes = ['command:', 'exit:', 'stdout:', 'stderr:', 'output:', 'duration_ms:'];

  const collectBlock = (marker: string): string => {
    const start = lines.findIndex((line) => line.startsWith(marker));
    if (start === -1) return '';
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
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

export function itemCommandExecution(item: CodexLogEntry): ParsedCommandExecution | null {
  if (normalizeMeta(item).itemType !== 'command_execution') return null;
  return parseCommandExecutionText(bodyText(item));
}

export function itemPatch(entries: CodexLogEntry[], item: CodexLogEntry): string | null {
  const meta = normalizeMeta(item) as Record<string, unknown>;
  if (meta.itemType === 'file_change' && typeof meta.turnId === 'string') {
    const hasTurnLevelDiff = entries.some((entry) => {
      const entryMeta = normalizeMeta(entry) as Record<string, unknown>;
      return entryMeta.kind === 'codex.item' && entryMeta.itemType === 'turn_diff' && entryMeta.turnId === meta.turnId;
    });
    if (hasTurnLevelDiff) return null;
  }

  if (typeof item.rawPatch === 'string' && item.rawPatch.trim()) {
    return hasPatchFileHeaders(item.rawPatch) ? item.rawPatch : null;
  }

  const text = itemRawBodyText(item);
  const diffMarker = '\ndiff:\n';
  const diffMarkerIndex = text.indexOf(diffMarker);
  if (diffMarkerIndex >= 0) {
    const candidate = text.slice(diffMarkerIndex + diffMarker.length).trim();
    if (candidate && hasPatchFileHeaders(candidate)) return candidate;
  }
  const diffHeaderIndex = text.indexOf('diff --git');
  if (diffHeaderIndex >= 0) return text.slice(diffHeaderIndex).trim();
  if (text.indexOf('@@ ') >= 0) return null;
  return null;
}
