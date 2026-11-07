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
import { rejectIfInvalidInternalKey } from '../http/internalAuth';
import { historyFetchCount, QUET_DEFAULT_COUNT, QUET_MAX_COUNT, QUET_MIN_COUNT } from '../quet';
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

  app.post('/internal/taskproof/scan-history', (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const taskId = typeof req.body?.task_id === 'string' ? req.body.task_id.trim() : '';
    if (!taskId) {
      res.status(400).json({ success: false, error: 'task_id is required' });
      return;
    }
    const rawCount = req.body?.count;
    let count = QUET_DEFAULT_COUNT;
    if (typeof rawCount === 'number' && Number.isFinite(rawCount)) {
      count = Math.floor(rawCount);
    } else if (rawCount !== undefined && rawCount !== null && rawCount !== '') {
      res.status(400).json({ success: false, error: `count must be ${QUET_MIN_COUNT}–${QUET_MAX_COUNT}` });
      return;
    }
    if (count < QUET_MIN_COUNT || count > QUET_MAX_COUNT) {
      res.status(400).json({ success: false, error: `count must be ${QUET_MIN_COUNT}–${QUET_MAX_COUNT}` });
      return;
    }
    count = historyFetchCount(count);
    const replyChatId =
      typeof req.body?.reply_chat_id === 'string' ? req.body.reply_chat_id.trim() : '';
    const result = runtimeOf().enqueueScanHistory(taskId, count, replyChatId);
    res.status(result.httpStatus).json({
      state: result.state,
      error: result.error,
      count: result.count,
      task_id: result.task_id || taskId,
    });
  });

  app.post('/internal/taskproof/maybe-stop', (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const stopped = runtimeOf().maybeStopListening();
    res.json({ success: true, stopped, ...runtimeOf().status() });
  });

  app.post('/internal/taskproof/refresh-members', async (req, res) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const result = await runtimeOf().refreshMappedMembers();
    res.status(result.httpStatus).json({
      success: result.httpStatus < 400,
      refreshed: result.refreshed,
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

/** Railway publishes only PORT. The worker must not listen on a public or private-network address. */
export function requireLoopbackHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value === '127.0.0.1' || value === '::1') return value;
  throw new Error(`task-proof worker must bind loopback, refused "${host}"`);
}

export function startWorkerHttp(
  app: Express = createWorkerApp(),
  port: number = getWorkerPort(),
  host: string = WORKER_BIND_HOST
): Promise<http.Server> {
  let bindHost: string;
  try {
    bindHost = requireLoopbackHost(host);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, bindHost, () => resolve(server));
    server.on('error', reject);
  });
}
