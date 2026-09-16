/**
 * patrolOnlyFormatter.ts
 *
 * Hàm định dạng tin nhắn rút gọn chỉ gồm các ca đi tuần (F7).
 * Gửi riêng cho Trung đội trưởng.
 */

import { DailyDuty } from '../types';
import { formatTaskHierarchy } from './formatterUtils';

export function formatPatrolOnlyMessage(duty: DailyDuty | null, targetDate?: string): string {
  const dateStr = duty?.date || targetDate || '';

  if (!duty || !duty.tasks || duty.tasks.length === 0) {
    return `Không có lịch đi tuần cho ngày ${dateStr}`.trim();
  }

  // Lọc riêng các nhiệm vụ đi tuần / tuần tra
  const patrolTasks = duty.tasks.filter((t) => {
    const fullName = `${t.parentTask || ''} ${t.taskName}`.toLowerCase();
    return fullName.includes('đi tuần') || fullName.includes('tuần tra');
  });

  if (patrolTasks.length === 0) {
    return `Không có lịch đi tuần cho ngày ${dateStr}`.trim();
  }

  const lines: string[] = [];
  lines.push(`📢 Lịch đi tuần ngày ${duty.date}`);
  if (duty.unit) {
    lines.push(duty.unit);
  }
  lines.push('');
  lines.push(...formatTaskHierarchy(patrolTasks));

  return lines.join('\n');
}
