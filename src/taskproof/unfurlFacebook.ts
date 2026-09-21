/**
 * unfurlFacebook.ts
 *
 * HTTP GET permalink Facebook trên official bot, lấy caption preview.
 * Không JS, không login, không Graph API, không Playwright.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { isFacebookRedirectHost, parseHttpUrl } from './facebookUrl';

export const UNFURL_USER_AGENTS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'WhatsApp/2.23.18.78 A',
  'TelegramBot (like TwitterBot)',
] as const;

export const UNFURL_TIMEOUT_MS = 15_000;
export const UNFURL_MAX_REDIRECTS = 5;
export const UNFURL_HTML_LIMIT = 512 * 1024;
export const MIN_CAPTION_CHARS = 20;
export const MIN_CAPTION_WORDS = 4;

export type CaptionSource = 'og:description' | 'title' | 'og:title';

export type UnfurlFacebookResult =
  | { ok: true; caption: string; canonicalUrl: string; source: CaptionSource }
  | { ok: false };

export type LookupFn = (hostname: string) => Promise<string[]>;
export type FetchFn = typeof fetch;

export interface UnfurlFacebookDeps {
  fetchImpl?: FetchFn;
  lookup?: LookupFn;
  now?: () => number;
}

const GARBAGE_CAPTIONS = [
  'log in or sign up to view',
  'see posts, photos and more on facebook.',
];

function defaultLookup(hostname: string): Promise<string[]> {
  return dns.lookup(hostname, { all: true }).then((rows) => rows.map((row) => row.address));
}

export function isBlockedIp(ip: string): boolean {
  const value = (ip || '').trim().toLowerCase();
  if (!value) return true;

  if (value.startsWith('::ffff:')) {
    return isBlockedIp(value.slice(7));
  }

  const v4 = net.isIP(value);
  if (v4 === 4) {
    const parts = value.split('.').map((item) => Number(item));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (v4 === 6) {
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fe80:')) return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    return false;
  }

  return true;
}

export function unescapeHtml(raw: string): string {
  return (raw || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function attrContent(tag: string): string {
  const named = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (!named) return '';
  return unescapeHtml(named[2] ?? named[3] ?? '');
}

function metaProperty(html: string, property: string): string {
  const re = new RegExp(`<meta\\b[^>]*>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const prop = tag.match(/\b(?:property|name)\s*=\s*("([^"]*)"|'([^']*)')/i);
    const value = (prop?.[2] ?? prop?.[3] ?? '').trim();
    if (value.toLowerCase() === property.toLowerCase()) {
      return attrContent(tag);
    }
  }
  return '';
}

function extractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return unescapeHtml(match[1].replace(/<[^>]+>/g, ' '));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function isGarbageCaption(text: string): boolean {
  const value = unescapeHtml(text);
  if (!value) return true;
  const lower = value.toLowerCase();
  if (GARBAGE_CAPTIONS.some((item) => lower.includes(item))) return true;
  if (lower === 'facebook') return true;
  if (value.length < MIN_CAPTION_CHARS) return true;
  if (wordCount(value) < MIN_CAPTION_WORDS) return true;
  return false;
}

export function extractCaptionFromHtml(html: string): { caption: string; source: CaptionSource } | null {
  const ogDescription = metaProperty(html, 'og:description');
  const ogTitle = metaProperty(html, 'og:title');
  let title = extractTitle(html);
  if (ogTitle && title) {
    const suffix = new RegExp(`\\s*[-–—]\\s*${escapeRegExp(ogTitle)}\\s*$`, 'i');
    title = title.replace(suffix, '').trim();
  }

  if (ogDescription && !isGarbageCaption(ogDescription)) {
    return { caption: ogDescription, source: 'og:description' };
  }
  if (title && title.toLowerCase() !== 'facebook' && !isGarbageCaption(title)) {
    return { caption: title, source: 'title' };
  }
  if (ogTitle && !isGarbageCaption(ogTitle)) {
    return { caption: ogTitle, source: 'og:title' };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertSafeHop(url: URL, lookup: LookupFn): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!isFacebookRedirectHost(host)) return false;
  if (net.isIP(host) && isBlockedIp(host)) return false;
  try {
    const addresses = await lookup(host);
    if (!addresses.length) return false;
    if (addresses.some((ip) => isBlockedIp(ip))) return false;
    return true;
  } catch {
    return false;
  }
}

async function readLimitedHtml(res: Response): Promise<string> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, UNFURL_HTML_LIMIT).toString('utf8');
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < UNFURL_HTML_LIMIT) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    .subarray(0, UNFURL_HTML_LIMIT)
    .toString('utf8');
}

async function fetchHtml(
  startUrl: string,
  userAgent: string,
  deps: UnfurlFacebookDeps
): Promise<{ url: string; html: string } | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  let current = parseHttpUrl(startUrl);
  if (!current) return null;

  for (let hop = 0; hop <= UNFURL_MAX_REDIRECTS; hop++) {
    const safe = await assertSafeHop(current, lookup);
    if (!safe) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UNFURL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': userAgent,
        },
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
      continue;
    }

    if (!res.ok) return null;
    const html = await readLimitedHtml(res);
    return { url: current.href, html };
  }

  return null;
}

export async function unfurlFacebookPost(
  inputUrl: string,
  deps: UnfurlFacebookDeps = {}
): Promise<UnfurlFacebookResult> {
  for (const userAgent of UNFURL_USER_AGENTS) {
    const page = await fetchHtml(inputUrl, userAgent, deps);
    if (!page) continue;
    const parsed = extractCaptionFromHtml(page.html);
    if (!parsed) continue;
    const canonical =
      metaProperty(page.html, 'og:url') || page.url || inputUrl;
    return {
      ok: true,
      caption: parsed.caption,
      canonicalUrl: canonical,
      source: parsed.source,
    };
  }
  return { ok: false };
}
