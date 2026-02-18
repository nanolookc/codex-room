type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class AppLogger {
  private minLevel: LogLevel;

  constructor() {
    this.minLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>) {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;

    const payload = {
      at: new Date().toISOString(),
      level,
      message,
      ...meta
    };

    console.log(JSON.stringify(payload));
  }

  private shouldLog(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = {
      debug: 10,
      info: 20,
      warn: 30,
      error: 40
    };

    return order[level] >= order[this.minLevel];
  }
}
