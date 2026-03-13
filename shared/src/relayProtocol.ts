export interface RelayShareCreateInput {
  roomId: string;
  workspace?: string;
  hostName?: string;
  ttlSeconds?: number;
  maxViewers?: number;
}

export interface RelayShareCreateResult {
  shareId: string;
  roomId: string;
  shareSlug: string;
  hostToken: string;
  viewerUrl: string;
  expiresAt: string;
  maxViewers: number;
}

export interface RelayViewerSession {
  shareId: string;
  viewerSessionId: string;
  roomId: string;
  expiresAt: string;
}

export interface RelayHttpRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface RelayHttpResponseStart {
  requestId: string;
  status: number;
  headers: Record<string, string>;
}

export interface RelayHttpBodyChunk {
  requestId: string;
  chunkBase64: string;
}

export interface RelayHttpResponseEnd {
  requestId: string;
}

export interface RelayHttpResponseError {
  requestId: string;
  status?: number;
  error: string;
}

export type RelayTunnelMessage =
  | {
      type: 'host.connected';
      shareId: string;
      roomId: string;
      expiresAt: string;
    }
  | ({ type: 'relay.request' } & RelayHttpRequest)
  | { type: 'relay.request.cancel'; requestId: string }
  | ({ type: 'relay.response.start' } & RelayHttpResponseStart)
  | ({ type: 'relay.response.chunk' } & RelayHttpBodyChunk)
  | ({ type: 'relay.response.end' } & RelayHttpResponseEnd)
  | ({ type: 'relay.response.error' } & RelayHttpResponseError)
  | { type: 'ping'; at: string }
  | { type: 'pong'; at: string };
