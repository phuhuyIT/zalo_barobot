/**
 * patrolOnlyFormatter.ts
 *
 * Hàm định dạng tin nhắn rút gọn chỉ gồm các ca đi tuần (F7).
 * Gửi riêng cho Trung đội trưởng.
 */

import { DailyDuty } from '../types';

export function formatPatrolOnlyMessage(duty: DailyDuty | null, targetDate?: string): string {
  const dateStr = duty?.date || targetDate || '';

  if (!duty || !duty.tasks || duty.tasks.length === 0) {
    return `Không có lịch đi tuần cho ngày ${dateStr}`.trim();
  }

  // Lọc riêng các nhiệm vụ đi tuần / tuần tra
  const patrolTasks = duty.tasks.filter((t) => {
    const nameLower = t.taskName.toLowerCase();
    return nameLower.includes('đi tuần') || nameLower.includes('tuần tra');
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

  for (const task of patrolTasks) {
    lines.push(`🔹 ${task.taskName}: ${task.assignee}`);
  }

  return lines.join('\n');
}
