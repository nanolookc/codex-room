import { threadStatusTypeFromValue } from '@codex-room/shared';

export type EffortOptionLike = {
  id: string;
  label: string;
  description?: string;
};

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type AccessMode = 'full-access' | 'need-approve';

export function formatEffortLabel(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export { threadStatusTypeFromValue };

export function approvalDecisionOptionsFromValue(value: unknown): ApprovalDecision[] {
  const allowed: ApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
  const requested = Array.isArray(value)
    ? value.filter((entry): entry is ApprovalDecision => typeof entry === 'string' && allowed.includes(entry as ApprovalDecision))
    : [];
  if (requested.length > 0) return requested;
  return ['accept', 'acceptForSession', 'decline'];
}

export function parseModelEffortOptions(entry: any): EffortOptionLike[] {
  const effortEntries = Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : Array.isArray(entry?.reasoningEffort)
      ? entry.reasoningEffort
      : [];
  return effortEntries
    .map((effortEntry: any) => {
      const effortId =
        typeof effortEntry?.reasoningEffort === 'string'
          ? effortEntry.reasoningEffort
          : typeof effortEntry?.effort === 'string'
            ? effortEntry.effort
            : '';
      if (!effortId) return null;
      return {
        id: effortId,
        label: formatEffortLabel(effortId),
        description:
          typeof effortEntry?.description === 'string' && effortEntry.description.trim()
            ? effortEntry.description.trim()
            : undefined
      } satisfies EffortOptionLike;
    })
    .filter((effortEntry: EffortOptionLike | null): effortEntry is EffortOptionLike => Boolean(effortEntry));
}

export function extractRequestedWriteRoots(permissions: unknown): string[] {
  const writeRoots = (permissions as any)?.fileSystem?.write;
  return Array.isArray(writeRoots)
    ? writeRoots.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function buildGrantedPermissions(requestedPermissions: unknown, grantedWriteRoots: string[]): Record<string, unknown> {
  if (!requestedPermissions || typeof requestedPermissions !== 'object') return {};
  const requested = JSON.parse(JSON.stringify(requestedPermissions)) as Record<string, any>;
  const requestedWriteRoots = extractRequestedWriteRoots(requestedPermissions);
  if (requestedWriteRoots.length === 0) {
    return requested;
  }

  const allowed = new Set(grantedWriteRoots);
  const nextWriteRoots = requestedWriteRoots.filter((entry) => allowed.has(entry));

  if (!requested.fileSystem || typeof requested.fileSystem !== 'object') {
    return requested;
  }

  const nextFileSystem = { ...(requested.fileSystem as Record<string, unknown>) };
  if (nextWriteRoots.length > 0) {
    nextFileSystem.write = nextWriteRoots;
  } else {
    delete nextFileSystem.write;
  }

  if (Object.keys(nextFileSystem).length > 0) {
    requested.fileSystem = nextFileSystem;
  } else {
    delete requested.fileSystem;
  }

  return requested;
}

export function approvalPolicyForMode(mode: AccessMode): string {
  return mode === 'full-access' ? 'never' : 'unlessTrusted';
}

export function sandboxModeForMode(mode: AccessMode): string {
  return mode === 'full-access' ? 'danger-full-access' : 'workspace-write';
}

export function sandboxPolicyForMode(mode: AccessMode, workingDirectory: string): Record<string, unknown> {
  if (mode === 'full-access') {
    return { type: 'dangerFullAccess' };
  }

  return {
    type: 'workspaceWrite',
    ...(workingDirectory ? { writableRoots: [workingDirectory] } : {}),
    networkAccess: true
  };
}
