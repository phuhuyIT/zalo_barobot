import { describe, expect, it, vi } from 'vitest';
import {
  firstFacebookPostUrl,
  isFacebookRedirectHost,
  parseFacebookPostUrl,
} from '../../src/taskproof/facebookUrl';
import {
  extractCaptionFromHtml,
  isBlockedIp,
  isGarbageCaption,
  unfurlFacebookPost,
} from '../../src/taskproof/unfurlFacebook';

const PUBLIC_IP = '157.240.22.35';
const FB_SHARE = 'https://www.facebook.com/share/v/1FS7f9MknZ/';
const FB_POST = 'https://www.facebook.com/page/posts/123456789';

const CLEAN_HTML = `<!DOCTYPE html><html><head>
<meta property="og:description" content="Lydia Hallie, kỹ sư tại Anthropic đã dành ra khoảng 1 giờ để chia sẻ về cách xây dựng một team AI Agent với Loops và Graphs." />
<meta property="og:title" content="127K views | Reel by Việt Nguyễn AI" />
<meta property="og:url" content="${FB_POST}" />
<title>Lydia Hallie, kỹ sư tại Anthropic đã dành ra khoảng 1 giờ - 127K views | Reel by Việt Nguyễn AI</title>
</head><body></body></html>`;

const LOGIN_HTML = `<!DOCTYPE html><html><head>
<meta property="og:description" content="Log in or sign up to view" />
<title>Facebook</title>
</head></html>`;

const TITLE_ONLY_HTML = `<!DOCTYPE html><html><head>
<title>Bộ tư lệnh thành phố cụm thi đua khởi công nhà tình nghĩa quân dân năm 2026</title>
</head></html>`;

const SHORT_HTML = `<!DOCTYPE html><html><head>
<meta property="og:description" content="quá ngắn" />
<title>Facebook</title>
</head></html>`;

function lookupPublic(): Promise<string[]> {
  return Promise.resolve([PUBLIC_IP]);
}

describe('facebook URL parser', () => {
  it('finds the first Facebook permalink stuck in other text', () => {
    const text = 'xem /task gấp https://example.com/x rồi https://www.facebook.com/share/v/1FS7f9MknZ/ nhé';
    expect(firstFacebookPostUrl(text)).toBe(FB_SHARE);
    expect(parseFacebookPostUrl('https://m.facebook.com/page/posts/99')?.host).toBe('m.facebook.com');
    expect(parseFacebookPostUrl('https://www.facebook.com/reel/1172205942011624/')).toBeTruthy();
    expect(parseFacebookPostUrl('https://fb.watch/AbCdEfGh/')).toBeTruthy();
    expect(parseFacebookPostUrl('https://example.com/share/v/1FS7f9MknZ/')).toBeNull();
    expect(parseFacebookPostUrl('https://www.facebook.com/profile.php?id=1')).toBeNull();
  });

  it('allows Facebook redirect hosts but not other hosts', () => {
    expect(isFacebookRedirectHost('lm.facebook.com')).toBe(true);
    expect(isFacebookRedirectHost('l.facebook.com')).toBe(true);
    expect(isFacebookRedirectHost('evil.com')).toBe(false);
    expect(isFacebookRedirectHost('facebook.com.evil.com')).toBe(false);
  });
});

describe('caption HTML fixtures', () => {
  it('prefers og:description and rejects login-wall / short / Facebook title', () => {
    const clean = extractCaptionFromHtml(CLEAN_HTML);
    expect(clean?.source).toBe('og:description');
    expect(clean?.caption).toMatch(/Lydia Hallie/);

    const titled = extractCaptionFromHtml(TITLE_ONLY_HTML);
    expect(titled?.source).toBe('title');
    expect(titled?.caption).toMatch(/Bộ tư lệnh/i);

    expect(extractCaptionFromHtml(LOGIN_HTML)).toBeNull();
    expect(extractCaptionFromHtml(SHORT_HTML)).toBeNull();
    expect(isGarbageCaption('See posts, photos and more on Facebook.')).toBe(true);
    expect(isGarbageCaption('Facebook')).toBe(true);
  });
});

describe('SSRF / redirect allowlist', () => {
  it('blocks private and link-local IPs', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.5')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('172.16.0.1')).toBe(true);
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp(PUBLIC_IP)).toBe(false);
  });

  it('refuses a hop that resolves to a private IP', async () => {
    const result = await unfurlFacebookPost(FB_SHARE, {
      lookup: async () => ['127.0.0.1'],
      fetchImpl: vi.fn(),
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a redirect off the Facebook allowlist', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1/steal' } })
    );
    const result = await unfurlFacebookPost(FB_SHARE, {
      lookup: lookupPublic,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
  });

  it('follows an allowlisted redirect then reads og:description', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { location: 'https://lm.facebook.com/l.php?u=1' },
        })
      )
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { location: FB_POST },
        })
      )
      .mockResolvedValueOnce(new Response(CLEAN_HTML, { status: 200 }));

    const result = await unfurlFacebookPost(FB_SHARE, {
      lookup: lookupPublic,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('og:description');
      expect(result.canonicalUrl).toBe(FB_POST);
      expect(result.caption).toMatch(/Lydia Hallie/);
    }
  });

  it('does not create a caption from a login wall', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(LOGIN_HTML, { status: 200 }));
    const result = await unfurlFacebookPost(FB_POST, {
      lookup: lookupPublic,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
  });
});
