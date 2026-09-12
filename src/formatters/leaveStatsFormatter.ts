/**
 * leaveStatsFormatter.ts
 *
 * Hàm định dạng tin nhắn tóm tắt thống kê tranh thủ (F13).
 * Tuân thủ chuẩn định dạng thông điệp tại mục 5.11 SPEC:
 * - Là pure function: nhận dữ liệu đã phân tích, trả về string.
 * - Sử dụng emoji chuẩn 📊, 🔹, định dạng gọn gàng, rõ ràng trên Zalo.
 */

import { LeaveStatsData, MemberLeaveStat } from '../types';

export function formatLeaveStatsMessage(
  data: LeaveStatsData | null | undefined,
  _targetDate?: string
): string {
  if (!data || !data.stats || data.stats.length === 0) {
    return 'Không có dữ liệu thống kê tranh thủ.';
  }

  const lines: string[] = [];
  lines.push('📊 THỐNG KÊ TẦN SUẤT TRANH THỦ');
  if (data.unit) {
    lines.push(data.unit);
  }

  const metaParts: string[] = [];
  if (data.latestTurnDate) {
    metaParts.push(`Tính đến đợt: ${data.latestTurnDate}`);
  }
  metaParts.push(`Tổng cộng: ${data.totalTurns} đợt`);
  lines.push(`(${metaParts.join(' - ')})`);
  lines.push('');

  for (const s of data.stats) {
    let statusText = '';
    if (s.turnsSinceLastLeave === null) {
      statusText = 'Chưa từng về';
    } else if (s.turnsSinceLastLeave === 0) {
      statusText = `Gần nhất: ${s.lastLeaveDate} (Vừa về đợt mới nhất)`;
    } else {
      statusText = `Gần nhất: ${s.lastLeaveDate} | Cách: ${s.turnsSinceLastLeave} lượt`;
    }

    lines.push(`🔹 ${s.name}: Về ${s.leaveCount} lần | Mất lượt: ${s.missedCount} | ${statusText}`);
  }

  return lines.join('\n');
}
