/**
 * imageFetch.ts
 *
 * Tải bytes ảnh từ href, fallback thumb. Không OCR URL sống.
 * Cookie/UA session zca-js chỉ gửi tới host Zalo. Chặn IP nội bộ (SSRF).
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { isBlockedIp } from '../blockedIp';
import { ZcaCredentials } from './session';

export const MAX_PROOF_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

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
  return /(?:^|\.)(?:zadn\.vn|zdn\.vn|zalo(?:cdn)?\.me|zalo\.vn|zaloapp\.com)|photo-|fsh-|za-chat|z-cdn/i.test(
    value
  );
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

export function isZaloMediaHost(hostname: string): boolean {
  const host = (hostname || '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  return (
    host === 'zalo.me' ||
    host === 'zalo.vn' ||
    host.endsWith('.zalo.me') ||
    host.endsWith('.zalo.vn') ||
    host.endsWith('.zalocdn.me') ||
    host.endsWith('.zdn.vn') ||
    host.endsWith('.zadn.vn') ||
    host.endsWith('.zaloapp.com') ||
    host.includes('za-chat') ||
    host.includes('z-cdn') ||
    host.startsWith('photo-') ||
    host.startsWith('fsh-')
  );
}

async function assertPublicHttpUrl(raw: string): Promise<URL | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.replace(/\.$/, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) return null;
    return parsed;
  }
  try {
    const rows = await dns.lookup(host, { all: true });
    const addresses = rows.map((row) => row.address);
    if (!addresses.length || addresses.some((ip) => isBlockedIp(ip))) return null;
  } catch {
    return null;
  }
  return parsed;
}

async function readLimitedBytes(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_PROOF_BYTES) return null;
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PROOF_BYTES) return null;
    return buf;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProofWorker] Đọc bytes ảnh lỗi:', msg);
    return null;
  }
}

export async function downloadImageBytes(
  url: string,
  opts: {
    session?: ZcaCredentials | null;
    cookieHeader?: string;
    userAgent?: string;
    fetchImpl?: typeof fetch;
    lookup?: (hostname: string) => Promise<string[]>;
  } = {}
): Promise<Buffer | null> {
  const trimmed = (url || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (isGifUrl(trimmed)) return null;

  const cookie = opts.cookieHeader || cookieHeaderFromCredentials(opts.session?.cookie);
  const ua = opts.userAgent || opts.session?.userAgent || '';
  const fetchImpl = opts.fetchImpl ?? fetch;

  let current: URL | null;
  if (opts.fetchImpl && !opts.lookup) {
    try {
      current = new URL(trimmed);
    } catch {
      return null;
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
    if (current.username || current.password) return null;
    if (net.isIP(current.hostname) && isBlockedIp(current.hostname)) return null;
  } else {
    current = await assertPublicHttpUrl(trimmed);
    if (!current) {
      console.warn('[TaskProofWorker] Bỏ URL ảnh (SSRF/DNS):', trimmed.slice(0, 160));
    }
  }
  if (!current) return null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { Accept: 'image/*,*/*;q=0.8' };
    if (ua) headers['User-Agent'] = ua;
    if (cookie && isZaloMediaHost(current.hostname)) headers.Cookie = cookie;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(current.href, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] Tải ảnh thất bại:', trimmed.slice(0, 120), msg);
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return null;
      }
      current = await assertPublicHttpUrl(next.href);
      if (!current) {
        console.warn('[TaskProofWorker] Bỏ redirect ảnh (SSRF/DNS):', next.href.slice(0, 160));
        return null;
      }
      continue;
    }

    if (!res.ok) {
      console.warn(
        `[TaskProofWorker] Tải ảnh HTTP ${res.status} host=${current.hostname}`
      );
      return null;
    }
    const buf = await readLimitedBytes(res);
    if (!buf || looksLikeHtmlBuffer(buf) || looksLikeGifBuffer(buf)) {
      console.warn(
        `[TaskProofWorker] Ảnh không dùng được host=${current.hostname} bytes=${buf?.length ?? 0}`
      );
      return null;
    }
    return buf;
  }
  return null;
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
