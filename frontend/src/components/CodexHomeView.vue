<script setup lang="ts">
import { MessageSquarePlus, Clock, Zap, Globe, TerminalSquare, Github } from 'lucide-vue-next';
import { formatThreadTime, type CodexThreadSummary } from '../lib/codexAppUi';

defineProps<{
  codexThreads: CodexThreadSummary[];
  publicLanding: boolean;
  repoUrl: string;
  startCommand: string;
}>();

const emit = defineEmits<{
  (e: 'open-new-room'): void;
  (e: 'open-thread', threadId: string): void;
}>();
</script>

<template>
  <section class="flex-1 overflow-y-auto">
    <div class="px-4 py-4">
      <div v-if="publicLanding" class="mx-auto flex max-w-[640px] flex-col gap-4 py-10">
        <div class="rounded-[28px] border border-zinc-200 bg-gradient-to-br from-white via-zinc-50 to-zinc-100 p-6 shadow-sm">
          <div class="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
            <Globe class="size-3.5" />
            Public Relay
          </div>
          <h1 class="text-[28px] font-semibold tracking-tight text-zinc-950">Run Codex Room locally and share it from your own machine.</h1>
          <p class="mt-3 max-w-[52ch] text-[14px] leading-6 text-zinc-600">
            This host only relays published rooms. Start a local room with the CLI, then send the generated invite URL to another person.
          </p>
          <div class="mt-6 grid gap-3">
            <a
              :href="repoUrl"
              target="_blank"
              rel="noreferrer"
              class="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-[13px] font-medium text-zinc-800 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
            >
              <Github class="size-4" />
              Open GitHub repo
            </a>
            <div class="rounded-2xl bg-zinc-950 p-4 text-left text-zinc-100 shadow-sm">
              <div class="mb-2 inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-zinc-400">
                <TerminalSquare class="size-3.5" />
                Start From Repo Root
              </div>
              <code class="block overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-6 text-zinc-100">{{ startCommand }}</code>
            </div>
          </div>
        </div>
      </div>

      <template v-else>
      <!-- Header row -->
      <div class="mb-4 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">Sessions</span>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 active:scale-95"
          @click="emit('open-new-room')"
        >
          <MessageSquarePlus class="size-3.5" />
          New chat
        </button>
      </div>

      <!-- Thread list -->
      <div class="space-y-1.5">
        <button
          v-for="thread in codexThreads"
          :key="thread.id"
          type="button"
          class="group flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-left transition-all hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-900 active:scale-[0.99]"
          @click="emit('open-thread', thread.id)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-medium text-zinc-800">
              {{ thread.preview || thread.id }}
            </span>
            <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
              <Clock class="size-3 shrink-0" />
              {{ formatThreadTime(thread.updatedAt ?? thread.createdAt) }}
            </span>
          </span>
          <svg class="size-4 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <!-- Empty state -->
        <div v-if="codexThreads.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
          <div class="mb-4 flex size-14 items-center justify-center rounded-2xl bg-zinc-100">
            <Zap class="size-7 text-zinc-400" />
          </div>
          <p class="text-[14px] font-medium text-zinc-700">No sessions yet</p>
          <p class="mt-1 text-[12px] text-zinc-400">Start a new chat to get going</p>
          <button
            type="button"
            class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-medium text-white transition-all hover:bg-zinc-700 active:scale-95"
            @click="emit('open-new-room')"
          >
            <MessageSquarePlus class="size-3.5" />
            New chat
          </button>
        </div>
      </div>
      </template>
    </div>
  </section>
</template>
