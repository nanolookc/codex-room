<script setup lang="ts">
import { ref, watch } from 'vue';
import { KeyRound, FolderOpen, CheckCircle, XCircle, ShieldCheck } from 'lucide-vue-next';
import type {
  PendingPermissionsRequest,
  PermissionPromptOutcome
} from '../lib/codexAppUi';

const props = defineProps<{
  pendingPermissionsRequest: PendingPermissionsRequest;
  embedded?: boolean;
}>();

const emit = defineEmits<{
  (e: 'resolve', outcome: Exclude<PermissionPromptOutcome, 'cleared'>): void;
}>();

const selectedWriteRoots = ref<string[]>([]);

watch(
  () => props.pendingPermissionsRequest,
  (request) => {
    selectedWriteRoots.value = [...request.selectedWriteRoots];
  },
  { immediate: true }
);
</script>

<template>
  <div
    :class="embedded ? 'border-t border-zinc-200 bg-teal-50/60 px-4 py-3' : 'shrink-0 border-b border-teal-200 bg-teal-50/60 px-5 py-3'"
  >
    <div class="rounded-xl border border-teal-200 bg-white overflow-hidden">
      <!-- Header -->
      <div class="flex items-center gap-2.5 border-b border-teal-100 bg-teal-50 px-4 py-2.5">
        <KeyRound class="size-4 shrink-0 text-teal-500" />
        <span class="text-[11px] font-semibold uppercase tracking-widest text-teal-600">Permissions request</span>
      </div>

      <div class="p-3.5 space-y-3">
        <!-- Reason -->
        <p class="text-[13px] font-medium text-zinc-900">
          {{ pendingPermissionsRequest.reason || 'Agent is requesting additional permissions for this turn.' }}
        </p>

        <!-- Write roots checkboxes -->
        <div v-if="pendingPermissionsRequest.requestedWriteRoots.length" class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div class="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-1.5">
            <FolderOpen class="size-3 text-zinc-400" />
            <span class="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">write access</span>
          </div>
          <div class="space-y-0 divide-y divide-zinc-100">
            <label
              v-for="root in pendingPermissionsRequest.requestedWriteRoots"
              :key="root"
              class="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-[12px] text-zinc-700 transition-colors hover:bg-zinc-50"
            >
              <input
                v-model="selectedWriteRoots"
                type="checkbox"
                :value="root"
                class="h-4 w-4 rounded border-zinc-300 text-teal-600 focus:ring-teal-500"
              >
              <span class="break-all font-mono">{{ root }}</span>
            </label>
          </div>
        </div>

        <!-- Permissions JSON -->
        <div class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div class="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-1.5">
            <ShieldCheck class="size-3 text-zinc-400" />
            <span class="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">requested permissions</span>
          </div>
          <pre class="m-0 whitespace-pre-wrap px-3 py-2.5 font-mono text-[11px] leading-relaxed text-zinc-600">{{ JSON.stringify(pendingPermissionsRequest.permissions, null, 2) }}</pre>
        </div>

        <!-- Action buttons -->
        <div class="flex flex-wrap gap-2 pt-0.5">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-all hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-500 active:scale-95"
            @click="emit('resolve', { action: 'grant', scope: 'turn', grantedWriteRoots: [...selectedWriteRoots] })"
          >
            <CheckCircle class="size-3.5" />
            Grant for this turn
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition-all hover:bg-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 active:scale-95"
            @click="emit('resolve', { action: 'grant', scope: 'session', grantedWriteRoots: [...selectedWriteRoots] })"
          >
            <ShieldCheck class="size-3.5" />
            Grant for session
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition-all hover:bg-rose-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rose-500 active:scale-95"
            @click="emit('resolve', { action: 'decline' })"
          >
            <XCircle class="size-3.5" />
            Decline
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
