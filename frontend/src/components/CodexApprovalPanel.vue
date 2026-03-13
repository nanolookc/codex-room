<script setup lang="ts">
import DiffPatch from './DiffPatch.vue';
import { approvalDecisionLabel, type PendingApproval } from '../lib/codexAppUi';
import type { ApprovalDecision } from '../lib/codexProtocol';

defineProps<{
  pendingApproval: PendingApproval;
}>();

const emit = defineEmits<{
  (e: 'resolve', decision: ApprovalDecision): void;
}>();
</script>

<template>
  <section class="shrink-0 border-b border-orange-200 bg-orange-50 px-5 py-3">
    <div class="rounded-xl border border-orange-200 bg-white p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-orange-500">Approval Needed</p>
          <p class="mt-1 text-sm font-medium text-neutral-900">{{ pendingApproval.title }}</p>
          <p v-if="pendingApproval.reason" class="mt-1 whitespace-pre-wrap text-[12px] text-neutral-600">{{ pendingApproval.reason }}</p>
        </div>
      </div>

      <div v-if="pendingApproval.command" class="mt-3 overflow-hidden rounded border border-neutral-200 bg-white">
        <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">command</div>
        <pre class="m-0 whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700">{{ pendingApproval.command }}</pre>
      </div>

      <div v-if="pendingApproval.files && pendingApproval.files.length" class="mt-3 overflow-hidden rounded border border-neutral-200 bg-white">
        <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">files</div>
        <div class="px-2 py-1.5 text-[11px] leading-relaxed text-neutral-700">
          <div v-for="file in pendingApproval.files" :key="file">{{ file }}</div>
        </div>
      </div>

      <div v-if="pendingApproval.patch" class="mt-3 overflow-hidden rounded border border-neutral-200 bg-white">
        <DiffPatch :patch="pendingApproval.patch" />
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <button
          v-for="decision in pendingApproval.decisions"
          :key="decision"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
          @click="emit('resolve', decision)"
        >
          {{ approvalDecisionLabel(decision) }}
        </button>
      </div>
    </div>
  </section>
</template>
