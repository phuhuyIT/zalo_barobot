import { describe, expect, it } from 'vitest';
import { sniffImageKind } from '../../src/taskproof/imageKind';

describe('image kind sniff', () => {
  it('accepts jpeg, png, and webp magic bytes', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    expect(sniffImageKind(png)).toBe('png');
    expect(sniffImageKind(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('jpeg');
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(sniffImageKind(webp)).toBe('webp');
    expect(sniffImageKind(Buffer.from('GIF89a'))).toBeNull();
  });
});
