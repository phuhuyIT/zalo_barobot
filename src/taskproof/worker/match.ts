/**
 * match.ts
 *
 * So khớp OCR với caption nhiệm vụ (Section 8.2). Content-based, không
 * dựa vào reply/quote. Ảnh được chấm với mọi task đang collecting|overdue
 * trên cùng zca_group_id; điểm cao nhất thắng. Ba tầng: exact, Dice,
 * sliding window.
 *
 * Chuẩn hóa trước khi chấm: NFD, bỏ dấu tiếng Việt (kể cả đ), chữ thường,
 * mọi ký tự ngoài chữ/số/khoảng trắng → space. Dấu câu trong caption
 * không làm giảm điểm.
 *
 * Hòa điểm tuyệt đối → task created_at sớm hơn. Dưới ngưỡng → bỏ ảnh,
 * không ghi submission. Worker không gửi báo cáo (official bot làm T6).
 */

import stringSimilarity from 'string-similarity';

export const DEFAULT_OCR_MATCH_THRESHOLD = 0.5;

export type MatchTier =
  | 'exact'
  | 'dice_full'
  | 'dice_line'
  | 'sliding_window'
  | 'none';

export interface MatchResult {
  score: number;
  isMatch: boolean;
  matchType: MatchTier;
  matchedSnippet?: string;
}

export interface MatchCandidate {
  id: string;
  referenceText: string;
  createdAt: number;
}

export interface BestMatch {
  candidate: MatchCandidate;
  result: MatchResult;
}

function clampScore(score: number): number {
  return Math.min(1, Math.max(0, Math.round(score * 10000) / 10000));
}

function tokensOf(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyResult(): MatchResult {
  return { score: 0, isMatch: false, matchType: 'none' };
}

function consider(
  best: { score: number; type: MatchTier; snippet: string },
  score: number,
  type: MatchTier,
  snippet: string
): void {
  if (score > best.score) {
    best.score = score;
    best.type = type;
    best.snippet = snippet;
  }
}

/**
 * Chấm một cặp (ocr, caption). Tầng 1 exact → 1.0 rồi dừng.
 * Các tầng còn lại lấy max.
 */
export function matchText(
  ocrText: string,
  referenceText: string,
  threshold: number = DEFAULT_OCR_MATCH_THRESHOLD
): MatchResult {
  if (!ocrText || !referenceText) {
    return emptyResult();
  }

  const normOcr = normalizeText(ocrText);
  const normRef = normalizeText(referenceText);
  if (!normOcr || !normRef) {
    return emptyResult();
  }

  if (normOcr.includes(normRef)) {
    return {
      score: 1,
      isMatch: true,
      matchType: 'exact',
      matchedSnippet: normRef,
    };
  }

  const best = { score: 0, type: 'none' as MatchTier, snippet: '' };

  consider(best, stringSimilarity.compareTwoStrings(normOcr, normRef), 'dice_full', normOcr);

  for (const line of ocrText.split(/\r?\n/)) {
    const normLine = normalizeText(line);
    if (!normLine || normLine.length < 3) continue;
    consider(
      best,
      stringSimilarity.compareTwoStrings(normLine, normRef),
      'dice_line',
      normLine
    );
  }

  const ocrTokens = tokensOf(normOcr);
  const refTokens = tokensOf(normRef);
  const windowSize = refTokens.length;
  if (windowSize > 0 && ocrTokens.length >= windowSize) {
    for (let i = 0; i <= ocrTokens.length - windowSize; i++) {
      const windowStr = ocrTokens.slice(i, i + windowSize).join(' ');
      consider(
        best,
        stringSimilarity.compareTwoStrings(windowStr, normRef),
        'sliding_window',
        windowStr
      );
    }
  }

  const score = clampScore(best.score);
  return {
    score,
    isMatch: score >= threshold,
    matchType: best.type,
    matchedSnippet: best.snippet || undefined,
  };
}

/**
 * Ảnh gán cho task điểm cao nhất ≥ ngưỡng. Hòa → created_at sớm hơn.
 */
export function pickBestMatch(
  ocrText: string,
  candidates: MatchCandidate[],
  threshold: number = DEFAULT_OCR_MATCH_THRESHOLD
): BestMatch | null {
  let winner: BestMatch | null = null;
  for (const candidate of candidates) {
    const result = matchText(ocrText, candidate.referenceText, threshold);
    if (!result.isMatch) continue;
    if (!winner) {
      winner = { candidate, result };
      continue;
    }
    if (result.score > winner.result.score) {
      winner = { candidate, result };
      continue;
    }
    if (
      result.score === winner.result.score &&
      candidate.createdAt < winner.candidate.createdAt
    ) {
      winner = { candidate, result };
    }
  }
  return winner;
}
