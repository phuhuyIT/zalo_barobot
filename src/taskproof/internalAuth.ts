/**
 * internalAuth.ts
 *
 * Cùng kiểu token với /internal/run-due-jobs: header x-internal-key
 * (hoặc Bearer / ?key=). Dùng INTERNAL_API_KEY — không tạo tên mới.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { getInternalApiKey } from './env';

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function readInternalKey(req: Request): string {
  const headerKey = req.headers['x-internal-key'];
  const bearer =
    typeof req.headers.authorization === 'string'
      ? req.headers.authorization.replace(/^Bearer\s+/i, '')
      : undefined;
  const queryKey = req.query.key;
  const raw = headerKey || bearer || queryKey;

  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}

/**
 * Trả true nếu request đã bị từ chối (caller phải return ngay).
 */
export function rejectIfInvalidInternalKey(req: Request, res: Response): boolean {
  const expected = getInternalApiKey();
  if (!expected) {
    res.status(403).json({
      success: false,
      error: 'INTERNAL_API_KEY is not configured on the server.',
    });
    return true;
  }

  const received = readInternalKey(req);
  if (!received || !timingSafeCompare(received, expected)) {
    res.status(403).json({ success: false, error: 'Unauthorized internal API key' });
    return true;
  }
  return false;
}
