#!/usr/bin/env bun
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

type StartOptions = {
  backendPort: number;
  host: string;
  room?: string;
};

function parseArgs(argv: string[]): { command: string | null; options: StartOptions } {
  const options: StartOptions = {
    backendPort: 3001,
    host: '0.0.0.0'
  };

  const [command, ...rest] = argv;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = rest[i + 1];

    if ((arg === '--backend-port' || arg === '-bp') && next) {
      options.backendPort = Number(next);
      i++;
      continue;
    }

    if ((arg === '--host' || arg === '-h') && next) {
      options.host = next;
      i++;
      continue;
    }

    if ((arg === '--room' || arg === '-r') && next) {
      options.room = next;
      i++;
      continue;
    }
  }

  return { command: command ?? null, options };
}

function getPrimaryIp(): string {
  try {
    const nets = networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) return entry.address;
      }
    }
  } catch {
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

function printUsage() {
  console.log('Usage: nlk-agents start [--backend-port 3001] [--host 0.0.0.0] [--room <id>]');
  console.log('If --room is omitted, a new room id is generated automatically.');
  console.log('start serves already built frontend from backend (single process).');
}

function runOrThrow(cmd: string[], cwd: string, label: string) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: process.env
  });

  if (proc.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${proc.exitCode}`);
  }
}

function runStart(options: StartOptions) {
  const targetWorkdir = process.cwd();
  const repoRoot = resolve(import.meta.dir, '../..');
  const frontendDist = resolve(repoRoot, 'frontend/dist');
  const indexPath = resolve(frontendDist, 'index.html');
  if (!existsSync(indexPath)) {
    console.error('frontend/dist not found. Build it manually: `bun run --cwd frontend build` (from nlk-agents repo).');
    process.exit(1);
  }

  const backendProc = Bun.spawn([
    'bun',
    'run',
    '--cwd',
    'backend',
    'src/index.ts'
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: options.host,
      PORT: String(options.backendPort),
      NLK_WORKDIR: targetWorkdir,
      NLK_SERVE_FRONTEND: '1',
      NLK_FRONTEND_DIST: frontendDist
    },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit'
  });

  const ip = getPrimaryIp();
  const roomId =
    options.room?.trim() ||
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const localUrl = `http://localhost:${options.backendPort}?room=${encodeURIComponent(roomId)}`;
  const shareUrl = `http://${ip}:${options.backendPort}?room=${encodeURIComponent(roomId)}`;

  console.log(`\nNLK Agents started for: ${targetWorkdir}`);
  console.log(`Room: ${roomId}`);
  console.log(`Local URL: ${localUrl}`);
  console.log(`Share URL: ${shareUrl}`);
  console.log('Press Ctrl+C to stop.\n');

  const shutdown = () => {
    backendProc.kill();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  backendProc.exited.then(() => shutdown());
}

const { command, options } = parseArgs(process.argv.slice(2));

if (!command || command === 'help' || command === '--help') {
  printUsage();
  process.exit(0);
}

if (command !== 'start') {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

runStart(options);
