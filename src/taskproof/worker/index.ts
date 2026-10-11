/**
 * worker/index.ts
 *
 * Tiến trình 2: task-proof worker (zca-js login / QR ở Step 5).
 * Bind 127.0.0.1:TASKPROOF_WORKER_PORT.
 * Không CREATE TABLE — chỉ kiểm tra bảng đã có rồi mới listen.
 */

import dotenv from 'dotenv';
import { getWorkerPort, WORKER_BIND_HOST } from '../env';
import { closeWorkerDatabase, getWorkerDatabase } from '../records/store';
import { stopImageMatcher } from './imageMatch';
import { createWorkerApp, startWorkerHttp } from './http';
dotenv.config();
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

try {
  getWorkerDatabase();
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[TaskProofWorker] Từ chối start — bảng task-proof chưa sẵn sàng:', msg);
  process.exit(1);
}

const port = getWorkerPort();

void startWorkerHttp(createWorkerApp(), port, WORKER_BIND_HOST)
  .then((server) => {
    console.log(`[TaskProofWorker] Đang lắng nghe ${WORKER_BIND_HOST}:${port} (không public)`);

    const handleShutdown = (signal: string) => {
      console.log(`[TaskProofWorker] Nhận ${signal}, đang đóng...`);
      const force = setTimeout(() => {
        console.error('[TaskProofWorker] Hết thời gian shutdown — thoát cứng.');
        process.exit(1);
      }, 8_000);
      if (typeof force.unref === 'function') force.unref();
      server.close(() => {
        void stopImageMatcher().finally(() => {
          closeWorkerDatabase();
          clearTimeout(force);
          process.exit(0);
        });
      });
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProofWorker] Không khởi động được HTTP server:', msg);
    closeWorkerDatabase();
    process.exit(1);
  });
