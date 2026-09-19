/**
 * worker/http.ts
 *
 * HTTP nội bộ của worker. Bind 127.0.0.1 — không public.
 * Process này không gọi Official Bot Platform và không CREATE TABLE
 * (chỉ official bot tạo bảng — Section 0.4).
 */

import http from 'http';
import express, { Express } from 'express';
import { getWorkerPort, WORKER_BIND_HOST } from '../env';
import { rejectIfInvalidInternalKey } from '../internalAuth';

export function createWorkerApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      process: 'taskproof-worker',
      timestamp: new Date().toISOString(),
    });
  });

  // Stub Section 10 — chưa login zca-js (Step 5).
  app.get('/internal/taskproof/status', (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    res.json({
      logged_in: false,
      listening: false,
      open_task_count: 0,
      pending_link: false,
    });
  });

  return app;
}

export function startWorkerHttp(
  app: Express = createWorkerApp(),
  port: number = getWorkerPort(),
  host: string = WORKER_BIND_HOST
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}
