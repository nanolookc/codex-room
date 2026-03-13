<script setup lang="ts">
import { computed } from 'vue';
import {
  Brain,
  Terminal,
  FileEdit,
  FileDiff,
  Wrench,
  Globe,
  Image,
  Eye,
  EyeOff,
  Cpu,
  Map,
  Shuffle,
  AlertCircle
} from 'lucide-vue-next';
import DiffPatch from './DiffPatch.vue';
import {
  itemCommandExecution,
  itemPatch,
  type CodexLogEntry
} from '../lib/codexTimeline';

const props = defineProps<{
  item: CodexLogEntry;
  allEntries: CodexLogEntry[];
  label: string;
  body: string;
  textClass: string;
  rowAlignClass: string;
}>();

const patch = computed(() => itemPatch(props.allEntries, props.item));
const commandExecution = computed(() => itemCommandExecution(props.item));

const itemType = computed(() => props.item.meta?.itemType ?? '');

const typeIcon = computed(() => {
  const map: Record<string, unknown> = {
    reasoning: Brain,
    command_execution: Terminal,
    file_change: FileEdit,
    turn_diff: FileDiff,
    mcp_tool_call: Wrench,
    collab_tool_call: Wrench,
    web_search: Globe,
    image_view: Image,
    entered_review_mode: Eye,
    exited_review_mode: EyeOff,
    context_compaction: Cpu,
    plan: Map,
    model_reroute: Shuffle,
  };
  return map[itemType.value] ?? AlertCircle;
});

const typeColor = computed(() => {
  const map: Record<string, string> = {
    reasoning: 'text-violet-400',
    command_execution: 'text-zinc-400',
    file_change: 'text-teal-500',
    turn_diff: 'text-sky-500',
    mcp_tool_call: 'text-orange-400',
    collab_tool_call: 'text-orange-400',
    web_search: 'text-blue-400',
    image_view: 'text-pink-400',
    entered_review_mode: 'text-zinc-400',
    exited_review_mode: 'text-zinc-400',
    context_compaction: 'text-zinc-400',
    plan: 'text-amber-500',
    model_reroute: 'text-amber-400',
  };
  return map[itemType.value] ?? 'text-zinc-400';
});
</script>

<template>
  <div
    class="flex gap-3 border-b border-zinc-100 px-4 py-2 last:border-0"
    :class="rowAlignClass"
  >
    <!-- Icon label -->
    <div class="flex w-8 shrink-0 items-start justify-end pt-0.5">
      <component :is="typeIcon" class="size-3.5" :class="typeColor" />
    </div>

    <div class="flex-1 min-w-0">
      <DiffPatch
        v-if="(item.meta?.itemType === 'file_change' || item.meta?.itemType === 'turn_diff') && patch"
        :patch="patch"
      />
      <div
        v-else-if="item.meta?.itemType === 'command_execution' && commandExecution"
        class="space-y-2"
      >
        <div class="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-950 px-2.5 py-2">
          <code class="min-w-0 flex-1 break-all font-mono text-[12px] text-emerald-400">{{ commandExecution.command }}</code>
          <span
            v-if="commandExecution.exit"
            class="rounded border px-1.5 py-0.5 font-mono text-[10px]"
            :class="commandExecution.exit === '0' ? 'border-zinc-700 bg-zinc-800 text-zinc-400' : 'border-rose-800 bg-rose-950 text-rose-400'"
          >exit {{ commandExecution.exit }}</span>
        </div>

        <div v-if="commandExecution.output" class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div class="border-b border-zinc-100 bg-zinc-50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">output</div>
          <pre class="m-0 whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-700">{{ commandExecution.output }}</pre>
        </div>

        <div v-if="commandExecution.stdout" class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div class="border-b border-zinc-100 bg-zinc-50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">stdout</div>
          <pre class="m-0 whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-700">{{ commandExecution.stdout }}</pre>
        </div>

        <div v-if="commandExecution.stderr" class="overflow-hidden rounded-lg border border-rose-200 bg-rose-50">
          <div class="flex items-center gap-1.5 border-b border-rose-200 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-rose-500">
            <AlertCircle class="size-3" />
            stderr
          </div>
          <pre class="m-0 whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-rose-700">{{ commandExecution.stderr }}</pre>
        </div>
      </div>
      <pre
        v-else
        class="m-0 whitespace-pre-wrap text-[12px] leading-relaxed"
        :class="textClass"
      >{{ body }}</pre>
    </div>
  </div>
</template>
