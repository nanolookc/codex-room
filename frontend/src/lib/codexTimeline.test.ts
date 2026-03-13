import { describe, expect, test } from 'bun:test';
import {
  bodyText,
  buildCodexItemTimelineEntry,
  itemPatch,
  normalizeMeta,
  type CodexLogEntry
} from './codexTimeline';

function withId(entry: Omit<CodexLogEntry, 'id'>, id: string): CodexLogEntry {
  return { id, ...entry };
}

describe('codexTimeline', () => {
  test('builds stable timeline entries for file changes', () => {
    const entry = buildCodexItemTimelineEntry(
      {
        type: 'fileChange',
        status: 'completed',
        changes: [{ kind: 'update', path: '/tmp/demo.txt' }]
      },
      '2026-03-13T12:00:00.000Z',
      { turnId: 'turn-1', itemId: 'item-1' }
    );

    expect(entry).not.toBeNull();
    expect(normalizeMeta(entry!)).toMatchObject({
      kind: 'codex.item',
      itemType: 'file_change',
      turnId: 'turn-1',
      itemId: 'item-1'
    });
    expect(entry?.text).toContain('files:\n- update: /tmp/demo.txt');
  });

  test('strips inline diff noise from file-change body text', () => {
    const entry = withId(
      {
        side: 'right',
        label: 'codex',
        at: '2026-03-13T12:00:00.000Z',
        text: 'Item: file_change\nstatus: completed\nfiles:\n- update: /tmp/demo.txt\ndiff:\n@@ -1 +1 @@\n-old\n+new'
      },
      'entry-1'
    );

    expect(bodyText(entry)).toBe('status: completed\nfiles:\n- update: /tmp/demo.txt');
  });

  test('hides per-file patch when turn-level diff already exists', () => {
    const fileChange = withId(
      {
        side: 'right',
        label: 'codex',
        at: '2026-03-13T12:00:00.000Z',
        text: 'Item: file_change\nfiles:\n- update: /tmp/demo.txt',
        rawPatch: 'diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new',
        meta: { kind: 'codex.item', itemType: 'file_change', turnId: 'turn-1' }
      },
      'file-change'
    );
    const turnDiff = withId(
      {
        side: 'right',
        label: 'codex',
        at: '2026-03-13T12:00:01.000Z',
        text: 'Item: turn_diff',
        rawPatch: 'diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new',
        meta: { kind: 'codex.item', itemType: 'turn_diff', turnId: 'turn-1' }
      },
      'turn-diff'
    );

    expect(itemPatch([fileChange, turnDiff], fileChange)).toBeNull();
    expect(itemPatch([turnDiff], turnDiff)).toContain('diff --git');
  });
});
