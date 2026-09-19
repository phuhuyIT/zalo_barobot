import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OCR_MATCH_THRESHOLD,
  PREFIX_MATCH_SCORE,
  matchText,
  normalizeText,
  pickBestMatch,
  prefixTokenRange,
} from '../../src/taskproof/worker/match';

const CAPTION =
  'BỘ TƯ LỆNH THÀNH PHỐ: CỤM THI ĐUA SỐ 13 KHỞI CÔNG "NHÀ TÌNH NGHĨA QUÂN – DÂN" NĂM 2026';

const CHROME = `Zalo
Quản lý bài viết
BÌNH DƯƠNG QUÊ TÔI
Trang chủ Reels Bạn bè Thông báo`;

describe('task-proof match (Step 4)', () => {
  describe('normalizeText', () => {
    it('strips Vietnamese diacritics including đ/Đ and lowercases', () => {
      expect(normalizeText('Nhà tình nghĩa quân – dân')).toBe('nha tinh nghia quan dan');
      expect(normalizeText('ĐUA')).toBe('dua');
      expect(normalizeText('đua')).toBe('dua');
    });

    it('collapses punctuation so caption punctuation does not penalize', () => {
      expect(normalizeText('KHỞI CÔNG "NHÀ TÌNH" NĂM 2026')).toBe('khoi cong nha tinh nam 2026');
      expect(normalizeText('thành phố: cụm thi đua')).toBe('thanh pho cum thi dua');
    });
  });

  describe('four match tiers', () => {
    it('tier 1: exact substring after normalize → 1.0 and stops', () => {
      const ocr = `${CHROME}\n${CAPTION}\nXem thêm`;
      const result = matchText(ocr, CAPTION);
      expect(result.matchType).toBe('exact');
      expect(result.score).toBe(1);
      expect(result.isMatch).toBe(true);
    });

    it('tier 1 is case- and punctuation-insensitive', () => {
      const result = matchText(
        'bo tu lenh thanh pho: cum thi dua so 13 khoi cong nha tinh nghia quan dan nam 2026',
        CAPTION
      );
      expect(result.matchType).toBe('exact');
      expect(result.score).toBe(1);
    });

    it('tier 2: Dice on a short noisy caption (no exact, no prefix)', () => {
      const result = matchText('bao cao tuan hap', 'Báo cáo tuần họp');
      expect(result.matchType).toBe('dice_full');
      expect(result.score).toBeGreaterThanOrEqual(DEFAULT_OCR_MATCH_THRESHOLD);
      expect(result.isMatch).toBe(true);
    });

    it('tier 2: Dice per line beats chrome-heavy full text', () => {
      const ocr = [
        CHROME,
        CHROME,
        'BỘ TƯ LỆNH THÀNH PHỐ CỤM THI ĐUA SỐ 13 KHỞI CÔNG NHÀ TÌNH NGHĨA QUÂN DÂN NĂM 2025',
        CHROME,
      ].join('\n');
      const result = matchText(ocr, CAPTION);
      expect(['dice_line', 'sliding_window']).toContain(result.matchType);
      expect(result.score).toBeGreaterThanOrEqual(DEFAULT_OCR_MATCH_THRESHOLD);
      expect(result.isMatch).toBe(true);
    });

    it('tier 2: unrelated chrome scores below threshold', () => {
      const result = matchText(CHROME, CAPTION);
      expect(result.score).toBeLessThan(DEFAULT_OCR_MATCH_THRESHOLD);
      expect(result.isMatch).toBe(false);
    });

    it('tier 3: sliding window isolates a caption buried in UI chrome', () => {
      const buried = [
        CHROME,
        CHROME,
        'CỤM THI ĐUA SỐ 13 KHỞI CÔNG NHÀ TÌNH NGHĨA QUÂN DÂN NĂM 2026',
        CHROME,
      ].join(' ');
      const result = matchText(buried, CAPTION);
      expect(result.matchType).toBe('sliding_window');
      expect(result.score).toBeGreaterThanOrEqual(DEFAULT_OCR_MATCH_THRESHOLD);
      expect(result.isMatch).toBe(true);
    });

    it('tier 4: prefix (~50–70%) scores 0.95 for mobile See-more truncation', () => {
      const range = prefixTokenRange(normalizeText(CAPTION).split(' ').length);
      expect(range).not.toBeNull();
      const tokens = normalizeText(CAPTION).split(' ');
      const prefix = tokens.slice(0, Math.ceil(tokens.length * 0.5)).join(' ');
      const ocr = `${CHROME} ${prefix} xem them`;
      const result = matchText(ocr, CAPTION);
      expect(result.matchType).toBe('prefix');
      expect(result.score).toBe(PREFIX_MATCH_SCORE);
      expect(result.isMatch).toBe(true);
    });

    it('tier 4: aggressive "... Xem thêm" crop (eval image copy 8) still prefixes', () => {
      const ocr = `${CHROME}\nBỘ TƯ LỆNH THÀNH PHỐ: CỤ... xem thêm`;
      const result = matchText(ocr, CAPTION);
      expect(result.matchType).toBe('prefix');
      expect(result.score).toBe(PREFIX_MATCH_SCORE);
      expect(result.isMatch).toBe(true);
    });

    it('tier 4 does not run when the caption has fewer than 6 words', () => {
      expect(prefixTokenRange(5)).toBeNull();
      const result = matchText('bao cao tuan hop toi nay', 'Báo cáo tuần');
      expect(result.matchType).not.toBe('prefix');
    });
  });

  describe('pickBestMatch', () => {
    it('assigns the image to the highest scoring open task', () => {
      const winner = pickBestMatch(`${CHROME}\n${CAPTION}`, [
        { id: 'other', referenceText: 'Báo cáo tuần họp tổ dân phố', createdAt: 1 },
        { id: 'target', referenceText: CAPTION, createdAt: 99 },
      ]);
      expect(winner?.candidate.id).toBe('target');
      expect(winner?.result.score).toBe(1);
    });

    it('breaks an exact score tie by earlier created_at', () => {
      const winner = pickBestMatch(CAPTION, [
        { id: 'later', referenceText: CAPTION, createdAt: 200 },
        { id: 'earlier', referenceText: CAPTION, createdAt: 50 },
      ]);
      expect(winner?.candidate.id).toBe('earlier');
    });

    it('returns null when every score is below the threshold', () => {
      expect(
        pickBestMatch('sticker cat meme', [
          { id: 'a', referenceText: CAPTION, createdAt: 1 },
        ])
      ).toBeNull();
    });
  });
});
