/**
 * facebookUrl.ts
 *
 * Nhận diện permalink Facebook trên lệnh /task.
 */

const INPUT_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'fb.com',
  'www.fb.com',
  'fb.watch',
  'www.fb.watch',
]);

const URL_RE = /https?:\/\/[^\s<>"'\\]+/gi;

export function stripTrailingUrlJunk(raw: string): string {
  return (raw || '').trim().replace(/[),.;]+$/, '');
}

export function collectHttpUrlsFromText(text: string): string[] {
  const matches = (text || '').match(URL_RE);
  if (!matches) return [];
  return matches.map(stripTrailingUrlJunk).filter(Boolean);
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/\.$/, '').toLowerCase();
}

export function isFacebookInputHost(host: string): boolean {
  return INPUT_HOSTS.has(host.replace(/\.$/, '').toLowerCase());
}

export function isAcceptedFacebookPath(pathname: string, host: string): boolean {
  const h = host.replace(/\.$/, '').toLowerCase();
  if (h === 'fb.watch' || h === 'www.fb.watch') {
    return Boolean(pathname && pathname !== '/');
  }
  const p = (pathname || '').toLowerCase();
  if (p.includes('/posts/')) return true;
  if (p.includes('/permalink.php')) return true;
  if (p.includes('/photo.php')) return true;
  if (p.includes('/reel/') || p.includes('/reels/')) return true;
  if (p === '/watch' || p.startsWith('/watch/') || p.startsWith('/watch?')) return true;
  if (p.includes('/share/p/') || p.includes('/share/v/')) return true;
  return false;
}

export function parseHttpUrl(raw: string): URL | null {
  const trimmed = stripTrailingUrlJunk(raw);
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

export function parseFacebookPostUrl(raw: string): URL | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const host = hostnameOf(url);
  if (!isFacebookInputHost(host)) return null;
  if (!isAcceptedFacebookPath(url.pathname, host)) return null;
  return url;
}

export function firstFacebookPostUrl(text: string): string {
  for (const candidate of collectHttpUrlsFromText(text)) {
    const parsed = parseFacebookPostUrl(candidate);
    if (parsed) return parsed.href;
  }
  return '';
}
