import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import Database from 'better-sqlite3';
import { webRouter } from '../src/channels/web';
import * as storeModule from '../src/store';
import * as configModule from '../src/config';
import * as sheetsClient from '../src/sheets/sheetsClient';
import { ZaloClient } from '../src/core/zaloClient';
import { sendSchedule } from '../src/core/sendSchedule';
import { parseDoiMessage } from '../src/externalDuty/parser';
import { findChoColumns, matchShiftColumn, readShiftColumns } from '../src/externalDuty/columns';
import { dutyDateForSquad, isGateSatisfied, prepareDutyFromRows } from '../src/externalDuty/prepare';
import { buildPartnerNotice, handleDoiCommand, renderAlertPreview } from '../src/externalDuty/service';
import { runExternalDutyReminders, sendPartnerAlertNow } from '../src/externalDuty/reminders';
import {
  getExternalDutyConfig,
  getPendingChanges,
  listExternalDutyReports,
  saveExternalDutyConfig,
} from '../src/externalDuty/repository';
import { toSheetWriteError } from '../src/sheets/sheetsClient';

const mainSheet = [
  ['Đơn vị: Tiểu đội 2'],
  ['Thứ', 'Ngày', 'Ca 1 (05:30 - 06:00)', 'Ca 2 (06:00 - 07:00)', 'Ca 3 (11h30 - 13h30)', 'Đi tuần', '', 'Nghỉ trực'],
  ['', '', '', '', '', 'Ca 1', 'Ca 2', ''],
  ['Thứ Ba', '02/09/2026', 'Lương Văn Tài', 'Nguyễn Kiến Quốc', 'Chờ', 'Phạm Hoàng Phúc', 'Phạm Hữu Luân', '-'],
];

const culiSheet = [
  ['Đơn vị: Tiểu đội culi'],
  ['Ngày', 'Ca 1 (23h - 1h)', 'Ca 2 (1h - 2h15)', 'Ca 3 (2h15 - 3h15)', 'Ca 4 (3h15 - 4h15)', 'Ca 5 (4h15-5h30)', 'Nghỉ trực'],
  ['01/09/2026', 'Nguyễn Phúc Nhật Quang', 'Nguyễn Trần Quốc Bảo', 'Bùi Thanh Lộc', 'Chờ', 'Nguyễn Kiến Quốc', '-'],
];

function baseConfig() {
  return {
    partnerLeaderUserId: 'leader_1',
    extraEditorIds: [] as string[],
    partnerChatId: '',
    aliasMain: 'a2',
    aliasCuli: 'culi',
    reminderTimes: ['17:00', '17:45'],
    maxReminders: 2,
  };
}

describe('doi parser and sheet slots', () => {
  const config = baseConfig();

  it('turns a Sheets 403 into an Editor permission error', () => {
    expect(toSheetWriteError({ code: 403 }, 'Tab_Main', 'E4').message).toContain('Editor');
  });

  it('hides the raw Google error on other write failures', () => {
    const error = toSheetWriteError(new Error('token ya29.secret'), 'Tab_Main', 'E4');
    expect(error.message).toBe('Không ghi được Google Sheet. Thử lại sau.');
    expect(error.message).not.toContain('ya29');
  });

  it('parses one or many names and treats ca2 like Ca 2', () => {
    const parsed = parseDoiMessage(
      'a2 ca2 Lê Hoàng Vũ, Phạm Hữu Luân\nculi ca4 Nguyễn Chí Khang',
      config
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lines[0]).toMatchObject({
      squad: 'main',
      shiftQuery: 'ca 2',
      names: ['Lê Hoàng Vũ', 'Phạm Hữu Luân'],
    });
    expect(parsed.lines[1]).toMatchObject({
      squad: 'culi',
      names: ['Nguyễn Chí Khang'],
    });
  });

  it('rejects an unknown squad and an empty name list', () => {
    expect(parseDoiMessage('td3 ca1 A', config).ok).toBe(false);
    expect(parseDoiMessage('a2 ca1', config).ok).toBe(false);
  });

  it('rejects a name that is too long', () => {
    const parsed = parseDoiMessage(`a2 ca1 ${'A'.repeat(81)}`, config);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('Tên quá dài');
  });

  it('finds the single empty culi ca and ignores Nghỉ trực', () => {
    const read = readShiftColumns(culiSheet, 'single_row', '01/09/2026');
    const open = findChoColumns(read.columns);
    expect(open.map((col) => col.name)).toEqual(['Ca 4 (3h15 - 4h15)']);
  });

  it('matches Ca 2 on the main sheet and not the patrol sub-column', () => {
    const read = readShiftColumns(mainSheet, 'two_row_merged', '02/09/2026');
    const gate = matchShiftColumn(read.columns, 'ca2');
    const patrol = matchShiftColumn(read.columns, 'tuan ca 2');
    expect(gate.ok && gate.column.name).toBe('Ca 2 (06:00 - 07:00)');
    expect(patrol.ok && patrol.column.name).toBe('Đi tuần - Ca 2');
  });

  it('binds a Tuesday afternoon report to Wednesday gate and Tuesday night culi', () => {
    const tuesday = new Date(2026, 8, 1, 15, 0);
    expect(dutyDateForSquad('main', tuesday)).toBe('02/09/2026');
    expect(dutyDateForSquad('culi', tuesday)).toBe('01/09/2026');
  });

  it('a two-name Ca 2 edit does not satisfy the Ca 3 wait', () => {
    expect(
      isGateSatisfied([
        {
          date: '02/09/2026',
          squad: 'main',
          shiftKey: 'Ca 2 (06:00 - 07:00)',
          shiftLabel: 'Ca 2 (06:00 - 07:00)',
          names: ['Lê Hoàng Vũ', 'Phạm Hữu Luân'],
          cleared: false,
          rawMessage: '',
          messageId: '',
          senderId: 'leader_1',
          submittedAt: '',
        },
      ])
    ).toBe(false);
  });

  it('holds main until Ca 3 is named, then replaces only that shift', () => {
    const waiting = prepareDutyFromRows({
      squad: 'main',
      headerStyle: 'two_row_merged',
      rows: mainSheet,
      lookupDate: '02/09/2026',
      reports: [],
      partnerChatId: 'partner_chat',
      isOvernight: false,
    });
    expect(waiting.held).toBe(true);

    const ready = prepareDutyFromRows({
      squad: 'main',
      headerStyle: 'two_row_merged',
      rows: mainSheet,
      lookupDate: '02/09/2026',
      reports: [
        {
          date: '02/09/2026',
          squad: 'main',
          shiftKey: 'Ca 3 (11h30 - 13h30)',
          shiftLabel: 'Ca 3 (11h30 - 13h30)',
          names: ['Nguyễn Văn A'],
          cleared: false,
          rawMessage: '',
          messageId: '',
          senderId: 'leader_1',
          submittedAt: '',
        },
        {
          date: '02/09/2026',
          squad: 'main',
          shiftKey: 'Ca 2 (06:00 - 07:00)',
          shiftLabel: 'Ca 2 (06:00 - 07:00)',
          names: ['Lê Hoàng Vũ', 'Phạm Hữu Luân'],
          cleared: false,
          rawMessage: '',
          messageId: '',
          senderId: 'leader_1',
          submittedAt: '',
        },
      ],
      partnerChatId: 'partner_chat',
      isOvernight: false,
    });
    expect(ready.held).toBe(false);
    const byName = Object.fromEntries((ready.duty?.tasks || []).map((task) => [task.taskName, task.assignee]));
    expect(byName['Ca 3 (11h30 - 13h30)']).toBe('Nguyễn Văn A');
    expect(byName['Ca 2 (06:00 - 07:00)']).toBe('Lê Hoàng Vũ, Phạm Hữu Luân');
    expect(byName['Ca 1 (05:30 - 06:00)']).toBe('Lương Văn Tài');
    expect(byName['Đi tuần - Ca 1']).toBe('Phạm Hoàng Phúc');
  });

  it('does not send when two culi ca cells are empty', () => {
    const doubled = culiSheet.map((row) => [...row]);
    doubled[2][2] = 'Chờ';
    const prepared = prepareDutyFromRows({
      squad: 'culi',
      headerStyle: 'single_row',
      rows: doubled,
      lookupDate: '01/09/2026',
      reports: [],
      partnerChatId: 'partner_chat',
      isOvernight: true,
    });
    expect(prepared.held).toBe(true);
    expect(prepared.holdReason).toContain('Ca 2');
    expect(prepared.holdReason).toContain('Ca 4');
  });

  it('does not wait on culi when every ca already has a name', () => {
    const filled = culiSheet.map((row) => [...row]);
    filled[2][4] = 'Hồ Nguyễn Thanh Tùng';
    const prepared = prepareDutyFromRows({
      squad: 'culi',
      headerStyle: 'single_row',
      rows: filled,
      lookupDate: '01/09/2026',
      reports: [],
      partnerChatId: 'partner_chat',
      isOvernight: true,
    });
    expect(prepared.held).toBe(false);
    expect(prepared.includePartner).toBe(false);
  });
});

describe('doi command, reminder, and send hold', () => {
  let mockDb: Database.Database;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);
    delete process.env.PARTNER_LEADER_USER_ID;
    delete process.env.SQUAD_PARTNER_CHAT_ID;
    saveExternalDutyConfig(
      {
        partnerLeaderUserId: 'leader_1',
        extraEditorIds: ['editor_2'],
        partnerChatId: 'partner_chat',
        aliasMain: 'a2',
        aliasCuli: 'culi',
        reminderTimes: ['17:00', '17:45'],
        maxReminders: 2,
      },
      mockDb
    );
    configModule.setConfig({
      squads: {
        main: {
          display_name: 'Tiểu đội 2',
          sheet_tab_gate_duty: 'Tab_Main',
          header_style: 'two_row_merged',
          overnight: false,
          send_next_day: true,
          next_day_cutover_time: '20:00',
        },
        culi: {
          display_name: 'Tiểu đội culi',
          sheet_tab_gate_duty: 'Tab_Culi',
          header_style: 'single_row',
          overnight: true,
          cutover_time: '05:30',
        },
      },
      recipients: {
        squad_main: 'chat_main',
        squad_culi: 'chat_culi',
        squad_partner: 'partner_chat',
        admin: 'chat_admin',
      },
      schedules: [
        {
          key: 'main_duty',
          label: 'Lịch trực cổng Tiểu đội 2',
          squad: 'main',
          type: 'gate_duty',
          recipients: ['squad_main'],
          auto_send_time: '20:00',
          enabled: true,
        },
        {
          key: 'culi_duty',
          label: 'Lịch trực cổng Tiểu đội culi',
          squad: 'culi',
          type: 'gate_duty',
          recipients: ['squad_culi'],
          auto_send_time: '19:30',
          enabled: true,
        },
      ],
      reminders: [],
    });
    process.env.GOOGLE_SHEET_ID = 'sheet';
    vi.spyOn(sheetsClient, 'updateSheetCell').mockResolvedValue();
  });

  afterEach(() => {
    mockDb.close();
    storeModule.setDatabase(null);
    vi.restoreAllMocks();
  });

  it('stores Tuesday 15:00 names on the two different dates and ignores another sender', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm1', raw: {} });
    const now = new Date(2026, 8, 1, 15, 0);

    const ignored = await handleDoiCommand(
      { text: 'a2 ca3 Người Lạ', chatId: 'stranger', senderId: 'stranger' },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet, culi: culiSheet }, skipSend: true }
    );
    expect(ignored.ignoredReason).toBe('unauthorized_sender');

    const saved = await handleDoiCommand(
      {
        text: 'a2 ca3 Nguyễn Văn A\nculi ca4 Trần Văn B\na2 ca2 Lê Hoàng Vũ, Phạm Hữu Luân',
        chatId: 'leader_1',
        senderId: 'leader_1',
        messageId: 'msg_1',
      },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet, culi: culiSheet } }
    );
    expect(saved.success).toBe(true);
    expect(saved.sentScheduleKeys).toEqual([]);
    expect(saved.reply).toContain('Sẽ gửi lúc 20:00');
    expect(saved.reply).toContain('Sẽ gửi lúc 19:30');
    const writes = vi.mocked(sheetsClient.updateSheetCell).mock.calls;
    expect(writes).toEqual([
      ['sheet', 'Tab_Main', 3, 4, 'Nguyễn Văn A'],
      ['sheet', 'Tab_Culi', 2, 4, 'Trần Văn B'],
    ]);
    expect(listExternalDutyReports('02/09/2026', 'main', mockDb).map((row) => row.shiftLabel)).toEqual([
      'Ca 3 (11h30 - 13h30)',
    ]);
    expect(saved.reply).toContain('Bạn đổi ca 2 a2 từ Nguyễn Kiến Quốc sang Lê Hoàng Vũ, Phạm Hữu Luân phải không');
    expect(listExternalDutyReports('01/09/2026', 'culi', mockDb)[0].names).toEqual(['Trần Văn B']);
    expect(saved.reply).toContain('Ca 3 (11h30 - 13h30): Nguyễn Văn A');
    expect(saved.reply).toContain('Đã ghi vào Google Sheet');
  });

  it('lists headers when the shift is unknown and does not store it', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm1', raw: {} });
    const result = await handleDoiCommand(
      { text: 'a2 ca9 Nguyễn Văn A', chatId: 'leader_1', senderId: 'leader_1' },
      {
        now: new Date(2026, 8, 1, 15, 0),
        database: mockDb,
        zaloClient: zalo,
        rowsBySquad: { main: mainSheet },
        skipSend: true,
      }
    );
    expect(result.success).toBe(false);
    expect(result.reply).toContain('Ca 1 (05:30 - 06:00)');
    expect(listExternalDutyReports('02/09/2026', 'main', mockDb)).toHaveLength(0);
    expect(sheetsClient.updateSheetCell).not.toHaveBeenCalled();
  });

  it('does not store or send when Google refuses the write', async () => {
    vi.mocked(sheetsClient.updateSheetCell).mockRejectedValue(toSheetWriteError({ code: 403 }, 'Tab_Main', 'E4'));
    const zalo = new ZaloClient('token');
    const sendSpy = vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm1', raw: {} });
    const result = await handleDoiCommand(
      { text: 'a2 ca3 Nguyễn Văn A', chatId: 'leader_1', senderId: 'leader_1', messageId: 'deny_1' },
      {
        now: new Date(2026, 8, 1, 20, 20),
        database: mockDb,
        zaloClient: zalo,
        rowsBySquad: { main: mainSheet },
      }
    );
    expect(result.success).toBe(false);
    expect(result.reply).toContain('Editor');
    expect(listExternalDutyReports('02/09/2026', 'main', mockDb)).toHaveLength(0);
    expect(result.sentScheduleKeys ?? []).toEqual([]);
    expect(sendSpy.mock.calls.some((call) => String(call[1]).includes('📢'))).toBe(false);
  });

  it('does not send at 20:00 without Ca 3, then sends both groups after the late report', async () => {
    vi.spyOn(sheetsClient, 'readSheetTab').mockImplementation(async (_id: string, tab: string) => {
      return tab === 'Tab_Culi' ? culiSheet : mainSheet;
    });
    const zalo = new ZaloClient('token');
    const sendSpy = vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'sent_1', raw: {} });

    const held = await sendSchedule('main_duty', {
      targetDate: '02/09/2026',
      zaloClient: zalo,
      isAutomated: true,
    });
    expect(held.held).toBe(true);
    expect(sendSpy).toHaveBeenCalled();
    const adminWarning = sendSpy.mock.calls.map((call) => String(call[1])).join('\n');
    expect(adminWarning).toContain('Còn ca chưa xếp');
    expect(storeModule.hasSentToday('main_duty', 'chat_main', '02/09/2026', mockDb)).toBe(false);

    sendSpy.mockClear();
    const late = await handleDoiCommand(
      { text: 'a2 ca3 Nguyễn Văn A', chatId: 'leader_1', senderId: 'leader_1', messageId: 'late_1' },
      {
        now: new Date(2026, 8, 1, 20, 20),
        database: mockDb,
        zaloClient: zalo,
        rowsBySquad: { main: mainSheet },
      }
    );
    expect(late.sentScheduleKeys).toContain('main_duty');
    const bodies = sendSpy.mock.calls.map((call) => String(call[1]));
    expect(bodies.some((body) => body.includes('Nguyễn Văn A'))).toBe(true);
    const chats = sendSpy.mock.calls.map((call) => String(call[0]));
    expect(chats).toContain('chat_main');
    expect(chats).toContain('partner_chat');
  });

  it('fills the empty culi cell at 19:30 and leaves a full culi day to the culi group only', async () => {
    const filled = culiSheet.map((row) => [...row]);
    filled[2][4] = 'Hồ Nguyễn Thanh Tùng';
    vi.spyOn(sheetsClient, 'readSheetTab').mockResolvedValue(filled);
    const zalo = new ZaloClient('token');
    const sendSpy = vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'c1', raw: {} });
    const sent = await sendSchedule('culi_duty', {
      targetDate: '01/09/2026',
      zaloClient: zalo,
      isAutomated: true,
    });
    expect(sent.held).toBeFalsy();
    expect(sent.results.map((row) => row.recipientKey)).toEqual(['squad_culi']);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('reminds the partner leader at 17:00 with copyable doi lines', async () => {
    const zalo = new ZaloClient('token');
    const sendSpy = vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'r1', raw: {} });
    const result = await runExternalDutyReminders(new Date(2026, 8, 1, 17, 0), {
      zaloClient: zalo,
      database: mockDb,
      rowsBySquad: { main: mainSheet, culi: culiSheet },
    });
    expect(result.triggered).toBe(true);
    const notice = String(sendSpy.mock.calls[0][1]);
    expect(sendSpy.mock.calls[0][0]).toBe('leader_1');
    expect(notice).toContain('Ca 3 (11h30 - 13h30) ở tiểu đội 2 đang chưa có người trực');
    expect(notice).toContain('a2 ca3 <tên người trực>');
    expect(notice).toContain('culi ca4 <tên người trực>');
  });

  it('sends the current alert to the partner leader without waiting for 17:00', async () => {
    const zalo = new ZaloClient('token');
    const sendSpy = vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'alert_1', raw: {} });
    const result = await sendPartnerAlertNow({
      zaloClient: zalo,
      database: mockDb,
      now: new Date(2026, 8, 1, 15, 0),
      rowsBySquad: { main: mainSheet, culi: culiSheet },
    });
    expect(result.sent).toBe(true);
    expect(result.leaderId).toBe('leader_1');
    expect(sendSpy).toHaveBeenCalledWith(
      'leader_1',
      expect.stringContaining('a2 ca3 <tên người trực>'),
      expect.objectContaining({
        textStyles: expect.arrayContaining([
          expect.objectContaining({ st: ['b', 'c_db342e'] }),
        ]),
      })
    );
    const styled = String(sendSpy.mock.calls[0][1]);
    const styles = sendSpy.mock.calls[0][2].textStyles as Array<{ start: number; len: number }>;
    const slices = styles.map((style) => styled.slice(style.start, style.start + style.len));
    expect(slices).toContain('Ca 3 (11h30 - 13h30)');
    expect(slices).toContain('tiểu đội 2');
    expect(slices).toContain('a2 ca3 <tên người trực>');
    expect(slices).toContain('tiểu đội culi');
    expect(slices).toContain('culi ca4 <tên người trực>');
  });

  it('asks before replacing a person, and writes only after đúng', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });
    const asked = await handleDoiCommand(
      { text: 'a2 ca2 Nguyễn Chí Khang', chatId: 'editor_2', senderId: 'editor_2', messageId: 'ask_1' },
      {
        now: new Date(2026, 8, 1, 15, 0),
        database: mockDb,
        zaloClient: zalo,
        rowsBySquad: { main: mainSheet },
        skipSend: true,
      }
    );
    expect(asked.reply).toContain('Bạn đổi ca 2 a2 từ Nguyễn Kiến Quốc sang Nguyễn Chí Khang phải không');
    expect(sheetsClient.updateSheetCell).not.toHaveBeenCalled();

    const declined = await handleDoiCommand(
      { text: 'không', chatId: 'editor_2', senderId: 'editor_2' },
      { now: new Date(2026, 8, 1, 15, 1), database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    expect(declined.reply).toContain('Đã giữ nguyên');
    expect(sheetsClient.updateSheetCell).not.toHaveBeenCalled();

    await handleDoiCommand(
      { text: 'a2 ca2 Nguyễn Chí Khang', chatId: 'editor_2', senderId: 'editor_2', messageId: 'ask_2' },
      { now: new Date(2026, 8, 1, 15, 2), database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    const accepted = await handleDoiCommand(
      { text: 'đúng', chatId: 'editor_2', senderId: 'editor_2', messageId: 'yes_1' },
      { now: new Date(2026, 8, 1, 15, 3), database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    expect(accepted.reply).toContain('Đã đổi ca 2 a2 từ Nguyễn Kiến Quốc sang Nguyễn Chí Khang');
    expect(sheetsClient.updateSheetCell).toHaveBeenCalledWith('sheet', 'Tab_Main', 3, 3, 'Nguyễn Chí Khang');
  });

  it('does not write a confirmation onto a cell that changed, and keeps that change pending', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });
    const now = new Date(2026, 8, 1, 15, 0);
    await handleDoiCommand(
      { text: 'a2 ca2 Nguyễn Chí Khang', chatId: 'leader_1', senderId: 'leader_1', messageId: 'ask_move' },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    const changed = mainSheet.map((row) => [...row]);
    changed[3][3] = 'Người Khác';
    const accepted = await handleDoiCommand(
      { text: 'đúng', chatId: 'leader_1', senderId: 'leader_1', messageId: 'yes_move' },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: changed }, skipSend: true }
    );
    expect(accepted.reply).toContain('Người Khác');
    expect(accepted.reply).toContain('Chưa ghi đè');
    expect(sheetsClient.updateSheetCell).not.toHaveBeenCalled();
    expect(getPendingChanges('leader_1', 'leader_1', mockDb)).toHaveLength(1);
  });

  it('writes a confirmation on the current row when a row was inserted above it', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });
    const now = new Date(2026, 8, 1, 15, 0);
    await handleDoiCommand(
      { text: 'a2 ca2 Nguyễn Chí Khang', chatId: 'leader_1', senderId: 'leader_1', messageId: 'ask_shift' },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    const shifted = mainSheet.map((row) => [...row]);
    shifted.splice(3, 0, ['', '', '', '', '', '', '', '']);
    const accepted = await handleDoiCommand(
      { text: 'đúng', chatId: 'leader_1', senderId: 'leader_1', messageId: 'yes_shift' },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: shifted }, skipSend: true }
    );
    expect(sheetsClient.updateSheetCell).toHaveBeenCalledWith('sheet', 'Tab_Main', 4, 3, 'Nguyễn Chí Khang');
    expect(getPendingChanges('leader_1', 'leader_1', mockDb)).toHaveLength(0);
    expect(accepted.success).toBe(true);
  });

  it('keeps the failed confirmation when one write in the batch fails', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });
    const now = new Date(2026, 8, 1, 15, 0);
    await handleDoiCommand(
      {
        text: 'a2 ca1 Người Mới\na2 ca2 Nguyễn Chí Khang',
        chatId: 'leader_1',
        senderId: 'leader_1',
        messageId: 'ask_batch',
      },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    vi.mocked(sheetsClient.updateSheetCell)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(toSheetWriteError(new Error('backend ya29.secret'), 'Tab_Main', 'D4'));
    const accepted = await handleDoiCommand(
      { text: 'đúng', chatId: 'leader_1', senderId: 'leader_1', messageId: 'yes_batch' },
      { now, database: mockDb, zaloClient: zalo, rowsBySquad: { main: mainSheet }, skipSend: true }
    );
    expect(accepted.reply).toContain('Đã đổi ca 1');
    expect(accepted.reply).toContain('Không ghi được Google Sheet');
    expect(accepted.reply).not.toContain('ya29');
    const pending = getPendingChanges('leader_1', 'leader_1', mockDb);
    expect(pending.map((item) => item.caNumber)).toEqual([2]);
    expect(listExternalDutyReports('02/09/2026', 'main', mockDb).map((row) => row.names[0])).toEqual(['Người Mới']);
  });

  it('does not call a sheet read failure fully assigned', async () => {
    const notice = await buildPartnerNotice(new Date(2026, 8, 1, 15, 0), {
      database: mockDb,
      rowsBySquad: { main: [['x']], culi: [['x']] },
    });
    expect(notice.text).not.toContain('Đã xếp đủ');
    expect(notice.text).toContain('Không đọc được lịch tiểu đội 2');
    expect(notice.text).toContain('Không đọc được lịch tiểu đội culi');
    expect(notice.gateMissing).toBe(true);
    expect(notice.culiMissing).toBe(true);
  });

  it('highlights the squad phrase even when the shift header contains it', async () => {
    const tricky = mainSheet.map((row) => [...row]);
    tricky[1][4] = 'Ca 3 tiểu đội 2 (11h30 - 13h30)';
    const filled = culiSheet.map((row) => [...row]);
    filled[2][4] = 'Hồ Nguyễn Thanh Tùng';
    const notice = await buildPartnerNotice(new Date(2026, 8, 1, 15, 0), {
      database: mockDb,
      rowsBySquad: { main: tricky, culi: filled },
    });
    const sorted = [...notice.styles].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].start + sorted[i - 1].len);
    }
    const slices = sorted.map((style) => notice.text.slice(style.start, style.start + style.len));
    expect(slices).toContain('Ca 3 tiểu đội 2 (11h30 - 13h30)');
    expect(slices).toContain('tiểu đội 2');
    expect(renderAlertPreview(notice.text, notice.styles)).toContain('&lt;tên người trực&gt;');
    expect(renderAlertPreview('<b>x</b>', [])).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('refuses a command that is too long before writing', async () => {
    const zalo = new ZaloClient('token');
    vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });
    const result = await handleDoiCommand(
      { text: `a2 ca3 ${'A'.repeat(2000)}`, chatId: 'leader_1', senderId: 'leader_1' },
      {
        now: new Date(2026, 8, 1, 15, 0),
        database: mockDb,
        zaloClient: zalo,
        rowsBySquad: { main: mainSheet },
        skipSend: true,
      }
    );
    expect(result.reply).toBe('Lệnh quá dài.');
    expect(sheetsClient.updateSheetCell).not.toHaveBeenCalled();
  });

  it('waits before sending a second live test alert', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 1, 15, 0, 0));
    try {
      const zalo = new ZaloClient('token');
      const sendSpy = vi.spyOn(zalo, 'sendMessage').mockResolvedValue({ messageId: 'live', raw: {} });
      const first = await sendPartnerAlertNow({
        zaloClient: zalo,
        database: mockDb,
        rowsBySquad: { main: mainSheet, culi: culiSheet },
      });
      const second = await sendPartnerAlertNow({
        zaloClient: zalo,
        database: mockDb,
        rowsBySquad: { main: mainSheet, culi: culiSheet },
      });
      expect(first.sent).toBe(true);
      expect(second.reason).toBe('cooldown');
      expect(sendSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      const third = await sendPartnerAlertNow({
        zaloClient: zalo,
        database: mockDb,
        rowsBySquad: { main: mainSheet, culi: culiSheet },
      });
      expect(third.sent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('external duty dashboard API', () => {
  let server: Server;
  let baseUrl: string;
  let mockDb: Database.Database;

  beforeEach(async () => {
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);
    delete process.env.PARTNER_LEADER_USER_ID;
    configModule.setConfig({
      squads: {},
      recipients: { admin: 'chat_admin' },
      schedules: [],
      reminders: [],
    });
    const app = express();
    app.use(express.json());
    app.use(webRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    mockDb.close();
    storeModule.setDatabase(null);
  });

  it('PUT then GET stores the partner ids, aliases, and reminder times', async () => {
    const put = await fetch(`${baseUrl}/api/external-duty`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partnerLeaderUserId: 'leader_9',
        partnerChatId: 'chat_partner_9',
        extraEditorIdsText: 'editor_a\neditor_b',
        aliasMain: 'a2',
        aliasCuli: 'culi',
        reminderTimesInput: '17:00, 17:45',
        maxReminders: 2,
      }),
    });
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved.config.partnerLeaderUserId).toBe('leader_9');
    expect(saved.config.partnerChatId).toBe('chat_partner_9');
    expect(saved.config.extraEditorIds).toEqual(['editor_a', 'editor_b']);

    const got = await fetch(`${baseUrl}/api/external-duty`);
    const data = await got.json();
    expect(data.config.partnerLeaderUserId).toBe('leader_9');
    expect(data.config.aliasMain).toBe('a2');
    expect(data.config.reminderTimesInput).toBe('17:00, 17:45');
    expect(getExternalDutyConfig(mockDb).maxReminders).toBe(2);
    expect(storeModule.getRecipient('squad_partner', mockDb)?.chat_id).toBe('chat_partner_9');
  });

  it('rejects a duplicated alias and an impossible reminder time', async () => {
    const ok = await fetch(`${baseUrl}/api/external-duty`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partnerLeaderUserId: 'leader_9',
        partnerChatId: 'chat_partner_9',
        aliasMain: 'a2',
        aliasCuli: 'culi',
        reminderTimesInput: '17:00, 17:45',
        maxReminders: 2,
      }),
    });
    expect(ok.status).toBe(200);

    const sameAlias = await fetch(`${baseUrl}/api/external-duty`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasMain: 'a2', aliasCuli: 'A2' }),
    });
    expect(sameAlias.status).toBe(400);
    const sameBody = await sameAlias.json();
    expect(sameBody.success).toBe(false);
    expect(sameBody.error).toContain('khác nhau');

    const badTime = await fetch(`${baseUrl}/api/external-duty`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderTimesInput: '25:99' }),
    });
    expect(badTime.status).toBe(400);

    const kept = await fetch(`${baseUrl}/api/external-duty`);
    const data = await kept.json();
    expect(data.config.aliasCuli).toBe('culi');
    expect(data.config.reminderTimesInput).toBe('17:00, 17:45');
  });
});
