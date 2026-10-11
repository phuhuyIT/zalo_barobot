/**
 * internalAuth.ts
 *
 * Process APIs: header x-internal-key hoặc Bearer — không nhận ?key=
 * (INTERNAL_API_KEY không được lộ trên URL public).
 * File/QR public: HMAC ?exp=&sig= (TTL ngắn), secret vẫn là INTERNAL_API_KEY.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { getInternalApiKey, PROOF_URL_TTL_MS, QR_URL_TTL_MS } from '../env';

export { PROOF_URL_TTL_MS, QR_URL_TTL_MS };

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function firstString(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}

/** Header / Bearer only — dùng cho worker ↔ bot. */
export function readInternalKeyFromHeader(req: Request): string {
  const headerKey = req.headers['x-internal-key'];
  const bearer =
    typeof req.headers.authorization === 'string'
      ? req.headers.authorization.replace(/^Bearer\s+/i, '')
      : undefined;
  return firstString(headerKey || bearer);
}

/**
 * Railway cron vẫn có thể gửi ?key=. Không dùng cho QR/file public.
 */
export function readInternalKey(req: Request): string {
  return readInternalKeyFromHeader(req) || firstString(req.query.key);
}

function signPath(pathname: string, expMs: number, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${pathname}\n${expMs}`).digest('hex');
}

export function buildSignedQuery(
  pathname: string,
  ttlMs: number,
  now: number = Date.now()
): { exp: number; sig: string } {
  const secret = getInternalApiKey();
  const exp = now + ttlMs;
  return { exp, sig: signPath(pathname, exp, secret) };
}

export function signedQueryString(pathname: string, ttlMs: number, now: number = Date.now()): string {
  const { exp, sig } = buildSignedQuery(pathname, ttlMs, now);
  return `exp=${exp}&sig=${sig}`;
}

export function verifySignedQuery(
  pathname: string,
  expRaw: unknown,
  sigRaw: unknown,
  now: number = Date.now()
): boolean {
  const secret = getInternalApiKey();
  if (!secret) return false;
  const exp = typeof expRaw === 'string' || typeof expRaw === 'number' ? Number(expRaw) : NaN;
  const sig = firstString(sigRaw);
  if (!sig || !Number.isFinite(exp) || exp <= now) return false;
  const expected = signPath(pathname, exp, secret);
  return timingSafeCompare(sig, expected);
}

/**
 * Trả true nếu request đã bị từ chối (caller phải return ngay).
 * Chỉ header / Bearer — không nhận ?key=.
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

  const received = readInternalKeyFromHeader(req);
  if (!received || !timingSafeCompare(received, expected)) {
    res.status(403).json({ success: false, error: 'Unauthorized internal API key' });
    return true;
  }
  return false;
}

/** GET QR / proof: HMAC ?exp=&sig=, hết hạn thì 403. */
export function rejectIfInvalidSignedFileUrl(req: Request, res: Response): boolean {
  const pathname = req.path || '';
  if (!verifySignedQuery(pathname, req.query.exp, req.query.sig)) {
    res.status(403).json({ success: false, error: 'Unauthorized or expired file token' });
    return true;
  }
  return false;
}
