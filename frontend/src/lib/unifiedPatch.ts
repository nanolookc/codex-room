export type UnifiedPatchRowKind =
  | 'meta'
  | 'fileOld'
  | 'fileNew'
  | 'hunk'
  | 'context'
  | 'add'
  | 'del'
  | 'note';

export type UnifiedPatchRow = {
  id: string;
  kind: UnifiedPatchRowKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export function sanitizeUnifiedPatch(raw: string): string {
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''));
  const out: string[] = [];
  let inHunk = false;

  const isMeta = (line: string): boolean =>
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
    line === '\\ No newline at end of file';

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      out.push(line);
      continue;
    }

    if (line.startsWith('@@ ')) {
      inHunk = true;
      out.push(line);
      continue;
    }

    if (isMeta(line)) {
      out.push(line);
      continue;
    }

    if (inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      out.push(line);
      continue;
    }

    if (inHunk && line === '') {
      out.push(' ');
      continue;
    }

    if (inHunk && line.length > 0) {
      // Some payloads lose the unified diff context prefix; recover it.
      out.push(` ${line}`);
      continue;
    }

    if (!inHunk && line.length > 0) {
      out.push(line);
    }
  }

  return out.join('\n');
}

function parseRange(value: string | undefined): number {
  if (!value) return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function parseUnifiedPatch(raw: string): UnifiedPatchRow[] {
  const patch = sanitizeUnifiedPatch(raw);
  if (!patch.trim()) return [];

  const rows: UnifiedPatchRow[] = [];
  const lines = patch.split('\n');
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const push = (kind: UnifiedPatchRowKind, text: string, o: number | null, n: number | null) => {
    rows.push({
      id: `${rows.length}:${kind}:${o ?? 'x'}:${n ?? 'x'}`,
      kind,
      text,
      oldLine: o,
      newLine: n
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Ignore the split() artifact for trailing newline outside hunks.
    if (line === '' && i === lines.length - 1 && !inHunk) continue;

    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('new file mode ') || line.startsWith('deleted file mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ') || line.startsWith('old mode ') || line.startsWith('new mode ') || line.startsWith('Binary files ')) {
      inHunk = false;
      push('meta', line, null, null);
      continue;
    }

    if (line.startsWith('--- ')) {
      inHunk = false;
      push('fileOld', line, null, null);
      continue;
    }

    if (line.startsWith('+++ ')) {
      inHunk = false;
      push('fileNew', line, null, null);
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      inHunk = true;
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      // Parse counts to validate numeric shape early (not currently used for rendering).
      parseRange(hunkMatch[2]);
      parseRange(hunkMatch[4]);
      push('hunk', line, null, null);
      continue;
    }

    if (line === '\\ No newline at end of file') {
      push('note', line, null, null);
      continue;
    }

    if (inHunk && line.startsWith('+') && !line.startsWith('+++ ')) {
      push('add', line, null, newLine);
      newLine += 1;
      continue;
    }

    if (inHunk && line.startsWith('-') && !line.startsWith('--- ')) {
      push('del', line, oldLine, null);
      oldLine += 1;
      continue;
    }

    if (inHunk && line.startsWith(' ')) {
      push('context', line, oldLine, newLine);
      oldLine += 1;
      newLine += 1;
      continue;
    }

    push('meta', line, null, null);
  }

  return rows;
}
