<script setup lang="ts">
defineProps<{
  apiError: string;
  hasConflictedDraft: boolean;
}>();

const emit = defineEmits<{
  (e: 'restore-draft'): void;
}>();
</script>

<template>
  <div class="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12px] text-amber-800">
    <div class="flex items-center justify-between gap-3">
      <span>{{ apiError }}</span>
      <button
        v-if="hasConflictedDraft"
        type="button"
        class="shrink-0 rounded-md border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
        @click="emit('restore-draft')"
      >
        Restore draft
      </button>
    </div>
  </div>
</template>
