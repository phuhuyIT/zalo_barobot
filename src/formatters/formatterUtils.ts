/**
 * formatterUtils.ts
 *
 * Tiện ích hỗ trợ định dạng danh sách ca trực / nhiệm vụ.
 * Giúp chuẩn hóa cách hiển thị cây nhiệm vụ (cha / con) và loại bỏ logic trùng lặp (DRY).
 */

import { DutyTask } from '../types';

/**
 * Định dạng danh sách nhiệm vụ theo phân cấp (parentTask -> subTask).
 * Nếu có nhiệm vụ cha & con, thụt lùi dòng subTask với dấu gạch đầu dòng.
 */
export function formatTaskHierarchy(tasks: DutyTask[]): string[] {
  const lines: string[] = [];
  let currentParent: string | null = null;

  for (const task of tasks) {
    if (task.parentTask && task.subTask) {
      if (task.parentTask !== currentParent) {
        currentParent = task.parentTask;
        lines.push(`🔹 ${task.parentTask}:`);
      }
      lines.push(`      - ${task.subTask}: ${task.assignee}`);
    } else {
      currentParent = null;
      lines.push(`🔹 ${task.taskName}: ${task.assignee}`);
    }
  }

  return lines;
}
