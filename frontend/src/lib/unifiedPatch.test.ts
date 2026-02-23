import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUnifiedPatch, sanitizeUnifiedPatch } from './unifiedPatch.ts';

test('sanitizes malformed context lines inside hunks', () => {
  const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
foo
-bar
+baz
`;

  const sanitized = sanitizeUnifiedPatch(patch);
  assert.match(sanitized, /\n foo\n-bar\n\+baz\n/);
});

test('parses no-newline marker patch without losing rows', () => {
  const patch = `diff --git a/backend/README.md b/backend/README.md
index 6f27ffe0f2b21a3327356705890cc3bb008ce3b7..d49b6da249b725c69c2b0bc2cd67e2011a6a5fa3
--- a/backend/README.md
+++ b/backend/README.md
@@ -5,5 +5,4 @@
 test
 test
 тест
-
-тест
\\ No newline at end of file
+тест
`;

  const rows = parseUnifiedPatch(patch);
  assert.ok(rows.length > 0);

  const kinds = rows.map((row) => row.kind);
  assert.ok(kinds.includes('hunk'));
  assert.ok(kinds.includes('context'));
  assert.ok(kinds.includes('del'));
  assert.ok(kinds.includes('add'));
  assert.ok(kinds.includes('note'));

  const noteRow = rows.find((row) => row.kind === 'note');
  assert.equal(noteRow?.text, '\\ No newline at end of file');

  const delRows = rows.filter((row) => row.kind === 'del');
  const addRows = rows.filter((row) => row.kind === 'add');
  assert.deepEqual(
    delRows.map((r) => [r.oldLine, r.newLine, r.text]),
    [
      [8, null, '-'],
      [9, null, '-тест']
    ]
  );
  assert.deepEqual(addRows.map((r) => [r.oldLine, r.newLine, r.text]), [[null, 8, '+тест']]);
});
