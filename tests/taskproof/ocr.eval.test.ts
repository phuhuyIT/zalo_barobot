import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_OCR_MATCH_THRESHOLD, matchText } from '../../src/taskproof/worker/match';
import { ocrImage, terminateOcrWorker } from '../../src/taskproof/worker/ocr';

const EVAL_DIR = path.resolve(__dirname, '../eval_datasets');

/** Caption đầy đủ của bài Facebook trong bộ eval (mobile cắt "... Xem thêm"). */
const REFERENCE_CAPTION =
  'BỘ TƯ LỆNH THÀNH PHỐ: CỤM THI ĐUA SỐ 13 KHỞI CÔNG "NHÀ TÌNH NGHĨA QUÂN – DÂN" NĂM 2026';

const UNRELATED_CAPTION = 'Báo cáo tuần họp tổ dân phố khu phố 3';

function listEvalPngs(): string[] {
  return fs
    .readdirSync(EVAL_DIR)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
}

describe('task-proof OCR eval (Step 4, before Zalo wiring)', () => {
  afterAll(async () => {
    await terminateOcrWorker();
  });

  it('OCRs every PNG in tests/eval_datasets/ and matches the post caption', async () => {
    const files = listEvalPngs();
    expect(files.length).toBeGreaterThanOrEqual(12);

    const failures: Array<{ file: string; score: number; type: string; snippet: string }> = [];

    for (const file of files) {
      const buf = fs.readFileSync(path.join(EVAL_DIR, file));
      const ocrText = await ocrImage(buf);
      const result = matchText(ocrText, REFERENCE_CAPTION);
      if (!result.isMatch) {
        failures.push({
          file,
          score: result.score,
          type: result.matchType,
          snippet: (ocrText || '').replace(/\s+/g, ' ').slice(0, 240),
        });
      }
    }

    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }, 300_000);

  it('does not match an unrelated caption on a sample screenshot', async () => {
    const sample = path.join(EVAL_DIR, 'image.png');
    const ocrText = await ocrImage(fs.readFileSync(sample));
    const result = matchText(ocrText, UNRELATED_CAPTION);
    expect(result.isMatch).toBe(false);
    expect(result.score).toBeLessThan(DEFAULT_OCR_MATCH_THRESHOLD);
  }, 60_000);
});
