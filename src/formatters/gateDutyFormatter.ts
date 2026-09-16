/**
 * gateDutyFormatter.ts
 *
 * Hàm định dạng tin nhắn lịch trực cổng (pure function).
 * Tuân thủ tiêu chuẩn định dạng tin nhắn mục 5.11 (tiếng Việt).
 */

import { DailyDuty } from '../types';
import { parseDMYToDate } from '../sheets/dateUtils';
import { formatTaskHierarchy } from './formatterUtils';

/**
 * Tính ngày tiếp theo dạng DD/MM từ chuỗi DD/MM/YYYY.
 */
function getNextDayDM(dmy: string): string {
  const d = parseDMYToDate(dmy);
  if (!d) return '';
  d.setDate(d.getDate() + 1);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

export function formatGateDutyMessage(duty: DailyDuty | null, targetDate?: string): string {
  const dateStr = duty?.date || targetDate || '';

  if (!duty || !duty.tasks || duty.tasks.length === 0) {
    return `Không có dữ liệu lịch trực cổng cho ngày ${dateStr}`.trim();
  }

  const lines: string[] = [];

  if (duty.isOvernight) {
    // Template cho ca trực đêm (culi squad)
    lines.push(`📢 Lịch trực cổng đêm ngày ${duty.date}`);
    if (duty.unit) {
      lines.push(duty.unit);
    }
    const currentDM = duty.date.slice(0, 5); // dd/mm
    const nextDM = getNextDayDM(duty.date);
    lines.push(`(Thời gian: 23h ngày ${currentDM} → 5h30 sáng ngày ${nextDM})`);
  } else {
    // Template cho ca trực ban ngày (main squad)
    lines.push(`📢 Lịch trực cổng ngày ${duty.date}`);
    if (duty.unit) {
      lines.push(duty.unit);
    }
  }

  lines.push(''); // Dòng trống ngăn cách
  lines.push(...formatTaskHierarchy(duty.tasks));

  return lines.join('\n');
}
