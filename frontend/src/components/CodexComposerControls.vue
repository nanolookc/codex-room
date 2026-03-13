<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { ChevronDown, ChevronUp, Play, Square, Loader2, Send, ShieldAlert, ShieldCheck } from 'lucide-vue-next';
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
  <div class="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2.5">
    <!-- Left controls -->
    <div class="flex min-w-0 flex-wrap items-center gap-0 text-xs text-zinc-600">

      <!-- Model picker -->
      <div ref="modelMenuEl" class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          @click="toggleMenu('model')"
        >
          <span class="truncate">{{ selectedModelButtonLabel }}</span>
          <ChevronUp v-if="openMenu === 'model'" class="size-3 text-zinc-400" />
          <ChevronDown v-else class="size-3 text-zinc-400" />
        </button>
        <div
          v-if="openMenu === 'model'"
          class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 min-w-64 max-w-88 overflow-hidden rounded-xl border border-zinc-200 bg-white"
        >
          <button
            v-for="option in modelOptions"
            :key="option.id"
            type="button"
            class="flex w-full items-start border-b border-zinc-100 px-3.5 py-2.5 text-left last:border-0 hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none transition-colors"
            :class="selectedModel === option.id ? 'bg-zinc-50' : ''"
            @click="selectModel(option.id)"
          >
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-3">
                <span class="block truncate text-[13px] font-medium text-zinc-800">{{ option.label }}</span>
                <span v-if="selectedModel === option.id" class="shrink-0 rounded-full bg-zinc-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">active</span>
              </span>
              <span v-if="option.description" class="mt-0.5 block text-[11px] leading-4 text-zinc-400">
                {{ option.description }}
              </span>
            </span>
          </button>
        </div>
      </div>

      <span class="mx-2 h-3.5 w-px bg-zinc-200"></span>

      <!-- Effort picker -->
      <div ref="effortMenuEl" class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          @click="toggleMenu('effort')"
        >
          <span class="truncate">{{ selectedEffortLabel }}</span>
          <ChevronUp v-if="openMenu === 'effort'" class="size-3 text-zinc-400" />
          <ChevronDown v-else class="size-3 text-zinc-400" />
        </button>
        <div
          v-if="openMenu === 'effort'"
          class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 min-w-56 max-w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white"
        >
          <button
            v-for="option in effortOptions"
            :key="option.id"
            type="button"
            class="flex w-full items-start border-b border-zinc-100 px-3.5 py-2.5 text-left last:border-0 hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none transition-colors"
            :class="selectedEffort === option.id ? 'bg-zinc-50' : ''"
            @click="selectEffort(option.id)"
          >
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-3">
                <span class="block truncate text-[13px] font-medium text-zinc-800">{{ option.label }}</span>
                <span v-if="selectedEffort === option.id" class="shrink-0 rounded-full bg-zinc-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">active</span>
              </span>
              <span v-if="option.description" class="mt-0.5 block text-[11px] leading-4 text-zinc-400">
                {{ option.description }}
              </span>
            </span>
          </button>
        </div>
      </div>

      <span class="mx-2 h-3.5 w-px bg-zinc-200"></span>

      <!-- Access mode picker -->
      <div ref="accessMenuEl" class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          :class="accessMode === 'full-access' ? 'text-emerald-600 hover:text-emerald-700' : 'text-amber-600 hover:text-amber-700'"
          @click="toggleMenu('access')"
        >
          <ShieldCheck v-if="accessMode === 'full-access'" class="size-3.5" />
          <ShieldAlert v-else class="size-3.5" />
          <span class="truncate">{{ selectedAccessLabel }}</span>
          <ChevronUp v-if="openMenu === 'access'" class="size-3 text-zinc-400" />
          <ChevronDown v-else class="size-3 text-zinc-400" />
        </button>
        <div
          v-if="openMenu === 'access'"
          class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 min-w-[11rem] overflow-hidden rounded-xl border border-zinc-200 bg-white"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2.5 border-b border-zinc-100 px-3.5 py-2.5 text-left text-[13px] hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none transition-colors"
            :class="accessMode === 'full-access' ? 'bg-zinc-50' : ''"
            @click="selectAccess('full-access')"
          >
            <ShieldCheck class="size-4 text-emerald-500" />
            <span class="flex-1 font-medium text-zinc-800">Full Access</span>
            <span v-if="accessMode === 'full-access'" class="rounded-full bg-zinc-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">active</span>
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none transition-colors"
            :class="accessMode === 'need-approve' ? 'bg-zinc-50' : ''"
            @click="selectAccess('need-approve')"
          >
            <ShieldAlert class="size-4 text-amber-500" />
            <span class="flex-1 font-medium text-zinc-800">Ask first</span>
            <span v-if="accessMode === 'need-approve'" class="rounded-full bg-zinc-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">active</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Right controls -->
    <div class="ml-auto flex items-center gap-2">
      <!-- Context availability -->
      <span
        class="text-[11px] text-zinc-400"
        :title="contextAvailabilityTitle"
      >
        {{ contextAvailabilityText }}
      </span>

      <!-- Stop button -->
      <button
        v-if="running"
        :disabled="!canInterrupt"
        class="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-all hover:bg-zinc-50 hover:border-zinc-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-30 active:scale-95"
        @click="emit('interrupt')"
      >
        <Square class="size-3 fill-zinc-600 text-zinc-600" />
        Stop
      </button>

      <!-- Run / Steer button -->
      <button
        :disabled="!canSubmit"
        class="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white transition-all hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-25 active:scale-95"
        @click="emit('submit')"
      >
        <Loader2 v-if="running" class="size-3 animate-spin" />
        <Send v-else class="size-3" />
        {{ running ? 'Send' : 'Run' }}
      </button>
    </div>
  </div>
</template>
