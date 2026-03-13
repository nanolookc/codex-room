<script setup lang="ts">
const props = defineProps<{
  view: 'home' | 'chat';
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
}>();
</script>

<template>
  <header class="sticky top-0 z-10 shrink-0 border-b border-neutral-200 bg-white/90 backdrop-blur-sm">
    <div class="flex items-center justify-between px-5 py-3">
      <div class="flex items-center gap-2">
        <button
          v-if="view === 'chat'"
          type="button"
          class="rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
          @click="emit('go-home')"
        >
          ← Chats
        </button>
        <span
          class="size-[7px] rounded-full transition-colors"
          :class="running ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'"
        ></span>
        <span class="text-[13px] font-medium tracking-tight text-neutral-900">
          <span v-if="view === 'chat'" :title="roomId">{{ shortRoomId }}</span>
          <span v-else>Rooms</span>
        </span>
        <span
          v-if="workingDirectory && view === 'chat'"
          class="max-w-[360px] truncate text-[11px] text-neutral-400"
          :title="workingDirectory"
        >
          {{ workingDirectory }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="view === 'chat'"
          type="button"
          class="inline-flex size-6 items-center justify-center rounded-md border border-neutral-200 text-[12px] text-neutral-600 hover:bg-neutral-100"
          :title="debugCopyStatus === 'copied' ? 'Copied debug info' : debugCopyStatus === 'error' ? 'Copy debug failed' : 'Copy debug info'"
          aria-label="Copy debug info"
          @click="emit('copy-debug')"
        >
          {{ debugCopyStatus === 'copied' ? '✓' : debugCopyStatus === 'error' ? '!' : '⧉' }}
        </button>
        <span class="max-w-[180px] truncate text-xs text-neutral-400" :title="userName">{{ userName }}</span>
      </div>
    </div>
  </header>
</template>
