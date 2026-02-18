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

function parseHunkRange(value: string): number {
  const m = value.match(/^(\d+)(?:,(\d+))?$/);
  if (!m) return 0;
  const count = m[2] ? Number(m[2]) : 1;
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function isRenderablePatch(patch: string): boolean {
  const lines = patch.split('\n');
  let sawHunk = false;
  let expectedOld = 0;
  let expectedNew = 0;
  let actualOld = 0;
  let actualNew = 0;
  let inHunk = false;

  const flushHunk = (): boolean => {
    if (!inHunk) return true;
    inHunk = false;
    return actualOld === expectedOld && actualNew === expectedNew;
  };

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (!flushHunk()) return false;
      const m = line.match(/^@@ -([0-9]+(?:,[0-9]+)?) \+([0-9]+(?:,[0-9]+)?) @@/);
      if (!m) return false;
      expectedOld = parseHunkRange(m[1]);
      expectedNew = parseHunkRange(m[2]);
      actualOld = 0;
      actualNew = 0;
      inHunk = true;
      sawHunk = true;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      if (!flushHunk()) return false;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      actualNew += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('--- ')) {
      actualOld += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      actualOld += 1;
      actualNew += 1;
      continue;
    }
    if (line === '\\ No newline at end of file') continue;
    if (!flushHunk()) return false;
  }

  return sawHunk && flushHunk();
}

function supportsSplitView(patch: string): boolean {
  const lines = patch.split('\n');
  let inHunk = false;
  let hasContext = false;
  let hasAdd = false;
  let hasDel = false;

  const flush = (): boolean => {
    if (!inHunk) return true;
    const ok = hasContext || (hasAdd && hasDel);
    inHunk = false;
    hasContext = false;
    hasAdd = false;
    hasDel = false;
    return ok;
  };

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (!flush()) return false;
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      if (!flush()) return false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith(' ')) hasContext = true;
    else if (line.startsWith('+') && !line.startsWith('+++ ')) hasAdd = true;
    else if (line.startsWith('-') && !line.startsWith('--- ')) hasDel = true;
  }

  return flush();
}

function normalizeParsedFileDiff(file: any): boolean {
  const hunks = Array.isArray(file?.hunks) ? file.hunks : [];
  let touched = false;

  for (const hunk of hunks) {
    const rows = Array.isArray(hunk?.hunkContent) ? hunk.hunkContent : [];

    for (const row of rows) {
      if (!row || row.type !== 'change') continue;

      const additions = Array.isArray(row.additions) ? [...row.additions] : [];
      const deletions = Array.isArray(row.deletions) ? [...row.deletions] : [];
      if (additions.length === 0 && deletions.length === 0) continue;

      const rowSize = Math.max(additions.length, deletions.length);
      const safeSize = rowSize > 0 ? rowSize : 1;
      while (additions.length < safeSize) additions.push('');
      while (deletions.length < safeSize) deletions.push('');

      if (
        additions.length !== (Array.isArray(row.additions) ? row.additions.length : 0) ||
        deletions.length !== (Array.isArray(row.deletions) ? row.deletions.length : 0)
      ) {
        row.additions = additions;
        row.deletions = deletions;
        touched = true;
      }
    }
  }

  return touched;
}

function hasUnsafeChangeRows(file: any): boolean {
  const hunks = Array.isArray(file?.hunks) ? file.hunks : [];

  for (const hunk of hunks) {
    const rows = Array.isArray(hunk?.hunkContent) ? hunk.hunkContent : [];
    for (const row of rows) {
      if (!row || row.type !== 'change') continue;
      const additions = Array.isArray(row.additions) ? row.additions.length : 0;
      const deletions = Array.isArray(row.deletions) ? row.deletions.length : 0;
      if ((additions > 0 && deletions === 0) || (deletions > 0 && additions === 0)) {
        return true;
      }
    }
  }

  return false;
}

function normalizeHunkHeaders(patch: string): string {
  const lines = patch.split('\n');
  const out = [...lines];
  let active:
    | {
        headerIndex: number;
        oldStart: number;
        newStart: number;
        suffix: string;
        oldCount: number;
        newCount: number;
      }
    | null = null;

  const flush = () => {
    if (!active) return;
    out[active.headerIndex] = `@@ -${active.oldStart},${active.oldCount} +${active.newStart},${active.newCount} @@${active.suffix}`;
    active = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunk) {
      flush();
      active = {
        headerIndex: i,
        oldStart: Number(hunk[1]),
        newStart: Number(hunk[3]),
        suffix: hunk[5] ?? '',
        oldCount: 0,
        newCount: 0
      };
      continue;
    }

    if (!active) continue;
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      active.newCount += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('--- ')) {
      active.oldCount += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      active.oldCount += 1;
      active.newCount += 1;
      continue;
    }
    if (line === '\\ No newline at end of file') continue;
    flush();
  }

  flush();
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
  if (!isRenderablePatch(cleanPatch)) {
    renderFallback(cleanPatch);
    return;
  }
  const patchForRenderer = cleanPatch;

  let parsed: any[] = [];
  try {
    parsed = parsePatchFiles(patchForRenderer);
  } catch {
    renderFallback(patchForRenderer);
    return;
  }

  const first = parsed[0]?.files?.[0];
  if (!first) {
    renderFallback(patchForRenderer);
    return;
  }
  normalizeParsedFileDiff(first);
  if (hasUnsafeChangeRows(first)) {
    renderFallback(patchForRenderer);
    return;
  }

  // Patch parsing can produce rows that don't have stable left/right pairs.
  // Use unified mode for patch strings to avoid split-view pairing failures.
  const diffStyle = 'unified';
  instance?.cleanUp();
  instance = new FileDiff({
    theme: 'pierre-light',
    themeType: 'light',
    diffStyle,
    overflow: 'scroll',
    disableBackground: false,
    hunkSeparators: 'line-info'
  });

  try {
    instance.render({
      fileDiff: first,
      containerWrapper: host
    });
  } catch {
    instance?.cleanUp();
    instance = null;
    renderFallback(patchForRenderer);
  }
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
