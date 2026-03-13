import { nanoid } from 'nanoid';
import type { RelayShareCreateInput, RelayShareCreateResult } from '@codex-room/shared';
import type { AppLogger } from './logger';

export interface RelayViewerSessionRecord {
  id: string;
  token: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface RelayShareRecord {
  id: string;
  roomId: string;
  shareSlug: string;
  hostToken: string;
  createdAt: string;
  expiresAt: string;
  maxViewers: number;
  workspace?: string;
  hostName?: string;
  viewerSessions: Map<string, RelayViewerSessionRecord>;
}

export class ShareStore {
  private readonly shares = new Map<string, RelayShareRecord>();
  private readonly shareBySlug = new Map<string, string>();
  private readonly viewerToShare = new Map<string, string>();
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(
    private readonly logger: AppLogger,
    private readonly publicBaseUrl: string,
    private readonly defaultTtlSeconds: number,
    private readonly defaultMaxViewers: number
  ) {
    this.sweepInterval = setInterval(() => this.sweepExpired(), 60_000);
    this.sweepInterval.unref?.();
  }

  createShare(input: RelayShareCreateInput): RelayShareCreateResult {
    const roomId = input.roomId?.trim();
    if (!roomId) throw new Error('roomId is required');

    const ttlSeconds = this.normalizeTtl(input.ttlSeconds);
    const maxViewers = this.normalizeMaxViewers(input.maxViewers);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const shareId = `shr_${nanoid(18)}`;
    const shareSlug = nanoid(22);
    const hostToken = nanoid(40);

    const share: RelayShareRecord = {
      id: shareId,
      roomId,
      shareSlug,
      hostToken,
      createdAt,
      expiresAt,
      maxViewers,
      workspace: input.workspace?.trim() || undefined,
      hostName: input.hostName?.trim() || undefined,
      viewerSessions: new Map()
    };

    this.shares.set(shareId, share);
    this.shareBySlug.set(shareSlug, shareId);
    this.logger.info('relay.share.created', {
      shareId,
      roomId,
      expiresAt,
      maxViewers
    });

    return {
      shareId,
      roomId,
      shareSlug,
      hostToken,
      viewerUrl: `${this.publicBaseUrl}/r/${encodeURIComponent(shareSlug)}`,
      expiresAt,
      maxViewers
    };
  }

  getShareById(shareId: string): RelayShareRecord | null {
    const share = this.shares.get(shareId) ?? null;
    if (!share) return null;
    if (this.isExpired(share)) {
      this.deleteShare(share.id);
      return null;
    }
    return share;
  }

  getShareBySlug(shareSlug: string): RelayShareRecord | null {
    const shareId = this.shareBySlug.get(shareSlug);
    if (!shareId) return null;
    return this.getShareById(shareId);
  }

  authenticateHost(shareId: string, hostToken: string): RelayShareRecord | null {
    const share = this.getShareById(shareId);
    if (!share || share.hostToken !== hostToken) return null;
    return share;
  }

  createViewerSession(shareSlug: string): { share: RelayShareRecord; cookieValue: string; maxAgeSeconds: number } | null {
    const share = this.getShareBySlug(shareSlug);
    if (!share) return null;

    if (share.viewerSessions.size >= share.maxViewers) {
      throw new Error('Viewer limit reached for this share');
    }

    const now = new Date().toISOString();
    const viewerSessionId = `vwr_${nanoid(14)}`;
    const token = nanoid(32);
    const session: RelayViewerSessionRecord = {
      id: viewerSessionId,
      token,
      createdAt: now,
      lastSeenAt: now
    };
    share.viewerSessions.set(viewerSessionId, session);
    this.viewerToShare.set(viewerSessionId, share.id);

    return {
      share,
      cookieValue: `${share.id}.${viewerSessionId}.${token}`,
      maxAgeSeconds: Math.max(1, Math.floor((Date.parse(share.expiresAt) - Date.now()) / 1000))
    };
  }

  authenticateViewer(cookieValue: string, expectedRoomId?: string): RelayShareRecord | null {
    const parsed = this.parseViewerCookie(cookieValue);
    if (!parsed) return null;

    const { shareId, viewerSessionId, token } = parsed;
    const mappedShareId = this.viewerToShare.get(viewerSessionId);
    if (mappedShareId !== shareId) return null;

    const share = this.getShareById(shareId);
    if (!share) return null;
    if (expectedRoomId && share.roomId !== expectedRoomId) return null;

    const viewerSession = share.viewerSessions.get(viewerSessionId);
    if (!viewerSession || viewerSession.token !== token) return null;

    viewerSession.lastSeenAt = new Date().toISOString();
    return share;
  }

  deleteShare(shareId: string) {
    const share = this.shares.get(shareId);
    if (!share) return;

    this.shares.delete(shareId);
    this.shareBySlug.delete(share.shareSlug);
    for (const viewerSessionId of share.viewerSessions.keys()) {
      this.viewerToShare.delete(viewerSessionId);
    }
    this.logger.info('relay.share.deleted', {
      shareId,
      roomId: share.roomId
    });
  }

  private parseViewerCookie(cookieValue: string): { shareId: string; viewerSessionId: string; token: string } | null {
    const parts = cookieValue.split('.');
    if (parts.length !== 3) return null;
    const [shareId, viewerSessionId, token] = parts.map((entry) => entry.trim());
    if (!shareId || !viewerSessionId || !token) return null;
    return { shareId, viewerSessionId, token };
  }

  private sweepExpired() {
    for (const share of this.shares.values()) {
      if (this.isExpired(share)) this.deleteShare(share.id);
    }
  }

  private isExpired(share: RelayShareRecord) {
    return Date.parse(share.expiresAt) <= Date.now();
  }

  private normalizeTtl(ttlSeconds: number | undefined) {
    const value = typeof ttlSeconds === 'number' ? ttlSeconds : Number(ttlSeconds);
    if (!Number.isFinite(value) || value <= 0) return this.defaultTtlSeconds;
    return Math.min(Math.max(Math.floor(value), 300), 7 * 24 * 60 * 60);
  }

  private normalizeMaxViewers(maxViewers: number | undefined) {
    const value = typeof maxViewers === 'number' ? maxViewers : Number(maxViewers);
    if (!Number.isFinite(value) || value <= 0) return this.defaultMaxViewers;
    return Math.min(Math.max(Math.floor(value), 1), 20);
  }
}
