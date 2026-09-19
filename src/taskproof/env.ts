/**
 * env.ts
 *
 * Đọc biến môi trường task-proof.
 * Tên biến đã khóa (Section 0.2 / 5.1): không đổi INTERNAL_API_KEY /
 * ADMIN_USERNAME / ADMIN_PASSWORD.
 */

/** Worker chỉ bind localhost — user không bao giờ mở cổng 3001. */
export const WORKER_BIND_HOST = '127.0.0.1';

export function getWorkerPort(): number {
  const parsed = parseInt(process.env.TASKPROOF_WORKER_PORT || '3001', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3001;
}

export function getOfficialBotPort(): number {
  const parsed = parseInt(process.env.PORT || '3000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

export function getInternalApiKey(): string {
  return (process.env.INTERNAL_API_KEY || '').trim();
}
