/**
 * supervisorPolicy.ts
 *
 * Quy tắc giám sát hai process (Section 0.9):
 * - Official bot chết → container thoát để Railway restart.
 * - Worker chết → official bot (và /gui) phải sống; chỉ báo admin.
 * Crash của worker KHÔNG được kéo sập /gui.
 */

export type ChildRole = 'official-bot' | 'worker';

export type SupervisorDecision =
  | { action: 'exit-container'; exitCode: number }
  | { action: 'keep-bot-and-notify'; exitCode: number };

export interface SupervisedChild {
  kill(signal?: NodeJS.Signals): boolean | void;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
}

export function decideOnChildExit(
  role: ChildRole,
  code: number | null,
  _signal: NodeJS.Signals | null
): SupervisorDecision {
  const exitCode = code ?? 1;
  if (role === 'official-bot') {
    return { action: 'exit-container', exitCode };
  }
  return { action: 'keep-bot-and-notify', exitCode };
}

export async function waitForHttpOk(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    isDead?: () => boolean;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 200;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (options.isDead?.()) {
      throw new Error(`Process died before ${url} became ready`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Chưa lên — thử lại.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timeout waiting for ${url}`);
}

export const WORKER_RESPAWN_BACKOFF_MS = [2_000, 10_000, 60_000] as const;
const WORKER_STABLE_MS = 60_000;

export function attachSupervisor(opts: {
  bot: SupervisedChild;
  worker: SupervisedChild;
  notifyWorkerDown: (info: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void | Promise<void>;
  exitContainer: (code: number) => void;
  log?: (msg: string) => void;
  spawnWorker?: () => SupervisedChild;
  scheduleTimeout?: (fn: () => void, ms: number) => () => void;
}): { beginShutdown: (signal?: NodeJS.Signals) => void } {
  let shuttingDown = false;
  let exited = false;
  let worker = opts.worker;
  let respawnAttempt = 0;
  let cancelRespawn: (() => void) | null = null;
  let cancelStable: (() => void) | null = null;

  const scheduleTimeout =
    opts.scheduleTimeout ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    shuttingDown = true;
    cancelRespawn?.();
    cancelStable?.();
    opts.exitContainer(code);
  };

  const armStableReset = () => {
    cancelStable?.();
    cancelStable = scheduleTimeout(() => {
      respawnAttempt = 0;
    }, WORKER_STABLE_MS);
  };

  const wireWorker = (child: SupervisedChild) => {
    armStableReset();
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      cancelStable?.();
      const decision = decideOnChildExit('worker', code, signal);
      opts.log?.(
        `[Supervisor] Worker đã thoát (code=${code}, signal=${signal}). Official bot vẫn chạy — /gui không bị ảnh hưởng.`
      );
      if (decision.action === 'keep-bot-and-notify') {
        void Promise.resolve(opts.notifyWorkerDown({ code, signal })).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          opts.log?.(`[Supervisor] Không gửi được cảnh báo worker-down: ${msg}`);
        });
      }
      if (!opts.spawnWorker) return;
      const delay =
        WORKER_RESPAWN_BACKOFF_MS[Math.min(respawnAttempt, WORKER_RESPAWN_BACKOFF_MS.length - 1)];
      respawnAttempt += 1;
      opts.log?.(`[Supervisor] Sẽ khởi động lại worker sau ${delay}ms (lần ${respawnAttempt}).`);
      cancelRespawn?.();
      cancelRespawn = scheduleTimeout(() => {
        if (shuttingDown) return;
        try {
          worker = opts.spawnWorker!();
          wireWorker(worker);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.log?.(`[Supervisor] Spawn worker thất bại: ${msg}`);
        }
      }, delay);
    });
  };

  opts.bot.on('exit', (code, signal) => {
    const decision = decideOnChildExit('official-bot', code, signal);
    shuttingDown = true;
    cancelRespawn?.();
    cancelStable?.();
    opts.log?.(
      `[Supervisor] Official bot đã thoát (code=${code}, signal=${signal}). Container sẽ thoát.`
    );
    try {
      worker.kill('SIGTERM');
    } catch {
      // Worker đã chết.
    }
    exitOnce(decision.exitCode);
  });

  wireWorker(worker);

  return {
    beginShutdown(signal: NodeJS.Signals = 'SIGTERM') {
      if (shuttingDown) return;
      shuttingDown = true;
      cancelRespawn?.();
      cancelStable?.();
      opts.log?.(`[Supervisor] Đang tắt (${signal})...`);
      try {
        opts.bot.kill(signal);
      } catch {
        // already dead
      }
      try {
        worker.kill(signal);
      } catch {
        // already dead
      }
    },
  };
}
