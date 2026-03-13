import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { AppServerSession } from './codex-app-server-session';
import type { AppLogger } from './logger';

const ALLOWED_METHODS = new Set([
  'app/list',
  'command/exec',
  'experimentalFeature/list',
  'model/list',
  'review/start',
  'skills/list',
  'thread/archive',
  'thread/compact/start',
  'thread/fork',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/resume',
  'thread/rollback',
  'thread/start',
  'thread/unarchive',
  'turn/interrupt',
  'turn/start',
  'turn/steer'
]);

const THREAD_SCOPED_METHODS = new Set([
  'review/start',
  'thread/archive',
  'thread/compact/start',
  'thread/fork',
  'thread/read',
  'thread/resume',
  'thread/rollback',
  'thread/unarchive',
  'turn/interrupt',
  'turn/start',
  'turn/steer'
]);

function normalizePathForScope(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  try {
    return resolve(trimmed);
  } catch {
    return trimmed;
  }
}

function threadCwdFromValue(thread: unknown): string | null {
  if (!thread || typeof thread !== 'object') return null;
  const obj = thread as Record<string, unknown>;
  const session = obj.session && typeof obj.session === 'object' ? (obj.session as Record<string, unknown>) : null;
  const candidates = [
    obj.cwd,
    obj.workingDirectory,
    obj.working_directory,
    session?.cwd,
    session?.workingDirectory,
    session?.working_directory
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

export class CodexRoomPolicy {
  private readonly workspaceRoot: string | null;
  private readonly gitWorkspaceRoot: string | null;

  constructor(
    private readonly logger: AppLogger,
    private readonly workingDirectory?: string,
    private readonly model?: string,
    private readonly reasoningEffort?: string
  ) {
    this.workspaceRoot = normalizePathForScope(workingDirectory);
    this.gitWorkspaceRoot = this.detectGitWorkspaceRoot(workingDirectory);
  }

  async applyRequestPolicy(
    session: AppServerSession,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Method is not available in codex-room proxy: ${method}`);
    }

    const obj =
      params && typeof params === 'object' && !Array.isArray(params)
        ? ({ ...(params as Record<string, unknown>) } as Record<string, unknown>)
        : {};

    const threadId =
      (typeof obj.threadId === 'string' && obj.threadId) ||
      (typeof obj.reviewThreadId === 'string' && obj.reviewThreadId) ||
      null;

    if (threadId && THREAD_SCOPED_METHODS.has(method)) {
      await this.assertThreadScope(session, threadId);
    }

    if (method === 'thread/list') {
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    if (method === 'skills/list') {
      if (this.workingDirectory) obj.cwds = [this.workingDirectory];
      return obj;
    }

    if (method === 'thread/start') {
      if (this.model && this.model !== 'default' && !obj.model) obj.model = this.model;
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    if (method === 'review/start') {
      this.assertReviewScopeAllowed();
      return obj;
    }

    if (method === 'turn/start') {
      if (this.reasoningEffort && !obj.effort) obj.effort = this.reasoningEffort;
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    if (method === 'command/exec') {
      if (this.workingDirectory) obj.cwd = this.workingDirectory;
      return obj;
    }

    return Object.keys(obj).length > 0 ? obj : params;
  }

  async applyResultPolicy(
    session: AppServerSession,
    method: string,
    result: unknown
  ): Promise<unknown> {
    if (method !== 'thread/loaded/list' || !this.workspaceRoot) {
      return result;
    }

    const data = Array.isArray((result as Record<string, unknown> | null)?.data)
      ? ((result as Record<string, unknown>).data as unknown[])
      : null;
    if (!data) return result;

    const filtered: string[] = [];
    for (const threadId of data) {
      if (typeof threadId !== 'string' || !threadId) continue;
      try {
        await this.assertThreadScope(session, threadId);
        filtered.push(threadId);
      } catch {
        // Hide threads outside the room workspace.
      }
    }

    return {
      ...(result && typeof result === 'object' ? (result as Record<string, unknown>) : {}),
      data: filtered
    };
  }

  private async assertThreadScope(session: AppServerSession, threadId: string): Promise<void> {
    if (!this.workspaceRoot) return;
    const response = await session.request('thread/read', {
      threadId,
      includeTurns: false
    });
    const thread = (response as Record<string, unknown> | null)?.thread;
    if (!thread || typeof thread !== 'object') return;

    const threadCwd = normalizePathForScope(threadCwdFromValue(thread));
    if (!threadCwd || threadCwd !== this.workspaceRoot) {
      this.logger.warn('codex.thread.scope.denied', {
        threadId,
        threadCwd: threadCwd ?? undefined,
        allowedCwd: this.workspaceRoot
      });
      throw new Error(
        `Thread is outside allowed workspace scope (thread cwd: ${threadCwd ?? 'unknown'}, allowed cwd: ${this.workspaceRoot})`
      );
    }
  }

  private detectGitWorkspaceRoot(workingDirectory?: string): string | null {
    if (!workingDirectory) return null;
    try {
      const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8'
      });
      if (result.status !== 0) return null;
      return normalizePathForScope(result.stdout);
    } catch {
      return null;
    }
  }

  private assertReviewScopeAllowed() {
    if (!this.workspaceRoot || !this.gitWorkspaceRoot) return;
    if (this.workspaceRoot === this.gitWorkspaceRoot) return;

    this.logger.warn('codex.review.scope.denied', {
      allowedCwd: this.workspaceRoot,
      gitWorkspaceRoot: this.gitWorkspaceRoot
    });
    throw new Error(
      'review/start is blocked for subdirectory-scoped rooms because review operates on the wider git workspace. Start codex-room from the repo root to review changes safely.'
    );
  }
}
