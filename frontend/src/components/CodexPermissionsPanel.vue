<script setup lang="ts">
import { ref, watch } from 'vue';
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
    class="bg-teal-50"
    :class="embedded ? 'border-t border-neutral-200 px-4 py-3' : 'shrink-0 border-b border-teal-200 px-5 py-3'"
  >
    <div class="rounded-xl border border-teal-200 bg-white p-3">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-teal-600">Permissions Request</p>
      <p class="mt-1 text-sm font-medium text-neutral-900">
        {{ pendingPermissionsRequest.reason || 'Codex requests additional permissions for this turn.' }}
      </p>

      <div v-if="pendingPermissionsRequest.requestedWriteRoots.length" class="mt-3 overflow-hidden rounded border border-neutral-200 bg-white">
        <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">write roots</div>
        <div class="space-y-2 px-2 py-2">
          <label
            v-for="root in pendingPermissionsRequest.requestedWriteRoots"
            :key="root"
            class="flex items-start gap-2 text-[12px] text-neutral-700"
          >
            <input
              v-model="selectedWriteRoots"
              type="checkbox"
              :value="root"
              class="mt-0.5"
            >
            <span class="break-all">{{ root }}</span>
          </label>
        </div>
      </div>

      <div class="mt-3 overflow-hidden rounded border border-neutral-200 bg-white">
        <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">requested permissions</div>
        <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ JSON.stringify(pendingPermissionsRequest.permissions, null, 2) }}</pre>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
          @click="emit('resolve', { action: 'grant', scope: 'turn', grantedWriteRoots: [...selectedWriteRoots] })"
        >
          Grant For Turn
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
          @click="emit('resolve', { action: 'grant', scope: 'session', grantedWriteRoots: [...selectedWriteRoots] })"
        >
          Grant For Session
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50"
          @click="emit('resolve', { action: 'decline' })"
        >
          Decline
        </button>
      </div>
    </div>
  </div>
</template>
