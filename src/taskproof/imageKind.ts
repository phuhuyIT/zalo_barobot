/**
 * imageKind.ts
 *
 * Ảnh đưa vào OCR thử trên Web UI: cùng loại byte mà /quet và proof ingest
 * đưa cho Tesseract (JPEG, PNG, WebP). GIF và HEIC không đi vào ocrImage.
 */

import { NextFunction, Request, Response } from 'express';
import express from 'express';

export const OCR_DEBUG_MAX_BYTES = 12 * 1024 * 1024;

export type ImageKind = 'jpeg' | 'png' | 'webp';

export function sniffImageKind(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

const parseDebugImageBody = express.raw({
  type: () => true,
  limit: OCR_DEBUG_MAX_BYTES,
});

/** Body ảnh thô. Quá 12MB thì JSON 413, không để Express trả HTML. */
export function debugImageParser(req: Request, res: Response, next: NextFunction): void {
  parseDebugImageBody(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const status =
      typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 400;
    const tooBig = status === 413;
    res.status(tooBig ? 413 : 400).json({
      success: false,
      error: tooBig ? 'Ảnh lớn hơn 12MB' : 'Không đọc được ảnh',
    });
  });
}
