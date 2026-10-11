import { describe, expect, it } from 'vitest';
import { firstFacebookPostUrl, parseFacebookPostUrl } from '../../src/taskproof/commands/facebookUrl';

const FB_SHARE = 'https://www.facebook.com/share/v/1FS7f9MknZ/';

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
});
