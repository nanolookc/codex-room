export type Role = 'owner' | 'editor' | 'viewer';

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

export interface EditorState {
  roomId: string;
  text: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  cursors?: EditorCursor[];
}

export interface EditorCursor {
  userId: string;
  userName: string;
  selectionStart: number;
  selectionEnd: number;
  updatedAt: string;
}

export interface RoomSummary {
  roomId: string;
  updatedAt: string;
  messageCount: number;
  timelineCount: number;
  hasThreadId: boolean;
  preview?: string;
}

export interface TimelineEntry {
  id: string;
  roomId: string;
  side: 'left' | 'right';
  label: string;
  text: string;
  at: string;
  meta?: {
    kind:
      | 'user.message'
      | 'codex.started'
      | 'codex.item'
      | 'codex.completed'
      | 'codex.interrupted'
      | 'codex.failed';
    itemType?: string;
    model?: string;
    reasoningEffort?: string;
  };
}

export type CodexItem = {
  type: string;
  [key: string]: unknown;
};

export type CodexRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type RoomEvent =
  | { type: 'timeline.entry'; entry: TimelineEntry }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'editor.updated'; editor: EditorState }
  | { type: 'presence.joined'; userId: string; userName: string; at: string }
  | { type: 'presence.left'; userId: string; at: string }
  | { type: 'system.queueOverflow'; dropped: number; at: string }
  | { type: 'codex.rpc.notification'; message: CodexRpcMessage; at: string }
  | { type: 'codex.rpc.serverRequest'; message: CodexRpcMessage; at: string }
  | {
      type: 'codex.rpc.serverRequest.resolved';
      requestId: number | string;
      outcome: 'result' | 'error';
      at: string;
    }
  | {
      type: 'codex.turn.started';
      roomId: string;
      prompt: string;
      at: string;
      model?: string;
      reasoningEffort?: string;
    }
  | { type: 'codex.item.completed'; item: CodexItem; at: string }
  | { type: 'codex.turn.completed'; finalResponse: string; usage?: unknown; at: string }
  | { type: 'codex.turn.failed'; error: string; at: string };

export interface SendMessageInput {
  userId: string;
  userName: string;
  text: string;
}

export interface UpdateEditorInput {
  userId: string;
  userName?: string;
  text: string;
  baseVersion?: number;
  selectionStart?: number;
  selectionEnd?: number;
}

export interface RunCodexInput {
  userId: string;
  userName: string;
  prompt?: string;
}

export interface SteerCodexInput {
  userId: string;
  userName: string;
  prompt?: string;
}

export interface InterruptCodexInput {
  userId?: string;
  userName?: string;
}

export interface CodexRpcCallInput {
  method: string;
  params?: unknown;
}

export interface CodexRpcRespondInput {
  requestId: number | string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}
