<script setup lang="ts">
import { ShieldAlert, Terminal, FileText, CheckCircle, XCircle, Clock } from 'lucide-vue-next';
import DiffPatch from './DiffPatch.vue';
import { approvalDecisionLabel, type PendingApproval } from '../lib/codexAppUi';
import type { ApprovalDecision } from '../lib/codexProtocol';

defineProps<{
  pendingApproval: PendingApproval;
  embedded?: boolean;
}>();

const emit = defineEmits<{
  (e: 'resolve', decision: ApprovalDecision): void;
}>();

function decisionVariant(decision: ApprovalDecision): string {
  if (decision === 'accept') return 'approve-once';
  if (decision === 'acceptForSession') return 'approve-session';
  if (decision === 'decline' || decision === 'cancel') return 'deny';
  return 'neutral';
}
</script>

<template>
  <div
    :class="embedded ? 'border-t border-zinc-200 bg-amber-50/60 px-4 py-3' : 'shrink-0 border-b border-amber-200 bg-amber-50/60 px-5 py-3'"
  >
    <div class="rounded-xl border border-amber-200 bg-white overflow-hidden">
      <!-- Header -->
      <div class="flex items-center gap-2.5 border-b border-amber-100 bg-amber-50 px-4 py-2.5">
        <ShieldAlert class="size-4 shrink-0 text-amber-500" />
        <span class="text-[11px] font-semibold uppercase tracking-widest text-amber-600">Action requires approval</span>
      </div>

      <div class="p-3.5 space-y-3">
        <!-- Title + reason -->
        <div>
          <p class="text-[13px] font-semibold text-zinc-900">{{ pendingApproval.title }}</p>
          <p v-if="pendingApproval.reason" class="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-500">{{ pendingApproval.reason }}</p>
        </div>

        <!-- Command block -->
        <div v-if="pendingApproval.command" class="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
            <Terminal class="size-3 text-zinc-400" />
            <span class="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">command</span>
          </div>
          <pre class="m-0 whitespace-pre-wrap px-3 py-2.5 font-mono text-[12px] leading-relaxed text-emerald-400">{{ pendingApproval.command }}</pre>
        </div>

        <!-- Files block -->
        <div v-if="pendingApproval.files && pendingApproval.files.length" class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div class="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-1.5">
            <FileText class="size-3 text-zinc-400" />
            <span class="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">files</span>
          </div>
          <div class="px-3 py-2 space-y-1">
            <div v-for="file in pendingApproval.files" :key="file" class="font-mono text-[12px] text-zinc-700">{{ file }}</div>
          </div>
        </div>

        <!-- Diff block -->
        <div v-if="pendingApproval.patch" class="overflow-hidden rounded-lg border border-zinc-200">
          <DiffPatch :patch="pendingApproval.patch" />
        </div>

        <!-- Action buttons -->
        <div class="flex flex-wrap gap-2 pt-0.5">
          <button
            v-for="decision in pendingApproval.decisions"
            :key="decision"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 active:scale-95"
            :class="{
              'border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus-visible:outline-emerald-500': decisionVariant(decision) === 'approve-once',
              'border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 focus-visible:outline-blue-500': decisionVariant(decision) === 'approve-session',
              'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 focus-visible:outline-rose-500': decisionVariant(decision) === 'deny',
              'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50': decisionVariant(decision) === 'neutral',
            }"
            @click="emit('resolve', decision)"
          >
            <CheckCircle v-if="decisionVariant(decision) === 'approve-once'" class="size-3.5" />
            <Clock v-else-if="decisionVariant(decision) === 'approve-session'" class="size-3.5" />
            <XCircle v-else-if="decisionVariant(decision) === 'deny'" class="size-3.5" />
            {{ approvalDecisionLabel(decision) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
