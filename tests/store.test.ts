import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initTables,
  saveLastMessage,
  getLastMessageId,
  hasSentToday,
  appendSendHistory,
  getRecentSendHistory,
  saveRuntimeConfigOverride,
  getRuntimeConfigOverride,
  getAllRuntimeConfigOverrides,
  getAllRecipients,
  getRecipient,
  saveRecipient,
  deleteRecipient,
  seedDefaultRecipients,
  resetScheduleSentStatus,
} from '../src/store';

describe('SQLite Store Layer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('manages last_message and idempotency correctly', () => {
    expect(getLastMessageId('main_duty', 'chat_123', db)).toBeNull();
    expect(hasSentToday('main_duty', 'chat_123', '01/09/2026', db)).toBe(false);

    // Lưu tin nhắn thành công
    saveLastMessage('main_duty', 'chat_123', 'msg_001', '01/09/2026', db);

    expect(getLastMessageId('main_duty', 'chat_123', db)).toBe('msg_001');
    expect(hasSentToday('main_duty', 'chat_123', '01/09/2026', db)).toBe(true);
    // Khác ngày -> false
    expect(hasSentToday('main_duty', 'chat_123', '02/09/2026', db)).toBe(false);

    // Cập nhật tin nhắn mới
    saveLastMessage('main_duty', 'chat_123', 'msg_002', '01/09/2026', db);
    expect(getLastMessageId('main_duty', 'chat_123', db)).toBe('msg_002');
  });

  it('records send history and retrieves in descending order', () => {
    appendSendHistory(
      {
        timestamp: '2026-09-01T05:30:00.000Z',
        schedule_key: 'main_duty',
        chat_id: 'chat_123',
        result: 'success',
        old_message_deleted: true,
      },
      db
    );

    appendSendHistory(
      {
        timestamp: '2026-09-01T05:31:00.000Z',
        schedule_key: 'culi_duty',
        chat_id: 'chat_456',
        result: 'failure',
        error: 'Network timeout',
        old_message_deleted: false,
      },
      db
    );

    const history = getRecentSendHistory(10, db);
    expect(history).toHaveLength(2);
    expect(history[0].schedule_key).toBe('culi_duty');
    expect(history[0].result).toBe('failure');
    expect(history[0].error).toBe('Network timeout');
    expect(history[0].old_message_deleted).toBe(false);

    expect(history[1].schedule_key).toBe('main_duty');
    expect(history[1].result).toBe('success');
    expect(history[1].old_message_deleted).toBe(true);
  });

  it('manages runtime config overrides (F9)', () => {
    expect(getRuntimeConfigOverride('main', db)).toBeNull();

    saveRuntimeConfigOverride(
      'main',
      {
        sheet_tab_gate_duty: 'Tab Mới Tháng 10',
      },
      db
    );

    let override = getRuntimeConfigOverride('main', db);
    expect(override?.sheet_tab_gate_duty).toBe('Tab Mới Tháng 10');

    // Cập nhật thêm auto_send_time
    saveRuntimeConfigOverride(
      'main_duty',
      {
        auto_send_time: '06:00',
        enabled: false,
      },
      db
    );

    const all = getAllRuntimeConfigOverrides(db);
    expect(all['main'].sheet_tab_gate_duty).toBe('Tab Mới Tháng 10');
    expect(all['main_duty'].auto_send_time).toBe('06:00');
    expect(all['main_duty'].enabled).toBe(false);
  });

  it('manages recipients CRUD and schedule assignment override (F12)', () => {
    // 1. Ban đầu danh sách rỗng
    expect(getAllRecipients(db)).toHaveLength(0);
    expect(getRecipient('group_test', db)).toBeNull();

    // 2. Thêm mới recipient
    saveRecipient(
      {
        key: 'group_test',
        display_name: 'Nhóm Test',
        chat_id: 'chat_9999',
      },
      db
    );

    const r1 = getRecipient('group_test', db);
    expect(r1).not.toBeNull();
    expect(r1?.display_name).toBe('Nhóm Test');
    expect(r1?.chat_id).toBe('chat_9999');

    // 3. Cập nhật recipient
    saveRecipient(
      {
        key: 'group_test',
        display_name: 'Nhóm Test Đổi Tên',
        chat_id: 'chat_8888',
      },
      db
    );
    const r2 = getRecipient('group_test', db);
    expect(r2?.display_name).toBe('Nhóm Test Đổi Tên');
    expect(r2?.chat_id).toBe('chat_8888');

    // 4. Gán recipient vào schedule qua runtime_config override
    saveRuntimeConfigOverride(
      'main_duty',
      {
        recipients: ['group_test', 'admin'],
      },
      db
    );

    const override = getRuntimeConfigOverride('main_duty', db);
    expect(override?.recipients).toEqual(['group_test', 'admin']);

    // 5. Xóa recipient -> tự động gỡ khỏi schedule gán
    const delRes = deleteRecipient('group_test', db);
    expect(delRes.deletedKey).toBe('group_test');
    expect(delRes.affectedSchedules).toContain('main_duty');
    expect(getRecipient('group_test', db)).toBeNull();

    // Kiểm tra schedule đã tự gỡ group_test
    const updatedOverride = getRuntimeConfigOverride('main_duty', db);
    expect(updatedOverride?.recipients).toEqual(['admin']);
    expect(updatedOverride?.recipients).not.toContain('group_test');

    // 6. Test seedDefaultRecipients
    seedDefaultRecipients(
      [
        { key: 'admin', display_name: 'Admin', chat_id: '123' },
        { key: 'main', display_name: 'Tiểu đội', chat_id: '456' },
      ],
      db
    );
    expect(getAllRecipients(db)).toHaveLength(2);
  });

  it('resets schedule sent status (last_message and send_history)', () => {
    saveLastMessage('main_duty', 'chat_123', 'msg_1', '16/09/2026', db);
    saveLastMessage('culi_duty', 'chat_456', 'msg_2', '16/09/2026', db);
    expect(hasSentToday('main_duty', 'chat_123', '16/09/2026', db)).toBe(true);

    const res = resetScheduleSentStatus('16/09/2026', 'main_duty', db);
    expect(res.deletedLastMessage).toBe(1);
    expect(hasSentToday('main_duty', 'chat_123', '16/09/2026', db)).toBe(false);
    expect(hasSentToday('culi_duty', 'chat_456', '16/09/2026', db)).toBe(true);

    const resAll = resetScheduleSentStatus('16/09/2026', undefined, db);
    expect(resAll.deletedLastMessage).toBe(1);
    expect(hasSentToday('culi_duty', 'chat_456', '16/09/2026', db)).toBe(false);
  });
});
