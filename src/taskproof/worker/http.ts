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
import { getWorkerRuntime, WorkerRuntime } from './runtime';

export interface WorkerAppDeps {
  runtime?: WorkerRuntime;
}

export function createWorkerApp(deps: WorkerAppDeps = {}): Express {
  const app = express();
  app.use(express.json());
  const runtimeOf = (): WorkerRuntime => deps.runtime ?? getWorkerRuntime();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      process: 'taskproof-worker',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/internal/taskproof/status', (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    res.json(runtimeOf().status());
  });

  app.post('/internal/taskproof/ensure-listening', async (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const taskId = typeof req.body?.task_id === 'string' ? req.body.task_id : undefined;
    const result = await runtimeOf().ensureListening(taskId);
    res.status(result.httpStatus).json({
      state: result.state,
      error: result.error,
    });
  });

  app.post('/internal/taskproof/remind', async (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const taskId = typeof req.body?.task_id === 'string' ? req.body.task_id.trim() : '';
    if (!taskId) {
      res.status(400).json({ success: false, error: 'task_id is required' });
      return;
    }
    const result = await runtimeOf().remind(taskId);
    res.status(result.httpStatus).json({
      state: result.state,
      reminded: result.reminded,
      kind: result.kind,
      missing_count: result.missing_count,
      task_id: result.task_id || taskId,
      error: result.error,
    });
  });

  app.post('/internal/taskproof/link-group', (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const officialChatId =
      typeof req.body?.official_chat_id === 'string' ? req.body.official_chat_id : '';
    const zcaGroupId =
      typeof req.body?.zca_group_id === 'string' ? req.body.zca_group_id : undefined;
    const result = runtimeOf().linkGroup(officialChatId, zcaGroupId);
    res.status(result.httpStatus).json(result.body);
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
