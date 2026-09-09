import { describe, it, expect } from 'vitest';
import {
  normalizeDate,
  isPlaceholderOrEmpty,
  resolveLookupDate,
  formatDateDMY,
} from '../src/sheets/dateUtils';
import {
  detectTwoRowLayout,
  parseGateDutyTwoRow,
} from '../src/sheets/gateDutyTwoRowParser';
import {
  detectSingleRowLayout,
  parseGateDutySingleRow,
} from '../src/sheets/gateDutySingleRowParser';
import {
  parseLeaveRoster,
  resolveTargetLeaveEntry,
} from '../src/sheets/leaveRosterParser';

describe('Date & Placeholder Utils', () => {
  it('identifies placeholders and empty values correctly', () => {
    expect(isPlaceholderOrEmpty('')).toBe(true);
    expect(isPlaceholderOrEmpty('   ')).toBe(true);
    expect(isPlaceholderOrEmpty(null)).toBe(true);
    expect(isPlaceholderOrEmpty(undefined)).toBe(true);
    expect(isPlaceholderOrEmpty('-')).toBe(true);
    expect(isPlaceholderOrEmpty('--')).toBe(true);
    expect(isPlaceholderOrEmpty('N/A')).toBe(true);
    expect(isPlaceholderOrEmpty('n/a')).toBe(true);

    expect(isPlaceholderOrEmpty('Nguyễn Văn A')).toBe(false);
  });

  it('normalizes various date formats to DD/MM/YYYY', () => {
    expect(normalizeDate('01/09/2026')).toBe('01/09/2026');
    expect(normalizeDate('1/9/2026')).toBe('01/09/2026');
    expect(normalizeDate('2026-09-01')).toBe('01/09/2026');
    // Excel serial for 2026-09-01 is 46266
    expect(normalizeDate('46266.0')).toBe('01/09/2026');
    expect(normalizeDate(46266)).toBe('01/09/2026');
  });

  it('resolves lookup date for regular squad (today)', () => {
    const tuesday = new Date(2026, 8, 1, 5, 30); // 2026-09-01 05:30
    const result = resolveLookupDate(tuesday, false);
    expect(result).toBe('01/09/2026');
  });

  it('resolves lookup date for overnight squad based on cutover_time', () => {
    // 05:00 on Tuesday (before 05:30 cutover) -> should look up Monday (yesterday)
    const earlyMorning = new Date(2026, 8, 1, 5, 0);
    expect(resolveLookupDate(earlyMorning, true, '05:30')).toBe('31/08/2026');

    // 05:30 on Tuesday (at cutover) -> should look up Tuesday (today, upcoming night shift)
    const atCutover = new Date(2026, 8, 1, 5, 30);
    expect(resolveLookupDate(atCutover, true, '05:30')).toBe('01/09/2026');

    // 22:00 on Tuesday (after cutover) -> should look up Tuesday
    const nightTime = new Date(2026, 8, 1, 22, 0);
    expect(resolveLookupDate(nightTime, true, '05:30')).toBe('01/09/2026');
  });
});

describe('Two-Row Merged Parser (Main Squad)', () => {
  // Mock dữ liệu thực tế từ Sheet "Lịch Trực Cổng & Phân Công Nhiệ"
  const mockSheetRows = [
    ['BẢNG PHÂN CÔNG LỊCH TRỰC CỔNG & NHIỆM VỤ TIỂU ĐỘI', '', '', 'Xoay ca...'],
    ['Đơn vị: Tiểu đội 2 - Trung đội 1'],
    ['Thời gian áp dụng: Tuần 1 tháng 9/2026'],
    // Header 1 (row 4, index 3): Col 0 là "Thứ ", Col 1 là "Ngày", Col 8 là "Đi tuần"
    [
      'Thứ ',
      'Ngày',
      'Ca 1 (05:30 - 06:00) + quét phòng ngủ',
      'Ca 2 (06:00 - 07:00)',
      'Ca 3 (07:00 - 11:30)',
      'Ca 4 (11:30 - 13:30)',
      'Ca 5 (13:30 - 18:00)',
      'Ca 6 (18:00 - 23:00)',
      'Đi tuần',
      '',
      'Trực ban',
      'Ở không',
      'Ghi chú',
    ],
    // Header 2 (row 5, index 4): Sub-headers for "Đi tuần"
    ['', '', '', '', '', '', '', '', 'Ca 1', 'Ca 2', '', '', ''],
    // Data Row 1 (row 6, index 5)
    [
      'Thứ Ba',
      '01/09/2026',
      'Lương Văn Tài',
      'Bùi Nguyễn Đăng Khoa',
      'Nguyễn Phi Hoàng',
      'Lê Công Danh',
      'Lê Hoàng Vũ',
      'Bùi Nguyễn Đăng Khoa',
      'Phạm Hoàng Phúc',
      'Phạm Hữu Luân',
      'Mai Đức Tín',
      '',
      '',
    ],
    // Data Row 2
    [
      'Thứ Tư',
      '02/09/2026',
      'Lê Hoàng Vũ',
      'Bùi Nguyễn Đăng Khoa',
      'Lương Văn Tài',
      'Nguyễn Phi Hoàng',
      'Lê Công Danh',
      'Bùi Nguyễn Đăng Khoa',
      'Lê Hoàng Vũ',
      'Phạm Hoàng Phúc',
      'Phạm Hữu Luân',
      'Mai Đức Tín',
      '',
    ],
  ];

  it('detects two_row layout dynamically and merges headers correctly', () => {
    const layout = detectTwoRowLayout(mockSheetRows);
    expect(layout.headerRow1Index).toBe(3);
    expect(layout.headerRow2Index).toBe(4);
    expect(layout.dateColIndex).toBe(1);
    expect(layout.unit).toBe('Đơn vị: Tiểu đội 2 - Trung đội 1');

    // Cột 0 ("Thứ ") phải bị loại trừ
    const colNames = layout.taskColumns.map((c) => c.name);
    expect(colNames).not.toContain('Thứ ');

    // "Đi tuần" phải được ghép đúng với Ca 1 và Ca 2
    expect(colNames).toContain('Đi tuần - Ca 1');
    expect(colNames).toContain('Đi tuần - Ca 2');
    expect(colNames).toContain('Trực ban');
  });

  it('parses duty schedule for specific date and skips empty/placeholder cells', () => {
    const duty = parseGateDutyTwoRow(mockSheetRows, '01/09/2026');
    expect(duty).not.toBeNull();
    expect(duty?.date).toBe('01/09/2026');
    expect(duty?.unit).toBe('Đơn vị: Tiểu đội 2 - Trung đội 1');
    expect(duty?.isOvernight).toBe(false);

    const taskMap = Object.fromEntries(
      duty!.tasks.map((t) => [t.taskName, t.assignee])
    );
    expect(taskMap['Ca 1 (05:30 - 06:00) + quét phòng ngủ']).toBe('Lương Văn Tài');
    expect(taskMap['Đi tuần - Ca 1']).toBe('Phạm Hoàng Phúc');
    expect(taskMap['Đi tuần - Ca 2']).toBe('Phạm Hữu Luân');
    expect(taskMap['Trực ban']).toBe('Mai Đức Tín');
    // "Ở không" và "Ghi chú" rỗng -> không có trong tasks
    expect(taskMap['Ở không']).toBeUndefined();
    expect(taskMap['Ghi chú']).toBeUndefined();
  });

  it('handles completely different layout at different row and column positions', () => {
    const alternateSheet = [
      ['Ghi chú đầu trang'],
      [''],
      ['Đơn vị: Tiểu đoàn 5'],
      [''],
      [''],
      [''],
      // Header row ở tận index 6, cột Ngày ở index 2
      ['STT', 'Mã', 'Ngày', 'Gác cổng', 'Tuần tra', ''],
      ['', '', '', 'Ca Ngày', 'Ca Đêm', ''],
      // Data
      ['1', 'A01', '05/09/2026', 'Trần Văn X', 'Lê Văn Y', ''],
    ];

    const duty = parseGateDutyTwoRow(alternateSheet, '05/09/2026');
    expect(duty).not.toBeNull();
    expect(duty?.unit).toBe('Đơn vị: Tiểu đoàn 5');
    expect(duty?.tasks).toHaveLength(2);
    expect(duty?.tasks[0].taskName).toBe('Gác cổng - Ca Ngày');
    expect(duty?.tasks[0].assignee).toBe('Trần Văn X');
    expect(duty?.tasks[1].taskName).toBe('Tuần tra - Ca Đêm');
    expect(duty?.tasks[1].assignee).toBe('Lê Văn Y');
  });
});

describe('Single-Row Parser (Culi Squad)', () => {
  // Mock dữ liệu từ Sheet "Lịch trực cổng tiểu đội culi"
  const mockCuliSheet = [
    ['BẢNG PHÂN CÔNG LỊCH TRỰC CỔNG & NHIỆM VỤ TIỂU ĐỘI'],
    ['Đơn vị: Tiểu đội culi - Trung đội 1', '', '', '', '', '', '', '', 'Tổng quân số:', '5'],
    ['Thời gian áp dụng: Tuần 1 tháng 9/2026'],
    // Header row (index 3): Col 0 là "Ngày", Col 1-5 là Ca 1-5, Col 6 là "Nghỉ trực", Col 7 rỗng, Col 8 là "STT", Col 9 là "Danh sách..."
    [
      'Ngày',
      'Ca 1 (23h - 1h)',
      'Ca 2 (1h - 2h15)',
      'Ca 3 (2h15 - 3h15)',
      'Ca 4 (3h15 - 4h15)',
      'Ca 5 (4h15-5h30)',
      'Nghỉ trực',
      '',
      'STT',
      'Danh sách quân số trực',
    ],
    // Data Row 1 (index 4)
    [
      '01/09/2026',
      'Nguyễn Phúc Nhật Quang',
      'Nguyễn Trần Quốc Bảo',
      'Bùi Thanh Lộc',
      'Hồ Nguyễn Thanh Tùng',
      'Nguyễn Kiến Quốc',
      '-',
      '',
      '1.0',
      'Nguyễn Phúc Nhật Quang',
    ],
  ];

  it('detects single_row layout, stops at blank column, and excludes side roster table', () => {
    const layout = detectSingleRowLayout(mockCuliSheet);
    expect(layout.headerRowIndex).toBe(3);
    expect(layout.dateColIndex).toBe(0);
    expect(layout.unit).toBe('Đơn vị: Tiểu đội culi - Trung đội 1');

    const colNames = layout.taskColumns.map((c) => c.name);
    expect(colNames).toContain('Ca 1 (23h - 1h)');
    expect(colNames).toContain('Ca 5 (4h15-5h30)');
    expect(colNames).toContain('Nghỉ trực');
    // Phải dừng ở cột rỗng -> KHÔNG được chứa STT hay Danh sách quân số
    expect(colNames).not.toContain('STT');
    expect(colNames).not.toContain('Danh sách quân số trực');
  });

  it('parses culi duty schedule and skips placeholder "-"', () => {
    const duty = parseGateDutySingleRow(mockCuliSheet, '01/09/2026');
    expect(duty).not.toBeNull();
    expect(duty?.date).toBe('01/09/2026');
    expect(duty?.unit).toBe('Đơn vị: Tiểu đội culi - Trung đội 1');
    expect(duty?.isOvernight).toBe(true);

    const taskMap = Object.fromEntries(
      duty!.tasks.map((t) => [t.taskName, t.assignee])
    );
    expect(taskMap['Ca 1 (23h - 1h)']).toBe('Nguyễn Phúc Nhật Quang');
    expect(taskMap['Ca 5 (4h15-5h30)']).toBe('Nguyễn Kiến Quốc');
    // "Nghỉ trực" có giá trị '-' -> phải bị bỏ qua
    expect(taskMap['Nghỉ trực']).toBeUndefined();
    // Bảng phụ không bị đọc
    expect(taskMap['STT']).toBeUndefined();
  });
});

describe('Leave Roster Parser', () => {
  const mockLeaveSheet = [
    ['', 'Thứ 6', '', 'Thứ 7'],
    ['Ngày', 'Người về 1', 'Người về 2', 'Người về 3', 'Người về 4', 'Người mất lượt'],
    ['28/08/2026', 'Bùi Thanh Lộc', 'Phạm Hữu Luân', 'Thái Hoàng Phúc', 'Nguyễn Phi Hoàng', 'N/A'],
    ['04/09/2026', 'Lê Công Danh', 'Phạm Hữu Luân', 'Nguyễn Phạm Phú Huy', 'Nguyễn Phi Hoàng', 'Lương Văn Tài'],
    ['11/09/2026', 'Mai Đức Tính', 'Lê Hoàng Vũ', 'Bùi Nguyễn Đăng Khoa', 'Phạm Hoàng Phúc', 'N/A'],
    ['', '', '', '', '', ''],
  ];

  it('parses leave roster and categorizes onLeave and missedTurn', () => {
    const roster = parseLeaveRoster(mockLeaveSheet);
    expect(roster.entries).toHaveLength(3);

    const entry1 = roster.entries[0];
    expect(entry1.date).toBe('28/08/2026');
    expect(entry1.onLeave).toEqual([
      'Bùi Thanh Lộc',
      'Phạm Hữu Luân',
      'Thái Hoàng Phúc',
      'Nguyễn Phi Hoàng',
    ]);
    // N/A phải được bỏ qua -> missedTurn rỗng
    expect(entry1.missedTurn).toEqual([]);

    const entry2 = roster.entries[1];
    expect(entry2.date).toBe('04/09/2026');
    expect(entry2.missedTurn).toEqual(['Lương Văn Tài']);
  });

  it('resolves the current or nearest upcoming leave entry', () => {
    const roster = parseLeaveRoster(mockLeaveSheet);

    // Ngày 01/09/2026 (Thứ Ba) -> tuần tranh thủ sắp tới là 04/09/2026 (Thứ Sáu)
    const target = resolveTargetLeaveEntry(roster.entries, new Date(2026, 8, 1));
    expect(target?.date).toBe('04/09/2026');
    expect(target?.missedTurn).toEqual(['Lương Văn Tài']);

    // Ngày 15/09/2026 (vượt quá các ngày trong sheet) -> trả về ngày cuối cùng (11/09/2026)
    const pastAll = resolveTargetLeaveEntry(roster.entries, new Date(2026, 8, 15));
    expect(pastAll?.date).toBe('11/09/2026');
  });
});
