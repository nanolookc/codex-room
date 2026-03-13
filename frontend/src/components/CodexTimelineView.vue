<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import MarkdownIt from 'markdown-it';
import type { CodexLogEntry as LogEntry, UsageDisplay } from '../lib/codexTimeline';
import {
  bodyText,
  isHiddenItem,
  normalizeMeta,
  parseCommandExecutionText
} from '../lib/codexTimeline';
import CodexTurnGroup from './CodexTurnGroup.vue';

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

type TurnSegment =
  | { type: 'message'; id: string; entry: LogEntry }
  | { type: 'plan_state'; id: string; text: string }
  | { type: 'tech'; id: string; items: LogEntry[] };

const props = defineProps<{
  roomId: string;
  logEntries: LogEntry[];
  running: boolean;
  workingSeconds: number;
  usageByTurnAt: Map<string, UsageDisplay>;
  latestUsageFromEvent: UsageDisplay | null;
  latestThreadUsageRaw: unknown;
  latestTurnPlanTextByTurnId: Map<string, { text: string; at: string }>;
}>();

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

const timelineEl = ref<HTMLElement | null>(null);
const shouldAutoScrollTimeline = ref(true);
const segmentExpansionOverrides = ref(new Map<string, boolean>());

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

  for (const entry of props.logEntries) {
    const kind = getEntryKind(entry);

    if (kind === 'user.message') continue;

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

  if (props.running) {
    const lastCodexEntry = [...props.logEntries]
      .reverse()
      .find((entry) => getEntryKind(entry) === 'codex.item');
    if (lastCodexEntry) {
      map.set(lastCodexEntry.id, formatDuration(props.workingSeconds, 'Working '));
    }
  }

  return map;
});

function durationLabel(entry: LogEntry): string | null {
  return turnDurationByEntryId.value.get(entry.id) ?? null;
}

const groups = computed<DisplayGroup[]>(() => {
  const result: DisplayGroup[] = [];
  let current: TurnGroup | null = null;

  for (const entry of props.logEntries) {
    const kind = getEntryKind(entry);

    if (kind === 'user.message') {
      if (current) {
        result.push(current);
        current = null;
      }
      result.push({ type: 'message', id: entry.id, entry });
      continue;
    }

    if (kind === 'codex.started') {
      if (current) result.push(current);
      current = { type: 'turn', id: entry.id, startEntry: entry, items: [] };
      continue;
    }

    if (kind === 'codex.completed' || kind === 'codex.failed' || kind === 'codex.interrupted') {
      if (current) {
        current.endEntry = entry;
        result.push(current);
        current = null;
      }
      continue;
    }

    if (current) current.items.push(entry);
    else result.push({ type: 'message', id: entry.id, entry });
  }

  if (current) result.push(current);
  return result;
});

function turnPrompt(group: TurnGroup): string {
  const text = group.startEntry.text;
  return text.startsWith('Started:') ? text.slice(8).trim() : text;
}

function turnIsRunning(group: TurnGroup): boolean {
  return !group.endEntry && props.running;
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
  if (turnIsRunning(group)) return `${time} · ${formatDuration(props.workingSeconds)}${modelPart}${effortPart}`;
  if (!group.endEntry) return `${time}${modelPart}${effortPart}`;
  const duration = durationLabel(group.endEntry)?.replace('Worked ', '') ?? '';
  const base = duration ? `${time} · ${duration}` : time;
  return `${base}${modelPart}${effortPart}`;
}

function turnUsage(group: TurnGroup): string | null {
  const end = group.endEntry;
  if (!end || getEntryKind(end) !== 'codex.completed') return null;
  const usageFromReplay = props.usageByTurnAt.get(end.at);
  if (usageFromReplay) {
    return `in ${usageFromReplay.input}${usageFromReplay.cachedInput ? ` (cached ${usageFromReplay.cachedInput})` : ''} · out ${usageFromReplay.output} · total ${usageFromReplay.total}`;
  }
  const match = end.text.match(/^Tokens:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function turnContext(group: TurnGroup): string | null {
  const end = group.endEntry;
  if (!end || getEntryKind(end) !== 'codex.completed') return null;
  const fromUsage = props.usageByTurnAt.get(end.at)?.contextAvailablePercent;
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

function turnGroupId(group: TurnGroup): string | null {
  const startMeta = normalizeMeta(group.startEntry) as Record<string, unknown>;
  if (typeof startMeta.turnId === 'string' && startMeta.turnId) return startMeta.turnId;
  for (const item of group.items) {
    const meta = normalizeMeta(item) as Record<string, unknown>;
    if (typeof meta.turnId === 'string' && meta.turnId) return meta.turnId;
  }
  return null;
}

function turnSegments(group: TurnGroup): TurnSegment[] {
  const result: TurnSegment[] = [];
  let batch: LogEntry[] = [];
  const turnId = turnGroupId(group);
  const transientPlan = turnId ? props.latestTurnPlanTextByTurnId.get(turnId) : null;
  const hasAuthoritativePlanItem = group.items.some((item) => normalizeMeta(item).itemType === 'plan');

  const flushBatch = () => {
    if (batch.length > 0) {
      result.push({ type: 'tech', id: batch[0].id, items: batch });
      batch = [];
    }
  };

  if (transientPlan?.text.trim() && !hasAuthoritativePlanItem) {
    result.push({ type: 'plan_state', id: `plan-state-${turnId}`, text: transientPlan.text.trim() });
  }

  for (const item of group.items) {
    if (isHiddenItem(item)) continue;
    if (normalizeMeta(item).itemType === 'agent_message') {
      flushBatch();
      result.push({ type: 'message', id: item.id, entry: item });
      continue;
    }
    batch.push(item);
  }

  flushBatch();
  return result;
}

function shouldCollapseTechSegment(items: LogEntry[]): boolean {
  if (items.length === 0) return false;
  const onlyReasoning = items.every((item) => normalizeMeta(item).itemType === 'reasoning');
  if (onlyReasoning && items.length <= 2) return false;
  return true;
}

function shouldAutoExpand(_items: LogEntry[]): boolean {
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
  const labels: Record<string, string> = {
    reasoning: 'think',
    model_reroute: 'model',
    command_execution: 'cmd',
    file_change: 'file',
    turn_diff: 'turn diff',
    mcp_tool_call: 'tool',
    collab_tool_call: 'tool',
    web_search: 'web',
    image_view: 'img',
    entered_review_mode: 'review',
    exited_review_mode: 'review',
    context_compaction: 'compact',
    plan: 'plan'
  };
  return labels[meta.itemType ?? ''] ?? (meta.itemType ?? 'item');
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
    'collab_tool_call',
    'web_search',
    'image_view',
    'entered_review_mode',
    'exited_review_mode',
    'context_compaction'
  ];

  entries.sort((a, b) => {
    const aIndex = orderedKeys.indexOf(a[0]);
    const bIndex = orderedKeys.indexOf(b[0]);
    return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
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
        case 'web_search':
          return format(count, 'web action', 'web actions');
        case 'image_view':
          return format(count, 'image view', 'image views');
        case 'entered_review_mode':
        case 'exited_review_mode':
          return format(count, 'review step', 'review steps');
        case 'context_compaction':
          return format(count, 'compaction', 'compactions');
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

function itemTextClass(item: LogEntry): string {
  const meta = normalizeMeta(item);
  if (meta.itemType === 'reasoning') return 'text-neutral-500 italic';
  if (meta.itemType === 'model_reroute') return 'text-amber-700';
  if (meta.itemType === 'command_execution') return 'font-mono text-neutral-700';
  if (meta.itemType === 'file_change') return 'font-mono text-teal-700';
  if (meta.itemType === 'turn_diff') return 'font-mono text-sky-700';
  return 'text-neutral-700';
}

function itemRowAlignClass(item: LogEntry): string {
  return normalizeMeta(item).itemType === 'reasoning' ? 'items-center' : 'items-start';
}

function renderMarkdown(text: string): string {
  return markdown.render(text);
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

watch(
  () => props.logEntries,
  () => {
    void scrollToBottom(false);
  },
  { deep: true }
);

defineExpose({
  scrollToBottom
});
</script>

<template>
  <section ref="timelineEl" class="flex-1 overflow-y-auto" @scroll.passive="onTimelineScroll">
    <div class="flex flex-col gap-3 px-5 py-5">
      <div v-if="groups.length === 0" class="py-10 text-sm text-neutral-500">
        <p class="mb-3">No messages yet in `{{ roomId }}`.</p>
      </div>

      <template v-for="group in groups" :key="group.id">
        <div v-if="group.type === 'message'" class="flex justify-start">
          <div class="max-w-[78%] rounded-xl bg-neutral-200 px-4 py-3">
            <pre class="m-0 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-900">{{ group.entry.text }}</pre>
          </div>
        </div>

        <CodexTurnGroup
          v-else
          :group="group"
          :segments="turnSegments(group)"
          :all-entries="logEntries"
          :turn-prompt="turnPrompt(group)"
          :turn-meta="turnMeta(group)"
          :turn-meta-title="turnMetaTitle(group)"
          :turn-status-class="turnStatusClass(group)"
          :render-markdown="renderMarkdown"
          :should-collapse-tech-segment="shouldCollapseTechSegment"
          :is-expanded="isExpanded"
          :toggle-expanded="toggleExpanded"
          :tech-segment-summary="techSegmentSummary"
          :item-label="itemLabel"
          :item-body="itemBody"
          :item-text-class="itemTextClass"
          :item-row-align-class="itemRowAlignClass"
        />
      </template>
    </div>
  </section>
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
