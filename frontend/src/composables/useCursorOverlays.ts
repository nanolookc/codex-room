import { ref, type Ref } from 'vue';
import type { EditorCursor } from '@codex-room/shared';
import type { CursorOverlay } from '../lib/codexAppUi';

const CURSOR_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
];

const REMOTE_CURSOR_MAX_AGE_MS = 20_000;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorForUser(user: string): string {
  return CURSOR_COLORS[hashString(user) % CURSOR_COLORS.length] ?? CURSOR_COLORS[0];
}

function toMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function clampCursorPosition(position: number, textLength: number): number {
  return Math.min(textLength, Math.max(0, Math.floor(position)));
}

function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number) {
  const doc = textarea.ownerDocument;
  const mirror = doc.createElement('div');
  const marker = doc.createElement('span');
  const style = window.getComputedStyle(textarea);

  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordBreak = 'break-word';
  mirror.style.overflow = 'hidden';
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = `${textarea.clientHeight}px`;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.style.font = style.font;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.textTransform = style.textTransform;
  mirror.style.textIndent = style.textIndent;
  mirror.style.tabSize = style.tabSize;

  mirror.textContent = textarea.value.slice(0, position);
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;
  const lineHeight = Number.parseFloat(style.lineHeight) || Math.ceil(Number.parseFloat(style.fontSize) * 1.3);

  doc.body.removeChild(mirror);
  return { left, top, height: lineHeight };
}

export function useCursorOverlays(options: {
  editorEl: Ref<HTMLTextAreaElement | null>;
  editorText: Ref<string>;
  editorCursors: Ref<EditorCursor[]>;
  userId: Ref<string>;
}) {
  const cursorOverlays = ref<CursorOverlay[]>([]);

  function refreshCursorOverlays() {
    const el = options.editorEl.value;
    if (!el) {
      cursorOverlays.value = [];
      return;
    }

    const now = Date.now();
    const next: CursorOverlay[] = [];

    for (const cursor of options.editorCursors.value) {
      if (!cursor || cursor.userId === options.userId.value) continue;
      if (!cursor.updatedAt || now - toMs(cursor.updatedAt) > REMOTE_CURSOR_MAX_AGE_MS) continue;
      const index = clampCursorPosition(
        cursor.selectionEnd ?? cursor.selectionStart ?? 0,
        options.editorText.value.length
      );
      const coords = getCaretCoordinates(el, index);
      if (coords.top + coords.height < 0 || coords.top > el.clientHeight) continue;
      next.push({
        userId: cursor.userId,
        userName: cursor.userName || cursor.userId,
        color: colorForUser(cursor.userId),
        left: Math.max(0, coords.left),
        top: Math.max(0, coords.top),
        height: coords.height
      });
    }

    cursorOverlays.value = next;
  }

  return {
    cursorOverlays,
    refreshCursorOverlays
  };
}
