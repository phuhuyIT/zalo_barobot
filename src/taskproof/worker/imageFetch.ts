/**
 * imageFetch.ts
 *
 * Tải bytes ảnh từ href, fallback thumb. Không OCR URL sống.
 * Gửi cookie/UA session zca-js khi URL Zalo cần đăng nhập.
 */

import { ZcaCredentials } from './session';

export const MAX_PROOF_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export function cookieHeaderFromCredentials(cookie: unknown): string {
  if (!cookie) return '';
  if (typeof cookie === 'string') return cookie;
  if (Array.isArray(cookie)) {
    return cookie
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const rec = entry as { name?: unknown; value?: unknown; key?: unknown };
        const name = typeof rec.name === 'string' ? rec.name : typeof rec.key === 'string' ? rec.key : '';
        const value = typeof rec.value === 'string' ? rec.value : '';
        if (!name) return '';
        return `${name}=${value}`;
      })
      .filter(Boolean)
      .join('; ');
  }
  if (typeof cookie === 'object' && Array.isArray((cookie as { cookies?: unknown }).cookies)) {
    return cookieHeaderFromCredentials((cookie as { cookies: unknown[] }).cookies);
  }
  return '';
}

export function isGifUrl(url: string): boolean {
  return /\.gif(\?|#|$)/i.test(url.trim());
}

export function isImageHref(url: string): boolean {
  const value = (url || '').trim();
  if (!value) return false;
  if (/\.(?:jpe?g|png|webp|bmp)(?:[?#]|$)/i.test(value)) return true;
  return /(?:^|\.)(?:zdn\.vn|zalo(?:cdn)?\.me)|photo-stal-|fsh-|za-chat/i.test(value);
}

export function looksLikeGifBuffer(buf: Buffer): boolean {
  if (buf.length < 6) return false;
  const mag = buf.subarray(0, 6).toString('ascii');
  return mag === 'GIF87a' || mag === 'GIF89a';
}

export function looksLikeHtmlBuffer(buf: Buffer): boolean {
  const head = buf.subarray(0, 256).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

export async function downloadImageBytes(
  url: string,
  opts: {
    session?: ZcaCredentials | null;
    cookieHeader?: string;
    userAgent?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<Buffer | null> {
  const trimmed = (url || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (isGifUrl(trimmed)) return null;

  const headers: Record<string, string> = {
    Accept: 'image/*,*/*;q=0.8',
  };
  const cookie =
    opts.cookieHeader || cookieHeaderFromCredentials(opts.session?.cookie);
  if (cookie) headers.Cookie = cookie;
  const ua = opts.userAgent || opts.session?.userAgent || '';
  if (ua) headers['User-Agent'] = ua;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(trimmed, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PROOF_BYTES) return null;
    if (looksLikeHtmlBuffer(buf) || looksLikeGifBuffer(buf)) return null;
    return buf;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProofWorker] Tải ảnh thất bại:', trimmed.slice(0, 120), msg);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadProofBytes(
  href: string | undefined,
  thumb: string | undefined,
  opts: {
    session?: ZcaCredentials | null;
    download?: (url: string) => Promise<Buffer | null>;
  } = {}
): Promise<{ buffer: Buffer; sourceUrl: string } | null> {
  const download = opts.download ?? ((url: string) => downloadImageBytes(url, { session: opts.session }));
  for (const url of [href, thumb]) {
    const trimmed = (url || '').trim();
    if (!trimmed || isGifUrl(trimmed)) continue;
    const buffer = await download(trimmed);
    if (buffer && buffer.length > 0) return { buffer, sourceUrl: trimmed };
  }
  return null;
}
