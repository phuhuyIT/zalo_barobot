/**
 * leaveRosterFormatter.ts
 *
 * Hàm định dạng tin nhắn lịch tranh thủ (leave roster) (F5).
 */

import { LeaveEntry } from '../types';

export interface LeaveFormatterInput {
  unit?: string;
  entry: LeaveEntry | null;
}

export function formatLeaveRosterMessage(
  input: LeaveFormatterInput | LeaveEntry | null,
  targetDate?: string
): string {
  let entry: LeaveEntry | null = null;
  let unit: string | undefined = undefined;

  if (!input) {
    return `Không có dữ liệu lịch tranh thủ cho ngày ${targetDate || ''}`.trim();
  }

  if ('entries' in (input as any)) {
    // Trường hợp truyền full LeaveRoster
    const full = input as any;
    unit = full.unit;
    entry = full.entries && full.entries.length > 0 ? full.entries[0] : null;
  } else if ('entry' in input) {
    unit = input.unit;
    entry = input.entry;
  } else {
    entry = input as LeaveEntry;
  }

  if (!entry) {
    return `Không có dữ liệu lịch tranh thủ cho ngày ${targetDate || ''}`.trim();
  }

  const lines: string[] = [];
  lines.push(`📢 Lịch tranh thủ ngày ${entry.date}`);
  if (unit) {
    lines.push(unit);
  }
  lines.push('');

  if (entry.onLeave && entry.onLeave.length > 0) {
    lines.push('🔹 Danh sách về tranh thủ:');
    for (const name of entry.onLeave) {
      lines.push(`- ${name}`);
    }
  } else {
    lines.push('🔹 Không có ai về tranh thủ đợt này');
  }

  if (entry.missedTurn && entry.missedTurn.length > 0) {
    lines.push('');
    lines.push(`🔹 Mất lượt: ${entry.missedTurn.join(', ')}`);
  }

  return lines.join('\n');
}
