import { describe, it, expect } from 'vitest';
import {
  formatGateDutyMessage,
  formatPatrolOnlyMessage,
  formatLeaveRosterMessage,
  formatMessage,
} from '../src/formatters';
import { DailyDuty, LeaveEntry } from '../src/types';

describe('Message Formatters', () => {
  const sampleDayDuty: DailyDuty = {
    date: '01/09/2026',
    unit: 'Đơn vị: Tiểu đội 2 - Trung đội 1',
    isOvernight: false,
    tasks: [
      { taskName: 'Ca 1 (05:30 - 06:00) + quét phòng ngủ', assignee: 'Lương Văn Tài' },
      { taskName: 'Ca 2 (06:00 - 07:00)', assignee: 'Bùi Nguyễn Đăng Khoa' },
      { taskName: 'Đi tuần - Ca 1', assignee: 'Phạm Hoàng Phúc' },
      { taskName: 'Đi tuần - Ca 2', assignee: 'Phạm Hữu Luân' },
      { taskName: 'Trực ban', assignee: 'Mai Đức Tín' },
    ],
  };

  const sampleNightDuty: DailyDuty = {
    date: '01/09/2026',
    unit: 'Đơn vị: Tiểu đội culi - Trung đội 1',
    isOvernight: true,
    tasks: [
      { taskName: 'Ca 1 (23h - 1h)', assignee: 'Nguyễn Phúc Nhật Quang' },
      { taskName: 'Ca 2 (1h - 2h15)', assignee: 'Nguyễn Trần Quốc Bảo' },
      { taskName: 'Ca 5 (4h15-5h30)', assignee: 'Nguyễn Kiến Quốc' },
    ],
  };

  const sampleLeaveEntry: LeaveEntry = {
    date: '04/09/2026',
    onLeave: ['Lê Công Danh', 'Phạm Hữu Luân', 'Nguyễn Phi Hoàng'],
    missedTurn: ['Lương Văn Tài'],
  };

  it('formats daytime gate duty correctly', () => {
    const text = formatGateDutyMessage(sampleDayDuty);
    expect(text).toContain('📢 Lịch trực cổng ngày 01/09/2026');
    expect(text).toContain('Đơn vị: Tiểu đội 2 - Trung đội 1');
    expect(text).toContain('🔹 Ca 1 (05:30 - 06:00) + quét phòng ngủ: Lương Văn Tài');
    expect(text).toContain('🔹 Đi tuần - Ca 1: Phạm Hoàng Phúc');
    expect(text).toContain('🔹 Trực ban: Mai Đức Tín');
  });

  it('formats overnight gate duty with time range note', () => {
    const text = formatGateDutyMessage(sampleNightDuty);
    expect(text).toContain('📢 Lịch trực cổng đêm ngày 01/09/2026');
    expect(text).toContain('Đơn vị: Tiểu đội culi - Trung đội 1');
    expect(text).toContain('(Thời gian: 23h ngày 01/09 → 5h30 sáng ngày 02/09)');
    expect(text).toContain('🔹 Ca 1 (23h - 1h): Nguyễn Phúc Nhật Quang');
    expect(text).toContain('🔹 Ca 5 (4h15-5h30): Nguyễn Kiến Quốc');
  });

  it('formats patrol-only schedule (F7)', () => {
    const text = formatPatrolOnlyMessage(sampleDayDuty);
    expect(text).toContain('📢 Lịch đi tuần ngày 01/09/2026');
    expect(text).toContain('🔹 Đi tuần - Ca 1: Phạm Hoàng Phúc');
    expect(text).toContain('🔹 Đi tuần - Ca 2: Phạm Hữu Luân');
    // Non-patrol tasks should be excluded
    expect(text).not.toContain('Trực ban');
    expect(text).not.toContain('Ca 1 (05:30 - 06:00)');
  });

  it('formats leave roster schedule (F5)', () => {
    const text = formatLeaveRosterMessage({
      unit: 'Đơn vị: Tiểu đội 2 - Trung đội 1',
      entry: sampleLeaveEntry,
    });
    expect(text).toContain('📢 Lịch tranh thủ ngày 04/09/2026');
    expect(text).toContain('Đơn vị: Tiểu đội 2 - Trung đội 1');
    expect(text).toContain('🔹 Danh sách về tranh thủ:');
    expect(text).toContain('- Lê Công Danh');
    expect(text).toContain('- Phạm Hữu Luân');
    expect(text).toContain('🔹 Mất lượt: Lương Văn Tài');
  });

  it('dispatches formatters via formatMessage registry', () => {
    const dayText = formatMessage('gate_duty', sampleDayDuty);
    expect(dayText).toContain('📢 Lịch trực cổng ngày 01/09/2026');

    const patrolText = formatMessage('gate_duty_patrol_only', sampleDayDuty);
    expect(patrolText).toContain('📢 Lịch đi tuần ngày 01/09/2026');

    const leaveText = formatMessage('leave_roster', {
      unit: 'Đơn vị: Tiểu đội 2',
      entry: sampleLeaveEntry,
    });
    expect(leaveText).toContain('📢 Lịch tranh thủ ngày 04/09/2026');
  });

  it('handles empty duty data gracefully', () => {
    const emptyDuty: DailyDuty = {
      date: '01/09/2026',
      tasks: [],
    };
    expect(formatGateDutyMessage(emptyDuty)).toBe(
      'Không có dữ liệu lịch trực cổng cho ngày 01/09/2026'
    );
    expect(formatGateDutyMessage(null, '01/09/2026')).toBe(
      'Không có dữ liệu lịch trực cổng cho ngày 01/09/2026'
    );
  });
});
