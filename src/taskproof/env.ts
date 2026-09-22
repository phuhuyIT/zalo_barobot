/**
 * env.ts
 *
 * Đọc biến môi trường task-proof.
 * Tên biến đã khóa (Section 0.2 / 5.1): không đổi INTERNAL_API_KEY /
 * ADMIN_USERNAME / ADMIN_PASSWORD.
 * PUBLIC_BASE_URL không có trailing slash — Zalo fetch sendPhoto từ đây.
 */

import crypto from 'crypto';
import path from 'path';

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

export function getPublicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
}

export function getSessionFilePath(): string {
  const fromEnv = (process.env.ZCA_SESSION_FILE_PATH || '').trim();
  return fromEnv || path.resolve(process.cwd(), 'data/zca-session.json');
}

export function getProofDir(): string {
  const fromEnv = (process.env.PROOF_DIR || '').trim();
  return fromEnv || path.resolve(process.cwd(), 'data/proofs');
}

/** QR tạm: /data/qr-tmp cạnh session, hoặc QR_TMP_DIR. */
export function getQrTmpDir(): string {
  const fromEnv = (process.env.QR_TMP_DIR || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(path.dirname(getSessionFilePath()), 'qr-tmp');
}

export function getOfficialBotOrigin(): string {
  return `http://127.0.0.1:${getOfficialBotPort()}`;
}

export function getWorkerOrigin(): string {
  return `http://${WORKER_BIND_HOST}:${getWorkerPort()}`;
}

/** QR public URL sống 10 phút; proof URL sống 2 giờ. */
export const QR_URL_TTL_MS = 10 * 60 * 1000;
export const PROOF_URL_TTL_MS = 2 * 60 * 60 * 1000;

export function buildTokenGatedUrl(pathname: string, ttlMs: number = PROOF_URL_TTL_MS): string {
  const base = getPublicBaseUrl();
  const secret = getInternalApiKey();
  const cleaned = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (!base || !secret) return '';
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret).update(`${cleaned}\n${exp}`).digest('hex');
  return `${base}${cleaned}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}
