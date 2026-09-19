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

export function attachSupervisor(opts: {
  bot: SupervisedChild;
  worker: SupervisedChild;
  notifyWorkerDown: (info: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void | Promise<void>;
  exitContainer: (code: number) => void;
  log?: (msg: string) => void;
}): { beginShutdown: (signal?: NodeJS.Signals) => void } {
  let shuttingDown = false;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    shuttingDown = true;
    opts.exitContainer(code);
  };

  opts.bot.on('exit', (code, signal) => {
    const decision = decideOnChildExit('official-bot', code, signal);
    shuttingDown = true;
    opts.log?.(
      `[Supervisor] Official bot đã thoát (code=${code}, signal=${signal}). Container sẽ thoát.`
    );
    try {
      opts.worker.kill('SIGTERM');
    } catch {
      // Worker đã chết.
    }
    exitOnce(decision.exitCode);
  });

  opts.worker.on('exit', (code, signal) => {
    if (shuttingDown) return;
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
  });

  return {
    beginShutdown(signal: NodeJS.Signals = 'SIGTERM') {
      if (shuttingDown) return;
      shuttingDown = true;
      opts.log?.(`[Supervisor] Đang tắt (${signal})...`);
      try {
        opts.bot.kill(signal);
      } catch {
        // already dead
      }
      try {
        opts.worker.kill(signal);
      } catch {
        // already dead
      }
    },
  };
}
