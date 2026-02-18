<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { FileDiff, parsePatchFiles } from '@pierre/diffs';

const props = defineProps<{
  patch: string;
}>();

const hostEl = ref<HTMLDivElement | null>(null);
let instance: FileDiff | null = null;

function sanitizePatch(raw: string): string {
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''));
  const out: string[] = [];
  let inHunk = false;

  const keepMeta = (line: string): boolean => {
    return (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('Binary files ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@ ') ||
      line === '\\ No newline at end of file'
    );
  };

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      out.push(line);
      continue;
    }

    if (line.startsWith('diff --git ')) {
      inHunk = false;
      out.push(line);
      continue;
    }

    if (keepMeta(line)) {
      out.push(line);
      continue;
    }

    if (inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      out.push(line);
      continue;
    }
  }

  return out.join('\n').trim();
}

function renderFallback(text: string) {
  const host = hostEl.value;
  if (!host) return;
  host.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'm-0 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-700';
  pre.textContent = text;
  host.appendChild(pre);
}

async function renderPatch() {
  await nextTick();
  const host = hostEl.value;
  if (!host) return;
  host.innerHTML = '';

  const patch = props.patch?.trim();
  if (!patch) return;
  const cleanPatch = sanitizePatch(patch);
  if (!cleanPatch) {
    renderFallback(patch);
    return;
  }

  let parsed: any[] = [];
  try {
    parsed = parsePatchFiles(cleanPatch);
  } catch {
    renderFallback(cleanPatch);
    return;
  }

  const first = parsed[0]?.files?.[0];
  if (!first) {
    renderFallback(cleanPatch);
    return;
  }

  if (!instance) {
    instance = new FileDiff({
      theme: 'pierre-light',
      themeType: 'light',
      diffStyle: 'split',
      overflow: 'scroll',
      disableBackground: false,
      hunkSeparators: 'line-info'
    });
  }

  instance.render({
    fileDiff: first,
    containerWrapper: host
  });
}

watch(() => props.patch, () => {
  void renderPatch();
});

onMounted(() => {
  void renderPatch();
});

onUnmounted(() => {
  instance?.cleanUp();
  instance = null;
});
</script>

<template>
  <div ref="hostEl" class="w-full overflow-x-auto rounded-md border border-neutral-200 bg-white p-1"></div>
</template>
