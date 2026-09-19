/**
 * shortCode.ts
 *
 * Mã task hiện ra cho quản lý: đúng 6 ký tự [A-Z0-9].
 * Không cắt UUID. Tra cứu đúng bằng `WHERE short_code = ?` — không LIKE, không prefix.
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SHORT_CODE_RE = /^[A-Z0-9]{6}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function normalizeShortCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!SHORT_CODE_RE.test(code)) return null;
  return code;
}

export function isExactShortCode(raw: string): boolean {
  return normalizeShortCode(raw) !== null;
}

/**
 * Sinh short_code 6 ký tự từ byte ngẫu nhiên — không lấy uuid.slice(0, 6).
 */
export function generateShortCode(randomBytes: (n: number) => Buffer = crypto.randomBytes): string {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export interface TaskShortCodeRow {
  id: string;
  short_code: string;
  status: string;
  zca_group_id: string | null;
}

/**
 * Resolve đúng mã 6 ký tự. Không khớp prefix UUID / id.
 */
export function getTaskByExactShortCode(
  database: Database.Database,
  rawCode: string
): TaskShortCodeRow | null {
  const shortCode = normalizeShortCode(rawCode);
  if (!shortCode) return null;
  const row = database
    .prepare(
      `SELECT id, short_code, status, zca_group_id FROM tasks WHERE short_code = ?`
    )
    .get(shortCode) as TaskShortCodeRow | undefined;
  return row || null;
}
