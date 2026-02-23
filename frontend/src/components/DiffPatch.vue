<script setup lang="ts">
import { computed } from 'vue';
import { parseUnifiedPatch, type UnifiedPatchRow } from '../lib/unifiedPatch';

const props = defineProps<{
  patch: string;
}>();

const rows = computed(() => parseUnifiedPatch(typeof props.patch === 'string' ? props.patch : ''));

function rowClass(row: UnifiedPatchRow): string {
  switch (row.kind) {
    case 'add':
      return 'bg-emerald-50/70 text-emerald-900';
    case 'del':
      return 'bg-rose-50/70 text-rose-900';
    case 'context':
      return 'bg-white text-neutral-700';
    case 'hunk':
      return 'bg-sky-50 text-sky-900';
    case 'fileOld':
      return 'bg-rose-100/70 text-rose-950';
    case 'fileNew':
      return 'bg-emerald-100/70 text-emerald-950';
    case 'note':
      return 'bg-amber-50 text-amber-900 italic';
    default:
      return 'bg-neutral-50 text-neutral-700';
  }
}

function cellClass(row: UnifiedPatchRow): string {
  if (row.kind === 'add') return 'bg-emerald-100/60 text-emerald-900';
  if (row.kind === 'del') return 'bg-rose-100/60 text-rose-900';
  if (row.kind === 'hunk') return 'bg-sky-100/70 text-sky-900';
  return 'bg-neutral-50 text-neutral-500';
}

function lineNo(value: number | null): string {
  return value == null ? '' : String(value);
}
</script>

<template>
  <div class="w-full overflow-x-auto rounded-md border border-neutral-200 bg-white">
    <div v-if="rows.length === 0" class="p-2 font-mono text-[11px] text-neutral-500">
      No diff
    </div>

    <div v-else class="min-w-full font-mono text-[11px] leading-5">
      <div
        v-for="row in rows"
        :key="row.id"
        class="grid grid-cols-[minmax(1.75rem,max-content)_minmax(1.75rem,max-content)_minmax(0,1fr)] border-b border-neutral-100 last:border-b-0"
      >
        <div
          class="min-w-7 select-none border-r border-neutral-100 px-1 text-right tabular-nums"
          :class="cellClass(row)"
        >
          {{ lineNo(row.oldLine) }}
        </div>
        <div
          class="min-w-7 select-none border-r border-neutral-100 px-1 text-right tabular-nums"
          :class="cellClass(row)"
        >
          {{ lineNo(row.newLine) }}
        </div>
        <pre class="m-0 overflow-x-auto px-2 whitespace-pre-wrap break-words" :class="rowClass(row)">{{ row.text }}</pre>
      </div>
    </div>
  </div>
</template>
