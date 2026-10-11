/**
 * imageFetch.ts
 *
 * Tải bytes ảnh từ href, fallback thumb.
 * Cookie/UA session zca-js chỉ gửi tới host Zalo. Chặn IP nội bộ (SSRF).
 */

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { isBlockedIp } from './blockedIp';
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

const ZALO_MEDIA_SUFFIXES = ['zalo.me', 'zalo.vn', 'zalocdn.me', 'zdn.vn', 'zadn.vn', 'zaloapp.com'];

/** Exact host or a subdomain. `photo-` / `za-chat` anywhere in the name is not enough. */
export function isZaloMediaHost(hostname: string): boolean {
  const host = (hostname || '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  return ZALO_MEDIA_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export type PublicLookup = (hostname: string) => Promise<string[]>;

export async function defaultPublicLookup(hostname: string): Promise<string[]> {
  const rows = await dns.lookup(hostname, { all: true });
  return rows.map((row) => row.address);
}

export interface ResolvedPublicUrl {
  url: URL;
  addresses: string[];
}

/** Parse an http(s) URL and keep only addresses that are not private or link-local. */
export async function resolvePublicHttpUrl(
  raw: string,
  lookup: PublicLookup = defaultPublicLookup
): Promise<ResolvedPublicUrl | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.replace(/\.$/, '');
  if (!host) return null;
  if (net.isIP(host)) {
    if (isBlockedIp(host)) return null;
    return { url: parsed, addresses: [host] };
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  if (!addresses.length || addresses.some((ip) => isBlockedIp(ip))) return null;
  return { url: parsed, addresses };
}

/**
 * Connect to the addresses already accepted by resolvePublicHttpUrl.
 * The URL hostname stays on the Host header and on TLS SNI.
 */
export function httpGetPinned(
  target: URL,
  addresses: readonly string[],
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  const usable = addresses.filter((ip) => net.isIP(ip) !== 0);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    if (!usable.length) {
      reject(new Error('no pinned address'));
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      {
        method: 'GET',
        headers,
        lookup: (_hostname, options, callback) => {
          const rows = usable.map((address) => ({
            address,
            family: net.isIP(address) as 4 | 6,
          }));
          if (options.all) {
            callback(null, rows);
            return;
          }
          callback(null, rows[0].address, rows[0].family);
        },
        servername: target.protocol === 'https:' ? target.hostname : undefined,
        signal,
      },
      (incoming) => {
        resolve(incomingToResponse(incoming));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

function looseHttpUrl(raw: string): ResolvedPublicUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (net.isIP(parsed.hostname) && isBlockedIp(parsed.hostname)) return null;
  return { url: parsed, addresses: [] };
}

function incomingToResponse(incoming: http.IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
  return new Response(body, { status: incoming.statusCode || 502, headers });
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // body đã đóng hoặc không phải stream
  }
}

async function readLimitedBytes(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_PROOF_BYTES) {
    console.warn(`[TaskProofWorker] Ảnh vượt ${MAX_PROOF_BYTES} byte, bỏ`);
    await cancelBody(res);
    return null;
  }
  try {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_PROOF_BYTES) {
        console.warn(
          `[TaskProofWorker] Ảnh ${buf.length === 0 ? 'rỗng' : `vượt ${MAX_PROOF_BYTES} byte`}, bỏ`
        );
        return null;
      }
      return buf;
    }
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_PROOF_BYTES) {
        console.warn(`[TaskProofWorker] Ảnh vượt ${MAX_PROOF_BYTES} byte, dừng đọc`);
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    if (total === 0) {
      console.warn('[TaskProofWorker] Ảnh rỗng, bỏ');
      return null;
    }
    return Buffer.concat(chunks, total);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProofWorker] Đọc bytes ảnh lỗi:', msg);
    await cancelBody(res);
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
  const fetchImpl = opts.fetchImpl;
  const lookup = opts.lookup ?? defaultPublicLookup;

  let current: ResolvedPublicUrl | null;
  if (fetchImpl && !opts.lookup) {
    current = looseHttpUrl(trimmed);
  } else {
    current = await resolvePublicHttpUrl(trimmed, lookup);
    if (!current) {
      console.warn('[TaskProofWorker] Bỏ URL ảnh (SSRF/DNS):', trimmed.slice(0, 160));
    }
  }
  if (!current) return null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { Accept: 'image/*,*/*;q=0.8' };
    if (ua) headers['User-Agent'] = ua;
    if (cookie && isZaloMediaHost(current.url.hostname)) headers.Cookie = cookie;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = fetchImpl
        ? await fetchImpl(current.url.href, {
            headers,
            redirect: 'manual',
            signal: controller.signal,
          })
        : await httpGetPinned(current.url, current.addresses, headers, controller.signal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] Tải ảnh thất bại:', trimmed.slice(0, 120), msg);
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      await cancelBody(res);
      const location = res.headers.get('location');
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, current.url);
      } catch {
        return null;
      }
      current = await resolvePublicHttpUrl(next.href, lookup);
      if (!current) {
        console.warn('[TaskProofWorker] Bỏ redirect ảnh (SSRF/DNS):', next.href.slice(0, 160));
        return null;
      }
      continue;
    }

    if (!res.ok) {
      await cancelBody(res);
      console.warn(
        `[TaskProofWorker] Tải ảnh HTTP ${res.status} host=${current.url.hostname}`
      );
      return null;
    }
    const buf = await readLimitedBytes(res);
    if (!buf) return null;
    if (looksLikeHtmlBuffer(buf) || looksLikeGifBuffer(buf)) {
      console.warn(
        `[TaskProofWorker] Ảnh không dùng được host=${current.url.hostname} bytes=${buf.length}`
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
