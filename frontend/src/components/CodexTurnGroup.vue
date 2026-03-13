<script setup lang="ts">
import { ChevronRight, ChevronDown } from 'lucide-vue-next';
import CodexApprovalPanel from './CodexApprovalPanel.vue';
import CodexPermissionsPanel from './CodexPermissionsPanel.vue';
import CodexTechItem from './CodexTechItem.vue';
import type { CodexLogEntry } from '../lib/codexTimeline';
import type {
  PendingApproval,
  PendingPermissionsRequest,
  PermissionPromptOutcome
} from '../lib/codexAppUi';
import type { ApprovalDecision } from '../lib/codexProtocol';

type TurnGroup = {
  id: string;
  startEntry: CodexLogEntry;
  items: CodexLogEntry[];
  endEntry?: CodexLogEntry;
};

type TurnSegment =
  | { type: 'message'; id: string; entry: CodexLogEntry }
  | { type: 'plan_state'; id: string; text: string }
  | { type: 'tech'; id: string; items: CodexLogEntry[] };

const props = defineProps<{
  group: TurnGroup;
  segments: TurnSegment[];
  allEntries: CodexLogEntry[];
  turnPrompt: string;
  turnMeta: string;
  turnMetaTitle: string;
  turnStatusClass: string;
  renderMarkdown: (text: string) => string;
  shouldCollapseTechSegment: (items: CodexLogEntry[]) => boolean;
  isExpanded: (id: string, items: CodexLogEntry[]) => boolean;
  toggleExpanded: (id: string, items: CodexLogEntry[]) => void;
  techSegmentSummary: (items: CodexLogEntry[]) => string;
  itemLabel: (item: CodexLogEntry) => string;
  itemBody: (item: CodexLogEntry) => string;
  itemTextClass: (item: CodexLogEntry) => string;
  itemRowAlignClass: (item: CodexLogEntry) => string;
  pendingApproval?: PendingApproval | null;
  pendingPermissionsRequest?: PendingPermissionsRequest | null;
}>();

const emit = defineEmits<{
  (e: 'resolve-approval', decision: ApprovalDecision): void;
  (e: 'resolve-permissions', outcome: Exclude<PermissionPromptOutcome, 'cleared'>): void;
}>();
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-zinc-200 bg-white">
    <!-- Turn header -->
    <div class="flex items-center gap-2.5 border-b border-zinc-100 px-4 py-2.5">
      <span class="size-1.5 shrink-0 rounded-full" :class="turnStatusClass"></span>
      <span class="flex-1 truncate text-[12.5px] font-medium text-zinc-700">{{ turnPrompt }}</span>
      <span
        class="shrink-0 cursor-help text-[11px] text-zinc-400 transition-colors hover:text-zinc-600"
        :title="turnMetaTitle"
      >{{ turnMeta }}</span>
    </div>

    <div class="divide-y divide-zinc-100">
      <template v-for="seg in segments" :key="seg.id">
        <!-- Agent message -->
        <div v-if="seg.type === 'message'" class="px-4 py-3.5">
          <div
            class="markdown-body text-sm leading-relaxed text-zinc-900"
            v-html="renderMarkdown(itemBody(seg.entry))"
          ></div>
        </div>

        <!-- Plan state -->
        <div v-else-if="seg.type === 'plan_state'" class="bg-amber-50/60 px-4 py-3">
          <div class="flex items-start gap-3">
            <span class="mt-0.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-amber-600">
              plan
            </span>
            <pre class="m-0 whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-600">{{ seg.text }}</pre>
          </div>
        </div>

        <!-- Tech segment -->
        <div v-else>
          <!-- Not collapsed (few items) -->
          <div v-if="!shouldCollapseTechSegment(seg.items)" class="bg-zinc-50/80">
            <CodexTechItem
              v-for="item in seg.items"
              :key="item.id"
              :item="item"
              :all-entries="allEntries"
              :label="itemLabel(item)"
              :body="itemBody(item)"
              :text-class="itemTextClass(item)"
              :row-align-class="itemRowAlignClass(item)"
            />
          </div>

          <!-- Collapsible -->
          <template v-else>
            <button
              class="flex w-full items-center gap-2 bg-zinc-50/80 px-4 py-2 text-left transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none"
              @click="toggleExpanded(seg.id, seg.items)"
            >
              <ChevronDown v-if="isExpanded(seg.id, seg.items)" class="size-3.5 shrink-0 text-zinc-400" />
              <ChevronRight v-else class="size-3.5 shrink-0 text-zinc-400" />
              <span class="text-[11px] font-medium text-zinc-500">
                {{ isExpanded(seg.id, seg.items) ? `${seg.items.length} step${seg.items.length > 1 ? 's' : ''}` : `${seg.items.length} step${seg.items.length > 1 ? 's' : ''}` }}
              </span>
              <span
                v-if="!isExpanded(seg.id, seg.items)"
                class="min-w-0 truncate text-[11px] text-zinc-400"
              >
                · {{ techSegmentSummary(seg.items) }}
              </span>
            </button>

            <div v-if="isExpanded(seg.id, seg.items)" class="border-t border-zinc-100 bg-zinc-50/80">
              <CodexTechItem
                v-for="item in seg.items"
                :key="item.id"
                :item="item"
                :all-entries="allEntries"
                :label="itemLabel(item)"
                :body="itemBody(item)"
                :text-class="itemTextClass(item)"
                :row-align-class="itemRowAlignClass(item)"
              />
            </div>
          </template>
        </div>
      </template>
    </div>

    <CodexApprovalPanel
      v-if="pendingApproval"
      embedded
      :pending-approval="pendingApproval"
      @resolve="emit('resolve-approval', $event)"
    />

    <CodexPermissionsPanel
      v-if="pendingPermissionsRequest"
      embedded
      :pending-permissions-request="pendingPermissionsRequest"
      @resolve="emit('resolve-permissions', $event)"
    />
  </div>
</template>
