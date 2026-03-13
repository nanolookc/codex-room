<script setup lang="ts">
import type { AccessMode } from '../lib/codexProtocol';
import type {
  CursorOverlay,
  EffortOption,
  ModelOption
} from '../lib/codexAppUi';
import CodexComposerControls from './CodexComposerControls.vue';

const props = defineProps<{
  modelValue: string;
  cursorOverlays: CursorOverlay[];
  modelOptions: ModelOption[];
  selectedModel: string;
  selectedModelButtonLabel: string;
  effortOptions: EffortOption[];
  selectedEffort: string;
  selectedEffortLabel: string;
  accessMode: AccessMode;
  selectedAccessLabel: string;
  contextAvailabilityText: string;
  contextAvailabilityTitle: string;
  running: boolean;
  canInterrupt: boolean;
  canSubmit: boolean;
  setTextareaEl: (el: Element | null) => void;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'editor-keydown', event: KeyboardEvent): void;
  (e: 'editor-selection-change'): void;
  (e: 'editor-scroll'): void;
  (e: 'select-model', optionId: string): void;
  (e: 'select-effort', optionId: string): void;
  (e: 'select-access', mode: AccessMode): void;
  (e: 'interrupt'): void;
  (e: 'submit'): void;
}>();
</script>

<template>
  <footer class="shrink-0 border-t border-zinc-200 bg-white/95 backdrop-blur-sm">
    <div class="px-4 py-3.5">
      <div class="rounded-2xl border border-zinc-300 bg-white px-3.5 py-3 transition-colors focus-within:border-zinc-400">
        <div class="relative">
          <textarea
            :ref="setTextareaEl"
            :value="modelValue"
            rows="4"
            class="w-full resize-none border-0 bg-transparent px-0 pb-2 pt-0 font-sans text-sm text-zinc-900 outline-none placeholder:text-zinc-300"
            placeholder="Ask anything… (⌘↵ to run)"
            @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
            @keydown="emit('editor-keydown', $event)"
            @click="emit('editor-selection-change')"
            @keyup="emit('editor-selection-change')"
            @select="emit('editor-selection-change')"
            @scroll="emit('editor-scroll')"
          />
          <div class="pointer-events-none absolute inset-0 z-10 overflow-visible rounded-xl">
            <div
              v-for="cursor in cursorOverlays"
              :key="cursor.userId"
              class="absolute"
              :style="{ left: `${cursor.left}px`, top: `${cursor.top}px` }"
            >
              <span
                class="absolute left-0 top-0 w-0.5 rounded-full"
                :style="{ height: `${cursor.height}px`, backgroundColor: cursor.color }"
              ></span>
              <span
                class="absolute left-1 top-0 -translate-y-full whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                :style="{ backgroundColor: cursor.color }"
              >
                {{ cursor.userName }}
              </span>
            </div>
          </div>
        </div>
        <CodexComposerControls
          :model-options="modelOptions"
          :selected-model="selectedModel"
          :selected-model-button-label="selectedModelButtonLabel"
          :effort-options="effortOptions"
          :selected-effort="selectedEffort"
          :selected-effort-label="selectedEffortLabel"
          :access-mode="accessMode"
          :selected-access-label="selectedAccessLabel"
          :context-availability-text="contextAvailabilityText"
          :context-availability-title="contextAvailabilityTitle"
          :running="running"
          :can-interrupt="canInterrupt"
          :can-submit="canSubmit"
          @select-model="emit('select-model', $event)"
          @select-effort="emit('select-effort', $event)"
          @select-access="emit('select-access', $event)"
          @interrupt="emit('interrupt')"
          @submit="emit('submit')"
        />
      </div>
    </div>
  </footer>
</template>
