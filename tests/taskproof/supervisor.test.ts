import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import express from 'express';
import {
  attachSupervisor,
  decideOnChildExit,
  SupervisedChild,
  waitForHttpOk,
} from '../../src/taskproof/supervisorPolicy';

class FakeChild implements SupervisedChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals | undefined;
  private listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this {
    if (event === 'exit') this.listeners.push(listener);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    this.emitExit(null, signal || 'SIGTERM');
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of this.listeners) listener(code, signal);
  }
}

describe('supervisor policy (Step 1)', () => {
  it('exits the container when the official bot dies', () => {
    expect(decideOnChildExit('official-bot', 1, null)).toEqual({
      action: 'exit-container',
      exitCode: 1,
    });
    expect(decideOnChildExit('official-bot', 0, null).action).toBe('exit-container');
    expect(decideOnChildExit('official-bot', null, 'SIGKILL').exitCode).toBe(1);
  });

  it('keeps the bot and notifies when the worker dies', () => {
    expect(decideOnChildExit('worker', 1, null)).toEqual({
      action: 'keep-bot-and-notify',
      exitCode: 1,
    });
  });

  it('kills the worker and exits when the official bot process exits', () => {
    const bot = new FakeChild();
    const worker = new FakeChild();
    const notifyWorkerDown = vi.fn();
    const exitContainer = vi.fn();

    attachSupervisor({ bot, worker, notifyWorkerDown, exitContainer });
    bot.emitExit(2, null);

    expect(worker.killedWith).toBe('SIGTERM');
    expect(exitContainer).toHaveBeenCalledWith(2);
    expect(notifyWorkerDown).not.toHaveBeenCalled();
  });

  it('notifies admin and does not exit when the worker process exits', () => {
    const bot = new FakeChild();
    const worker = new FakeChild();
    const notifyWorkerDown = vi.fn();
    const exitContainer = vi.fn();

    attachSupervisor({ bot, worker, notifyWorkerDown, exitContainer });
    worker.emitExit(1, null);

    expect(exitContainer).not.toHaveBeenCalled();
    expect(notifyWorkerDown).toHaveBeenCalledWith({ code: 1, signal: null });
  });

  it('does not notify on graceful shutdown', () => {
    const bot = new FakeChild();
    const worker = new FakeChild();
    const notifyWorkerDown = vi.fn();
    const exitContainer = vi.fn();

    const runtime = attachSupervisor({ bot, worker, notifyWorkerDown, exitContainer });
    runtime.beginShutdown('SIGTERM');

    expect(bot.killedWith).toBe('SIGTERM');
    expect(worker.killedWith).toBe('SIGTERM');
    expect(notifyWorkerDown).not.toHaveBeenCalled();
    expect(exitContainer).toHaveBeenCalled();
  });
});

describe('waitForHttpOk', () => {
  it('resolves when the URL returns ok', async () => {
    const app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    await waitForHttpOk(`http://127.0.0.1:${port}/health`, { timeoutMs: 2000, intervalMs: 20 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails fast when isDead becomes true', async () => {
    await expect(
      waitForHttpOk('http://127.0.0.1:1/health', {
        timeoutMs: 2000,
        intervalMs: 10,
        isDead: () => true,
      })
    ).rejects.toThrow(/died before/);
  });
});
