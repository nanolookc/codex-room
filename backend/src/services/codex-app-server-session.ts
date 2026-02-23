import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AppLogger } from './logger';

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcId = number | string;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: JsonRpcError;
};

type NotificationHandler = (message: JsonRpcMessage) => void;
type ServerRequestHandlerResult =
  | { handled: true; result?: unknown }
  | { handled: true; error: JsonRpcError }
  | undefined;
type ServerRequestHandler = (
  message: JsonRpcMessage
) => ServerRequestHandlerResult | Promise<ServerRequestHandlerResult>;

function safeJsonSnippet(value: unknown, maxLength = 1200): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return '';
    return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
  } catch {
    return '[unserializable]';
  }
}

export class AppServerSession {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    JsonRpcId,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private handlers = new Set<NotificationHandler>();
  private requestHandlers = new Set<ServerRequestHandler>();

  private constructor(
    proc: ChildProcessWithoutNullStreams,
    private readonly logger: AppLogger
  ) {
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.logger.warn('codex.app_server.invalid_json', { line });
        return;
      }

      const hasId = typeof message.id === 'number' || typeof message.id === 'string';
      const hasMethod = typeof message.method === 'string' && message.method.length > 0;

      if (hasId && hasMethod) {
        void this.handleServerRequest(message);
        return;
      }

      if (hasId) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (hasMethod) {
        for (const handler of this.handlers) handler(message);
      }
    });

    proc.on('exit', (code, signal) => {
      const reason = `app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(reason));
        this.pending.delete(id);
      }
    });

    proc.on('error', (error) => {
      const reason = `app-server spawn error: ${error.message}`;
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(reason));
        this.pending.delete(id);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.includes('state db missing rollout path for thread')) {
        this.logger.debug('codex.app_server.stderr.rollout_missing_path');
        return;
      }
      this.logger.debug('codex.app_server.stderr', { text: trimmed });
    });
  }

  static async start(logger: AppLogger): Promise<AppServerSession> {
    const proc = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const session = new AppServerSession(proc, logger);

    await session.request('initialize', {
      clientInfo: {
        name: 'codex_room',
        title: 'Codex Room',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    });
    session.notify('initialized', {});

    return session;
  }

  private writeMessage(payload: Record<string, unknown>) {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async handleServerRequest(message: JsonRpcMessage) {
    const method = typeof message.method === 'string' ? message.method : 'unknown';
    const id = message.id;
    if (id === undefined) return;

    try {
      for (const handler of this.requestHandlers) {
        const outcome = await handler(message);
        if (!outcome?.handled) continue;
        if ('error' in outcome && outcome.error) {
          this.writeMessage({
            id,
            error: {
              code: outcome.error.code,
              message: outcome.error.message,
              ...(outcome.error.data !== undefined ? { data: outcome.error.data } : {})
            }
          });
          return;
        }
        this.writeMessage({
          id,
          result: outcome.result ?? null
        });
        return;
      }

      this.logger.warn('codex.app_server.server_request.unhandled', {
        method,
        id,
        params: safeJsonSnippet(message.params)
      });
      this.writeMessage({
        id,
        error: {
          code: -32601,
          message: `Unsupported server-initiated request: ${method}`
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('codex.app_server.server_request.failed', {
        method,
        id,
        error: errorMessage
      });
      this.writeMessage({
        id,
        error: {
          code: -32603,
          message: 'Internal error handling server-initiated request',
          data: { method, error: errorMessage }
        }
      });
    }
  }

  close() {
    this.handlers.clear();
    this.requestHandlers.clear();

    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }

    if (!this.proc.killed) {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (!this.proc.killed) this.proc.kill('SIGKILL');
      }, 800);
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onRequest(handler: ServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = { method, id, ...(params ? { params } : {}) };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, 30000);

      const wrappedResolve = (value: any) => {
        clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      this.writeMessage(payload);
    });
  }

  notify(method: string, params?: unknown) {
    const payload = { method, ...(params ? { params } : {}) };
    this.writeMessage(payload);
  }
}

