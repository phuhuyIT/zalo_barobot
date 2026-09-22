/**
 * Zalo sendPhoto fetches the proof URL itself. Phone photos (large JPEG,
 * progressive JPEG, WebP, PNG labeled .jpg) decode as an empty bubble.
 * Re-encode to a small baseline JPEG before the response is sent.
 */

import sharp from 'sharp';

/** Longest side Zalo's fetcher reliably displays. */
const MAX_EDGE = 1280;

export async function toReportJpeg(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { failOn: 'none', animated: false })
    .rotate()
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 80, progressive: false, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}
