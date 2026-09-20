/**
 * quet.ts
 *
 * /quet — quét N tin gần nhất cho minh chứng gửi trước khi /task tồn tại.
 * Mặc định 5 tin; `/quet ABC123 20` đổi số tin (1–50, trần getrecentv2).
 * File này không import zca-js (official bot + worker cùng dùng).
 */

/** getrecentv2 từ chối count lớn (thường 50). */
export const HISTORY_API_MAX_COUNT = 50;

export const QUET_DEFAULT_COUNT = 5;
export const QUET_MIN_COUNT = 1;
export const QUET_MAX_COUNT = HISTORY_API_MAX_COUNT;

export interface ScanHistorySummary {
  shortCode: string;
  count: number;
  scanned: number;
  recorded: number;
  skipped: number;
  discarded: number;
  closed: boolean;
  truncated: boolean;
  error?: string;
}

/** Số tin lấy từ getrecentv2 = số tin /quet yêu cầu, trần 50. */
export function historyFetchCount(count: number): number {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < QUET_MIN_COUNT) return QUET_DEFAULT_COUNT;
  return Math.min(QUET_MAX_COUNT, n);
}

/** ts zca: ms, hoặc giây nếu < 1e12. */
export function parseZcaTs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

/**
 * Số tin nguyên ≥ 1. `/quet ABC123 20` — không còn phút/`20p`.
 */
export function parseQuetCount(raw: string): number | null {
  const s = (raw || '').trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < QUET_MIN_COUNT) return null;
  return n;
}

export function formatScanResultReply(summary: ScanHistorySummary): string {
  const count = historyFetchCount(summary.count);
  const code = summary.shortCode || '?';
  if (summary.error) {
    return `Quét ${code} (${count} tin) lỗi: ${summary.error}`;
  }
  const lines: string[] = [];
  if (summary.recorded === 0) {
    lines.push(`Quét xong ${code} (${count} tin): không thấy minh chứng khớp.`);
  } else {
    lines.push(
      `Quét xong ${code} (${count} tin): xem ${summary.scanned} ảnh, ghi ${summary.recorded} minh chứng.`
    );
  }
  if (summary.truncated) {
    lines.push(
      `Đã lấy tối đa ${QUET_MAX_COUNT} tin — có thể còn ảnh cũ hơn.`
    );
  }
  if (summary.closed) {
    lines.push('Task đã đủ số lượng, đang gửi báo cáo.');
  }
  return lines.join('\n');
}
