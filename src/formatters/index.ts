/**
 * formatters/index.ts
 *
 * Formatter Registry theo kiến trúc Mục 4 và Mục 5.6.
 * Đăng ký formatter theo chuỗi "type" tự do (không fix cứng enum).
 */

import { formatGateDutyMessage } from './gateDutyFormatter';
import { formatPatrolOnlyMessage } from './patrolOnlyFormatter';
import { formatLeaveRosterMessage } from './leaveRosterFormatter';
import { formatLeaveStatsMessage } from './leaveStatsFormatter';

export * from './gateDutyFormatter';
export * from './patrolOnlyFormatter';
export * from './leaveRosterFormatter';
export * from './leaveStatsFormatter';

export type FormatterFn = (data: any, targetDate?: string) => string;

const formatterRegistry: Map<string, FormatterFn> = new Map();

// Đăng ký các formatter mặc định
registerFormatter('gate_duty', formatGateDutyMessage);
registerFormatter('gate_duty_patrol_only', formatPatrolOnlyMessage);
registerFormatter('leave_roster', formatLeaveRosterMessage);
registerFormatter('leave_roster_stats', formatLeaveStatsMessage);

export function registerFormatter(type: string, fn: FormatterFn): void {
  formatterRegistry.set(type, fn);
}

export function getFormatter(type: string): FormatterFn {
  const fn = formatterRegistry.get(type);
  if (!fn) {
    throw new Error(`Chưa đăng ký formatter cho kiểu '${type}'.`);
  }
  return fn;
}

export function formatMessage(type: string, data: any, targetDate?: string): string {
  const formatter = getFormatter(type);
  return formatter(data, targetDate);
}
