<script setup lang="ts">
import { ChevronLeft, Bug, AlertCircle, Cpu, LogOut } from 'lucide-vue-next';

const props = defineProps<{
  view: 'home' | 'chat';
  canLogout: boolean;
  running: boolean;
  roomId: string;
  shortRoomId: string;
  workingDirectory: string;
  debugCopyStatus: 'idle' | 'copied' | 'error';
  userName: string;
}>();

const emit = defineEmits<{
  (e: 'go-home'): void;
  (e: 'copy-debug'): void;
  (e: 'logout'): void;
}>();
</script>

<template>
  <header class="sticky top-0 z-10 shrink-0 border-b border-zinc-200 bg-white/90 backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-2.5">
      <div class="flex items-center gap-2.5">
        <button
          v-if="view === 'chat'"
          type="button"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          @click="emit('go-home')"
        >
          <ChevronLeft class="size-4" />
          Sessions
        </button>

        <div class="flex items-center gap-2">
          <span
            class="size-2 rounded-full transition-colors"
            :class="running ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'"
          ></span>
          <span class="text-[13px] font-semibold tracking-tight text-zinc-900">
            <span v-if="view === 'chat'" :title="roomId">{{ shortRoomId }}</span>
            <span v-else class="flex items-center gap-1.5">
              <Cpu class="size-4 text-zinc-400" />
              Agent
            </span>
          </span>
          <button
            v-if="view === 'chat'"
            type="button"
            class="inline-flex items-center justify-center rounded-lg p-1 transition-colors hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
            :class="debugCopyStatus === 'copied' ? 'text-emerald-500' : debugCopyStatus === 'error' ? 'text-red-500' : 'text-zinc-400 hover:text-zinc-600'"
            :title="debugCopyStatus === 'copied' ? 'Copied!' : debugCopyStatus === 'error' ? 'Copy failed' : 'Copy debug info'"
            aria-label="Copy debug info"
            @click="emit('copy-debug')"
          >
            <AlertCircle v-if="debugCopyStatus === 'error'" class="size-3.5" />
            <Bug v-else class="size-3.5" />
          </button>
          <span
            v-if="workingDirectory && view === 'chat'"
            class="max-w-[320px] truncate rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500"
            :title="workingDirectory"
          >
            {{ workingDirectory }}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
          v-if="canLogout"
          type="button"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          @click="emit('logout')"
        >
          <LogOut class="size-4" />
          Exit
        </button>
        <span class="max-w-[160px] truncate rounded-md bg-zinc-100 px-2.5 py-0.5 text-[11px] text-zinc-500" :title="userName">
          {{ userName }}
        </span>
      </div>
    </div>
  </header>
</template>
