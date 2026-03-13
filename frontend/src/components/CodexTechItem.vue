<script setup lang="ts">
import { computed } from 'vue';
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
</script>

<template>
  <div
    class="flex gap-3 border-b border-neutral-200 px-4 py-2 last:border-0"
    :class="rowAlignClass"
  >
    <span class="w-9 shrink-0 text-right text-[9px] font-semibold uppercase tracking-wide text-neutral-400">
      {{ label }}
    </span>
    <div class="flex-1">
      <DiffPatch
        v-if="(item.meta?.itemType === 'file_change' || item.meta?.itemType === 'turn_diff') && patch"
        :patch="patch"
      />
      <div
        v-else-if="item.meta?.itemType === 'command_execution' && commandExecution"
        class="space-y-2"
      >
        <div class="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1.5">
          <span class="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">command</span>
          <code class="min-w-0 flex-1 break-all font-mono text-[11px] text-neutral-800">{{ commandExecution.command }}</code>
          <span
            v-if="commandExecution.exit"
            class="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600"
          >exit {{ commandExecution.exit }}</span>
        </div>

        <div v-if="commandExecution.output" class="overflow-hidden rounded border border-neutral-200 bg-white">
          <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">output</div>
          <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ commandExecution.output }}</pre>
        </div>

        <div v-if="commandExecution.stdout" class="overflow-hidden rounded border border-neutral-200 bg-white">
          <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">stdout</div>
          <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ commandExecution.stdout }}</pre>
        </div>

        <div v-if="commandExecution.stderr" class="overflow-hidden rounded border border-rose-200 bg-white">
          <div class="border-b border-rose-200 bg-rose-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-rose-600">stderr</div>
          <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-rose-700">{{ commandExecution.stderr }}</pre>
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
