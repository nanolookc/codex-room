import type { ApprovalDecision } from './codexProtocol';

export type CodexThreadSummary = {
  id: string;
  preview?: string;
  updatedAt?: number;
  createdAt?: number;
  model?: string;
  cwd?: string;
  source?: string;
};

export type CursorOverlay = {
  userId: string;
  userName: string;
  color: string;
  left: number;
  top: number;
  height: number;
};

export type EffortOption = {
  id: string;
  label: string;
  description?: string;
};

export type ModelOption = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  effortOptions?: EffortOption[];
  defaultEffort?: string;
};

export type PendingApproval = {
  requestId: number | string;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
  turnId: string | null;
  itemId: string | null;
  title: string;
  reason: string;
  command?: string;
  patch?: string;
  files?: string[];
  decisions: ApprovalDecision[];
};

export type PermissionPromptOutcome =
  | { action: 'grant'; scope: 'turn' | 'session'; grantedWriteRoots: string[] }
  | { action: 'decline' }
  | 'cleared';

export type PendingPermissionsRequest = {
  requestId: number | string;
  turnId: string | null;
  reason: string;
  permissions: Record<string, unknown>;
  requestedWriteRoots: string[];
  selectedWriteRoots: string[];
};

export type ApprovalPromptOutcome = ApprovalDecision | 'cleared';

const USER_ADJECTIVES = [
  'Curious',
  'Sleepy',
  'Chaotic',
  'Tiny',
  'Cosmic',
  'Sneaky',
  'Wobbly',
  'Spicy',
  'Noisy',
  'Mellow',
  'Feral',
  'Glitchy'
];

const USER_ANIMALS = [
  'Raccoon',
  'Dinosaur',
  'Otter',
  'Capybara',
  'Lizard',
  'Pigeon',
  'Shark',
  'Badger',
  'Gecko',
  'Yak',
  'Mole',
  'Falcon'
];

function randomPick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function generateFunUserName(): string {
  const adjective = randomPick(USER_ADJECTIVES);
  const animal = randomPick(USER_ANIMALS);
  const suffix = Math.floor(Math.random() * 90) + 10;
  return `${adjective} ${animal} ${suffix}`;
}

export function shortId(value: string | null | undefined, head = 4, tail = 5): string {
  if (!value) return '';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}***${value.slice(-tail)}`;
}

export function formatThreadTime(unixSeconds?: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return 'unknown';
  return new Date(unixSeconds * 1000).toLocaleString();
}

export function approvalDecisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case 'accept':
      return 'Approve Once';
    case 'acceptForSession':
      return 'Approve Session';
    case 'decline':
      return 'Decline';
    case 'cancel':
      return 'Cancel';
  }
}
