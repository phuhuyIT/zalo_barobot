/**
 * session.ts
 *
 * Lưu cookie / imei / user-agent sau login QR hoặc session (T8).
 * Thử file session trước; chỉ QR khi file hỏng / login fail.
 * Không tự retry QR sau lần quét thất bại.
 */

import fs from 'fs';
import path from 'path';
import { getSessionFilePath } from '../env';

export interface ZcaCredentials {
  cookie: unknown;
  imei: string;
  userAgent: string;
}

export function isValidCredentials(value: unknown): value is ZcaCredentials {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return Boolean(rec.cookie) && typeof rec.imei === 'string' && typeof rec.userAgent === 'string';
}

export function loadSession(filePath: string = getSessionFilePath()): ZcaCredentials | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isValidCredentials(parsed) ? parsed : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProofWorker] Không đọc được session file:', msg);
    return null;
  }
}

export function saveSession(creds: ZcaCredentials, filePath: string = getSessionFilePath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), 'utf8');
}

export function deleteSession(filePath: string = getSessionFilePath()): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort
  }
}
