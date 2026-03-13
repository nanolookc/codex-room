<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { AccessMode } from '../lib/codexProtocol';
import type { EffortOption, ModelOption } from '../lib/codexAppUi';

type MenuName = 'model' | 'effort' | 'access';

const props = defineProps<{
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
}>();

const emit = defineEmits<{
  (e: 'select-model', optionId: string): void;
  (e: 'select-effort', optionId: string): void;
  (e: 'select-access', mode: AccessMode): void;
  (e: 'interrupt'): void;
  (e: 'submit'): void;
}>();

const openMenu = ref<MenuName | null>(null);
const modelMenuEl = ref<HTMLElement | null>(null);
const effortMenuEl = ref<HTMLElement | null>(null);
const accessMenuEl = ref<HTMLElement | null>(null);

function toggleMenu(menu: MenuName) {
  openMenu.value = openMenu.value === menu ? null : menu;
}

function closeMenus() {
  openMenu.value = null;
}

function onWindowPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (modelMenuEl.value?.contains(target)) return;
  if (effortMenuEl.value?.contains(target)) return;
  if (accessMenuEl.value?.contains(target)) return;
  closeMenus();
}

function selectModel(optionId: string) {
  emit('select-model', optionId);
  closeMenus();
}

function selectEffort(optionId: string) {
  emit('select-effort', optionId);
  closeMenus();
}

function selectAccess(mode: AccessMode) {
  emit('select-access', mode);
  closeMenus();
}

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown);
});

onUnmounted(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown);
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3">
    <div class="flex min-w-0 flex-wrap items-center gap-0 text-xs text-neutral-600">
      <div ref="modelMenuEl" class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 py-1 text-left text-xs text-neutral-700 transition-colors hover:text-neutral-950"
          @click="toggleMenu('model')"
        >
          <span class="truncate">{{ selectedModelButtonLabel }}</span>
          <span class="text-[10px] text-neutral-400">{{ openMenu === 'model' ? '▴' : '▾' }}</span>
        </button>
        <div
          v-if="openMenu === 'model'"
          class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 min-w-60 max-w-88 overflow-hidden rounded-md border border-neutral-200 bg-white"
        >
          <button
            v-for="option in modelOptions"
            :key="option.id"
            type="button"
            class="flex w-full items-start border-b border-neutral-100 px-3 py-2 text-left text-[12px] text-neutral-700 last:border-0 hover:bg-neutral-50"
            @click="selectModel(option.id)"
          >
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-3">
                <span class="block truncate">{{ option.label }}</span>
                <span v-if="selectedModel === option.id" class="shrink-0 text-[10px] text-neutral-400">current</span>
              </span>
              <span v-if="option.description" class="mt-0.5 block text-[11px] leading-4 text-neutral-400">
                {{ option.description }}
              </span>
            </span>
          </button>
        </div>
      </div>

      <span class="mx-3 h-4 w-px bg-neutral-200"></span>

      <div ref="effortMenuEl" class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 py-1 text-left text-xs text-neutral-700 transition-colors hover:text-neutral-950"
          @click="toggleMenu('effort')"
        >
          <span class="truncate">{{ selectedEffortLabel }}</span>
          <span class="text-[10px] text-neutral-400">{{ openMenu === 'effort' ? '▴' : '▾' }}</span>
        </button>
        <div
          v-if="openMenu === 'effort'"
          class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 min-w-56 max-w-64 overflow-hidden rounded-md border border-neutral-200 bg-white"
        >
          <button
            v-for="option in effortOptions"
            :key="option.id"
            type="button"
            class="flex w-full items-start border-b border-neutral-100 px-3 py-2 text-left text-[12px] text-neutral-700 last:border-0 hover:bg-neutral-50"
            @click="selectEffort(option.id)"
          >
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-3">
                <span class="block truncate">{{ option.label }}</span>
                <span v-if="selectedEffort === option.id" class="shrink-0 text-[10px] text-neutral-400">current</span>
              </span>
              <span v-if="option.description" class="mt-0.5 block text-[11px] leading-4 text-neutral-400">
                {{ option.description }}
              </span>
            </span>
          </button>
        </div>
      </div>

      <span class="mx-3 h-4 w-px bg-neutral-200"></span>

      <div ref="accessMenuEl" class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 py-1 text-left text-xs text-neutral-700 transition-colors hover:text-neutral-950"
          @click="toggleMenu('access')"
        >
          <span class="truncate">{{ selectedAccessLabel }}</span>
          <span class="text-[10px] text-neutral-400">{{ openMenu === 'access' ? '▴' : '▾' }}</span>
        </button>
        <div
          v-if="openMenu === 'access'"
          class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 min-w-[10rem] overflow-hidden rounded-md border border-neutral-200 bg-white"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2 text-left text-[12px] text-neutral-700 hover:bg-neutral-50"
            @click="selectAccess('full-access')"
          >
            <span>Full Access</span>
            <span v-if="accessMode === 'full-access'" class="text-[10px] text-neutral-400">current</span>
          </button>
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] text-neutral-700 hover:bg-neutral-50"
            @click="selectAccess('need-approve')"
          >
            <span>Need Approve</span>
            <span v-if="accessMode === 'need-approve'" class="text-[10px] text-neutral-400">current</span>
          </button>
        </div>
      </div>
    </div>

    <div class="ml-auto flex items-center gap-2">
      <span class="text-[11px] text-neutral-400">
        <span :title="contextAvailabilityTitle">
          {{ contextAvailabilityText }}
        </span>
      </span>
      <button
        v-if="running"
        :disabled="!canInterrupt"
        class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30"
        @click="emit('interrupt')"
      >
        Stop
      </button>
      <button
        :disabled="!canSubmit"
        class="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
        @click="emit('submit')"
      >
        <span
          v-if="running"
          class="size-[10px] animate-spin rounded-full border-[1.5px] border-white/30 border-t-white"
        ></span>
        {{ running ? 'Steer' : 'Run' }}
      </button>
    </div>
  </div>
</template>
