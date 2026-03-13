<script setup lang="ts">
import { formatThreadTime, type CodexThreadSummary } from '../lib/codexAppUi';

defineProps<{
  codexThreads: CodexThreadSummary[];
}>();

const emit = defineEmits<{
  (e: 'open-new-room'): void;
  (e: 'open-thread', threadId: string): void;
}>();
</script>

<template>
  <section class="flex-1 overflow-y-auto">
    <div class="space-y-3 px-5 py-5">
      <div class="rounded-xl border border-neutral-200 bg-white p-3">
        <button
          type="button"
          class="rounded-lg bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:opacity-80"
          @click="emit('open-new-room')"
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
          @click="emit('open-thread', thread.id)"
        >
          <span class="min-w-0">
            <span class="block truncate text-[13px] text-neutral-800">{{ thread.preview || thread.id }}</span>
            <span class="flex items-center gap-2 text-[11px] text-neutral-400">
              <span class="truncate">{{ thread.id }}</span>
              <span
                v-if="thread.source"
                class="shrink-0 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 uppercase tracking-wide text-[10px] text-neutral-500"
              >
                {{ thread.source }}
              </span>
            </span>
          </span>
          <span class="ml-3 shrink-0 text-[11px] text-neutral-400">
            {{ formatThreadTime(thread.updatedAt ?? thread.createdAt) }}
          </span>
        </button>
        <p v-if="codexThreads.length === 0" class="text-sm text-neutral-400">No Codex sessions found.</p>
      </div>
    </div>
  </section>
</template>
