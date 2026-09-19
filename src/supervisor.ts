/**
 * supervisor.ts
 *
 * Launcher một container / hai process (Section 2, 0.9):
 * - Official bot: 0.0.0.0:${PORT} — nếu chết, container thoát.
 * - Worker: 127.0.0.1:${TASKPROOF_WORKER_PORT} — nếu chết, bot vẫn chạy
 *   và báo admin. Crash worker không được kéo sập /gui.
 * Cả hai đọc cùng file SQLite trên volume /data; chỉ bot tạo bảng.
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';
import { getInternalApiKey, getOfficialBotPort } from './taskproof/env';
import { attachSupervisor, waitForHttpOk } from './taskproof/supervisorPolicy';

dotenv.config();
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

function spawnAppProcess(scriptBase: string): ChildProcess {
  const runningTs = __filename.endsWith('.ts');
  const script = path.join(__dirname, runningTs ? `${scriptBase}.ts` : `${scriptBase}.js`);
  const args = runningTs ? ['--import', 'tsx', script] : [script];
  return spawn(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
  });
}

async function notifyOfficialBotWorkerDown(info: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): Promise<void> {
  const port = getOfficialBotPort();
  const key = getInternalApiKey();
  const url = `http://127.0.0.1:${port}/internal/taskproof/worker-down`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': key,
    },
    body: JSON.stringify({ code: info.code, signal: info.signal }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`worker-down HTTP ${res.status} ${body}`);
  }
}

async function main(): Promise<void> {
  const botPort = getOfficialBotPort();
  console.log('[Supervisor] Khởi động official bot...');
  const bot = spawnAppProcess('index');

  bot.on('error', (err) => {
    console.error('[Supervisor] Không spawn được official bot:', err);
    process.exit(1);
  });

  let botAlive = true;
  bot.on('exit', () => {
    botAlive = false;
  });

  try {
    await waitForHttpOk(`http://127.0.0.1:${botPort}/health`, {
      timeoutMs: 30_000,
      isDead: () => !botAlive,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Supervisor] Official bot không sẵn sàng:', msg);
    try {
      bot.kill('SIGTERM');
    } catch {
      // ignore
    }
    process.exit(1);
    return;
  }

  console.log('[Supervisor] Khởi động task-proof worker...');
  const worker = spawnAppProcess('taskproof/worker/index');
  worker.on('error', (err) => {
    console.error('[Supervisor] Không spawn được worker:', err);
  });

  const runtime = attachSupervisor({
    bot,
    worker,
    notifyWorkerDown: notifyOfficialBotWorkerDown,
    exitContainer: (code) => process.exit(code),
    log: (msg) => console.log(msg),
  });

  process.on('SIGTERM', () => runtime.beginShutdown('SIGTERM'));
  process.on('SIGINT', () => runtime.beginShutdown('SIGINT'));
}

if (require.main === module) {
  void main();
}
