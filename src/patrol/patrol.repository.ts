/**
 * patrol.repository.ts
 *
 * Tầng lưu trữ SQLite cho tính năng đi tuần (Patrol Repository).
 * Quản lý trạng thái hàng ngày `patrol_daily_status` và danh sách thành viên `patrol_members`.
 */

import Database from 'better-sqlite3';
import { getDatabase, safeJsonParse } from '../store';
import {
  PatrolDailyStatus,
  PatrolMember,
  PatrolSiteConfig,
  PatrolShift,
  PatrolSummaryDailyStatus,
} from './patrol.types';

const initializedDbs = new WeakSet<Database.Database>();

/**
 * Đảm bảo các bảng tuần tra đã được khởi tạo trên database kết nối.
 */
export function ensurePatrolTables(database: Database.Database): void {
  if (initializedDbs.has(database)) return;
  initPatrolTables(database);
}

/**
 * Lấy đối tượng database và đảm bảo bảng tuần tra sẵn sàng.
 */
export function getPatrolDb(database?: Database.Database): Database.Database {
  const dbInstance = database || getDatabase();
  ensurePatrolTables(dbInstance);
  return dbInstance;
}

/**
 * Khởi tạo cấu trúc các bảng liên quan đến Patrol.
 */
export function initPatrolTables(database: Database.Database): void {
  initializedDbs.add(database);
  // 1. Bảng cấu hình các site đi tuần (F13 & two-sites)
  database.exec(`
    CREATE TABLE IF NOT EXISTS patrol_site_configs (
      site_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      leader_user_id TEXT NOT NULL DEFAULT '',
      chat_id TEXT NOT NULL DEFAULT '',
      merge_with_sheet INTEGER NOT NULL DEFAULT 0,
      reminder_times TEXT NOT NULL DEFAULT '["06:30","06:35","06:40"]',
      max_reminders INTEGER NOT NULL DEFAULT 3,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Seed default site configs nếu bảng rỗng
  seedDefaultSiteConfigs(database);

  // 2. Bảng lưu trạng thái lịch đi tuần theo ngày và theo từng site (UNIQUE(date, site_key))
  const tableInfo = database.prepare(`PRAGMA table_info(patrol_daily_status)`).all() as any[];
  if (tableInfo.length === 0) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS patrol_daily_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        site_key TEXT NOT NULL DEFAULT 'site_1',
        group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        leader_user_id TEXT NOT NULL,
        submitted INTEGER NOT NULL DEFAULT 0,
        has_patrol INTEGER NOT NULL DEFAULT 1,
        selected_members TEXT,
        shifts TEXT DEFAULT '[]',
        raw_message TEXT,
        message_id TEXT,
        received_at TEXT,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        last_reminder_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(date, site_key)
      );
    `);
  } else {
    const hasSiteKey = tableInfo.some((c) => c.name === 'site_key');
    if (!hasSiteKey) {
      // Migrate từ schema cũ (UNIQUE(date)) sang schema mới (UNIQUE(date, site_key))
      database.exec(`
        CREATE TABLE patrol_daily_status_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          site_key TEXT NOT NULL DEFAULT 'site_1',
          group_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          leader_user_id TEXT NOT NULL,
          submitted INTEGER NOT NULL DEFAULT 0,
          has_patrol INTEGER NOT NULL DEFAULT 1,
          selected_members TEXT,
          shifts TEXT DEFAULT '[]',
          raw_message TEXT,
          message_id TEXT,
          received_at TEXT,
          reminder_count INTEGER NOT NULL DEFAULT 0,
          last_reminder_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(date, site_key)
        );
        INSERT INTO patrol_daily_status_new (id, date, site_key, group_id, sender_id, leader_user_id, submitted, has_patrol, selected_members, shifts, raw_message, message_id, received_at, reminder_count, last_reminder_at, status, created_at, updated_at)
        SELECT id, date, 'site_1', group_id, sender_id, leader_user_id, submitted, 1, selected_members, '[]', raw_message, message_id, received_at, reminder_count, last_reminder_at, status, created_at, updated_at
        FROM patrol_daily_status;
        DROP TABLE patrol_daily_status;
        ALTER TABLE patrol_daily_status_new RENAME TO patrol_daily_status;
      `);
    }
  }

  // 3. Bảng theo dõi trạng thái gửi báo cáo tổng hợp cho Trung đội trưởng
  database.exec(`
    CREATE TABLE IF NOT EXISTS patrol_summary_status (
      date TEXT PRIMARY KEY,
      summary_sent INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      message_id TEXT,
      last_content TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 4. Bảng danh sách thành viên Tiểu đội 1 (cho phép xem/sửa trên Web UI)
  database.exec(`
    CREATE TABLE IF NOT EXISTS patrol_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL UNIQUE,
      aliases TEXT, -- JSON mảng chuỗi biệt danh / tên không dấu
      created_at TEXT NOT NULL
    );
  `);

  // Seed default members cho Ban CHQS phường nếu chưa có
  seedDefaultPatrolMembers(database);
}

/**
 * Seed cấu hình mặc định cho 2 Site nếu chưa tồn tại.
 */
function seedDefaultSiteConfigs(database: Database.Database): void {
  const now = new Date().toISOString();
  const defaultTimes = JSON.stringify(['06:30', '06:35', '06:40']);

  const site1Leader =
    process.env.TIUDOI_1_LEADER_USER_ID ||
    process.env.TIEU_DOI_1_LEADER_USER_ID ||
    process.env.SQUAD_1_LEADER_USER_ID ||
    '';
  const site1Group =
    process.env.PATROL_GROUP_ID || process.env.PATROL_CHAT_ID || '';

  const site2Leader =
    process.env.SITE_2_LEADER_USER_ID ||
    process.env.TIUDOI_2_LEADER_USER_ID ||
    '';
  const site2Group =
    process.env.SITE_2_PATROL_GROUP_ID || '';

  const existing1 = database
    .prepare(`SELECT site_key FROM patrol_site_configs WHERE site_key = 'site_1'`)
    .get();
  if (!existing1) {
    database.prepare(`
      INSERT INTO patrol_site_configs (site_key, display_name, leader_user_id, chat_id, merge_with_sheet, reminder_times, max_reminders, enabled, created_at, updated_at)
      VALUES ('site_1', 'Trụ sở 1 (Tân Phước Khánh)', ?, ?, 1, ?, 3, 1, ?, ?)
    `).run(site1Leader, site1Group, defaultTimes, now, now);
  }

  const existing2 = database
    .prepare(`SELECT site_key FROM patrol_site_configs WHERE site_key = 'site_2'`)
    .get();
  if (!existing2) {
    database.prepare(`
      INSERT INTO patrol_site_configs (site_key, display_name, leader_user_id, chat_id, merge_with_sheet, reminder_times, max_reminders, enabled, created_at, updated_at)
      VALUES ('site_2', 'Trụ sở 2 (Thạnh Hội)', ?, ?, 0, ?, 3, 1, ?, ?)
    `).run(site2Leader, site2Group, defaultTimes, now, now);
  }

  // Chuẩn hóa tên tiếng Việt cho các bản ghi cũ nếu có
  database.exec(`
    UPDATE patrol_site_configs
    SET display_name = 'Trụ sở 1 (Tân Phước Khánh)'
    WHERE site_key = 'site_1' AND (display_name LIKE '%Site 1%' OR display_name = 'site_1' OR display_name LIKE '1.%' OR display_name = 'Tân Phước Khánh');

    UPDATE patrol_site_configs
    SET display_name = 'Trụ sở 2 (Thạnh Hội)'
    WHERE site_key = 'site_2' AND (display_name LIKE '%Site 2%' OR display_name = 'site_2' OR display_name LIKE '2.%' OR display_name = 'Thạnh Hội');
  `);
}

/**
 * Seed danh sách quân số Ban CHQS phường nếu chưa có hoặc bổ sung các thành viên mới.
 */
export function seedDefaultPatrolMembers(database: Database.Database): void {
  const defaultMembers: Array<{ fullName: string; aliases: string[] }> = [
    // Ban CHQS & Tiểu đội 1
    { fullName: 'Nguyễn Minh Thuận', aliases: ['Đầu lựu đạn', 'Đô rê mon', 'Thuan', 'Thuận'] },
    { fullName: 'Đặng Hoàng Hảo', aliases: ['Dón', 'Hao', 'Hảo'] },
    { fullName: 'Đỗ Thanh Tiến', aliases: ['Đóm', 'Tien', 'Tiến'] },
    { fullName: 'Đặng Lưu Trung Hiếu', aliases: ['Hieu', 'Hiếu', 'Trung Hiếu'] },
    { fullName: 'Nguyễn Trung Thành', aliases: ['Thanh', 'Thành', 'Trung Thành'] },
    { fullName: 'Hồ Tuấn Khải', aliases: ['Khai', 'Khải', 'Tuấn Khải'] },
    { fullName: 'Lê Nhật Hào', aliases: ['Hao', 'Hào', 'Nhật Hào'] },
    { fullName: 'Phạm Thái Lâm Khánh', aliases: ['Khanh', 'Khánh', 'Lâm Khánh'] },
    { fullName: 'Nguyễn Huỳnh Trí Nhân', aliases: ['Nhan', 'Nhân', 'Trí Nhân'] },
    { fullName: 'Từ Đại Vỹ', aliases: ['Vy', 'Vỹ', 'Đại Vỹ'] },
    // Ban CHQS & Tiểu đội 2, culi (theo bảng phân công nhiệm vụ)
    { fullName: 'Bùi Nguyễn Đăng Khoa', aliases: ['Khoa', 'Đăng Khoa'] },
    { fullName: 'Bùi Thanh Lộc', aliases: ['Loc', 'Lộc', 'Thanh Lộc'] },
    { fullName: 'Hồ Nguyễn Thanh Tùng', aliases: ['Tung', 'Tùng', 'Thanh Tùng'] },
    { fullName: 'Lê Công Danh', aliases: ['Danh', 'Công Danh'] },
    { fullName: 'Lê Hoàng Vũ', aliases: ['Vu', 'Vũ', 'Hoàng Vũ'] },
    { fullName: 'Lương Văn Tài', aliases: ['Tai', 'Tài', 'Văn Tài'] },
    { fullName: 'Mai Đức Tín', aliases: ['Tin', 'Tín', 'Đức Tín', 'Mai Đức Tính'] },
    { fullName: 'Nguyễn Kiến Quốc', aliases: ['Quoc', 'Quốc', 'Kiến Quốc'] },
    { fullName: 'Nguyễn Phi Hoàng', aliases: ['Hoang', 'Hoàng', 'Phi Hoàng'] },
    { fullName: 'Nguyễn Phúc Nhật Quang', aliases: ['Quang', 'Nhật Quang'] },
    { fullName: 'Nguyễn Phạm Phú Huy', aliases: ['Huy', 'Phú Huy'] },
    { fullName: 'Nguyễn Trần Quốc Bảo', aliases: ['Bao', 'Bảo', 'Quốc Bảo'] },
    { fullName: 'Nguyễn Võ Minh Vương', aliases: ['Vuong', 'Vương', 'Minh Vương'] },
    { fullName: 'Phạm Hoàng Phúc', aliases: ['Hoang Phuc', 'Hoàng Phúc'] },
    { fullName: 'Phạm Hữu Luân', aliases: ['Luan', 'Luân', 'Hữu Luân'] },
    { fullName: 'Thái Hoàng Phúc', aliases: ['Thai Phuc', 'Thái Phúc'] },
  ];

  const now = new Date().toISOString();
  const insertStmt = database.prepare(
    `INSERT OR IGNORE INTO patrol_members (full_name, aliases, created_at) VALUES (?, ?, ?)`
  );

  const insertBatch = database.transaction(() => {
    for (const m of defaultMembers) {
      insertStmt.run(m.fullName, JSON.stringify(m.aliases), now);
    }
  });

  try {
    insertBatch();
  } catch (err: unknown) {
    console.warn('[PatrolRepo] Không thể seed patrol_members:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Lấy tất cả cấu hình các site tuần tra.
 */
export function getPatrolSiteConfigs(database?: Database.Database): PatrolSiteConfig[] {
  const d = getPatrolDb(database);
  try {
    const rows = d
      .prepare(`SELECT site_key, display_name, leader_user_id, chat_id, merge_with_sheet, reminder_times, max_reminders, enabled, created_at, updated_at FROM patrol_site_configs ORDER BY site_key ASC`)
      .all() as any[];

    return rows.map((r) => ({
      siteKey: r.site_key,
      displayName: r.display_name,
      leaderUserId: r.leader_user_id || '',
      chatId: r.chat_id || '',
      mergeWithSheet: Boolean(r.merge_with_sheet),
      reminderTimes: safeJsonParse<string[]>(r.reminder_times, ['06:30', '06:35', '06:40']),
      maxReminders: r.max_reminders || 3,
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch (err: unknown) {
    console.error('[PatrolRepo] Lỗi đọc danh sách patrol_site_configs:', err);
    return [];
  }
}

/**
 * Lấy cấu hình một site cụ thể theo siteKey.
 */
export function getPatrolSiteConfig(
  siteKey: string,
  database?: Database.Database
): PatrolSiteConfig | null {
  const d = getPatrolDb(database);
  const row = d
    .prepare(
      `SELECT site_key, display_name, leader_user_id, chat_id, merge_with_sheet, reminder_times, max_reminders, enabled, created_at, updated_at
       FROM patrol_site_configs WHERE site_key = ?`
    )
    .get(siteKey) as any;

  if (!row) return null;

  return {
    siteKey: row.site_key,
    displayName: row.display_name,
    leaderUserId: row.leader_user_id || '',
    chatId: row.chat_id || '',
    mergeWithSheet: Boolean(row.merge_with_sheet),
    reminderTimes: safeJsonParse<string[]>(row.reminder_times, ['06:30', '06:35', '06:40']),
    maxReminders: row.max_reminders || 3,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lưu hoặc cập nhật cấu hình cho một site.
 */
export function savePatrolSiteConfig(
  config: Partial<PatrolSiteConfig> & { siteKey: string },
  database?: Database.Database
): PatrolSiteConfig {
  const d = getPatrolDb(database);
  const now = new Date().toISOString();
  const existing = getPatrolSiteConfig(config.siteKey, d);

  const displayName = config.displayName ?? existing?.displayName ?? config.siteKey;
  const leaderUserId = config.leaderUserId !== undefined ? config.leaderUserId.trim() : (existing?.leaderUserId || '');
  const chatId = config.chatId !== undefined ? config.chatId.trim() : (existing?.chatId || '');
  const mergeWithSheet = config.mergeWithSheet !== undefined ? (config.mergeWithSheet ? 1 : 0) : (existing?.mergeWithSheet ? 1 : 0);
  const reminderTimes = JSON.stringify(config.reminderTimes ?? existing?.reminderTimes ?? ['06:30', '06:35', '06:40']);
  const maxReminders = config.maxReminders ?? existing?.maxReminders ?? 3;
  const enabled = config.enabled !== undefined ? (config.enabled ? 1 : 0) : (existing?.enabled ? 1 : 0);

  if (existing) {
    d.prepare(`
      UPDATE patrol_site_configs
      SET display_name = ?,
          leader_user_id = ?,
          chat_id = ?,
          merge_with_sheet = ?,
          reminder_times = ?,
          max_reminders = ?,
          enabled = ?,
          updated_at = ?
      WHERE site_key = ?
    `).run(
      displayName,
      leaderUserId,
      chatId,
      mergeWithSheet,
      reminderTimes,
      maxReminders,
      enabled,
      now,
      config.siteKey
    );
  } else {
    d.prepare(`
      INSERT INTO patrol_site_configs (
        site_key, display_name, leader_user_id, chat_id, merge_with_sheet,
        reminder_times, max_reminders, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.siteKey,
      displayName,
      leaderUserId,
      chatId,
      mergeWithSheet,
      reminderTimes,
      maxReminders,
      enabled,
      now,
      now
    );
  }

  return getPatrolSiteConfig(config.siteKey, d)!;
}

/**
 * Lấy trạng thái đi tuần của một ngày cụ thể (DD/MM/YYYY).
 * Hỗ trợ chữ ký tương thích ngược: getPatrolDailyStatus(date, database) hoặc getPatrolDailyStatus(date, siteKey, database)
 */
export function getPatrolDailyStatus(
  date: string,
  siteKeyOrDb?: string | Database.Database,
  database?: Database.Database
): PatrolDailyStatus | null {
  let siteKey = 'site_1';
  let d: Database.Database;

  if (typeof siteKeyOrDb === 'string') {
    siteKey = siteKeyOrDb;
    d = getPatrolDb(database);
  } else if (siteKeyOrDb && typeof siteKeyOrDb === 'object') {
    d = siteKeyOrDb;
  } else {
    d = getPatrolDb(database);
  }

  const row = d
    .prepare(
      `SELECT id, date, site_key, group_id, sender_id, leader_user_id, submitted,
              has_patrol, selected_members, shifts, raw_message, message_id, received_at,
              reminder_count, last_reminder_at, status, created_at, updated_at
       FROM patrol_daily_status
       WHERE date = ? AND site_key = ?`
    )
    .get(date, siteKey) as any;

  if (!row) return null;

  const members: string[] = safeJsonParse<string[]>(row.selected_members, []);
  const shifts: PatrolShift[] = safeJsonParse<PatrolShift[]>(row.shifts, []);

  return {
    id: row.id,
    date: row.date,
    siteKey: row.site_key || siteKey,
    groupId: row.group_id,
    senderId: row.sender_id,
    leaderUserId: row.leader_user_id,
    submitted: Boolean(row.submitted),
    hasPatrol: row.has_patrol !== undefined ? Boolean(row.has_patrol) : true,
    selectedMembers: members,
    shifts: shifts.length > 0 ? shifts : (members.length > 0 ? [{ shiftNumber: 1, shiftLabel: 'Ca 1', members }] : []),
    rawMessage: row.raw_message || undefined,
    messageId: row.message_id || undefined,
    receivedAt: row.received_at || undefined,
    reminderCount: row.reminder_count || 0,
    lastReminderAt: row.last_reminder_at || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lấy danh sách trạng thái của tất cả các site trong ngày.
 */
export function getAllPatrolDailyStatusForDate(
  date: string,
  database?: Database.Database
): PatrolDailyStatus[] {
  const d = getPatrolDb(database);
  const rows = d
    .prepare(
      `SELECT id, date, site_key, group_id, sender_id, leader_user_id, submitted,
              has_patrol, selected_members, shifts, raw_message, message_id, received_at,
              reminder_count, last_reminder_at, status, created_at, updated_at
       FROM patrol_daily_status
       WHERE date = ? ORDER BY site_key ASC`
    )
    .all(date) as any[];

  return rows.map((row) => {
    const members: string[] = safeJsonParse<string[]>(row.selected_members, []);
    const shifts: PatrolShift[] = safeJsonParse<PatrolShift[]>(row.shifts, []);

    return {
      id: row.id,
      date: row.date,
      siteKey: row.site_key,
      groupId: row.group_id,
      senderId: row.sender_id,
      leaderUserId: row.leader_user_id,
      submitted: Boolean(row.submitted),
      hasPatrol: row.has_patrol !== undefined ? Boolean(row.has_patrol) : true,
      selectedMembers: members,
      shifts: shifts.length > 0 ? shifts : (members.length > 0 ? [{ shiftNumber: 1, shiftLabel: 'Ca 1', members }] : []),
      rawMessage: row.raw_message || undefined,
      messageId: row.message_id || undefined,
      receivedAt: row.received_at || undefined,
      reminderCount: row.reminder_count || 0,
      lastReminderAt: row.last_reminder_at || null,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/**
 * Lưu hoặc cập nhật việc nộp lịch đi tuần của một site.
 */
export function savePatrolSubmission(
  params: {
    date: string;
    siteKey?: string;
    groupId: string;
    senderId: string;
    leaderUserId: string;
    selectedMembers: string[];
    shifts?: PatrolShift[];
    hasPatrol?: boolean;
    rawMessage?: string;
    messageId?: string;
    receivedAt?: string;
  },
  database?: Database.Database
): PatrolDailyStatus {
  const d = getPatrolDb(database);
  const now = new Date().toISOString();
  const siteKey = params.siteKey || 'site_1';
  const receivedAt = params.receivedAt || now;
  const hasPatrol = params.hasPatrol !== undefined ? (params.hasPatrol ? 1 : 0) : 1;
  const statusStr = hasPatrol ? 'submitted' : 'no_patrol';

  let shifts = params.shifts || [];
  if (shifts.length === 0 && params.selectedMembers.length > 0) {
    shifts = [{ shiftNumber: 1, shiftLabel: 'Ca 1', members: params.selectedMembers }];
  }

  let selectedMembers = params.selectedMembers;
  if (selectedMembers.length === 0 && shifts.length > 0) {
    selectedMembers = shifts.flatMap((s) => s.members);
  }

  const membersJson = JSON.stringify(selectedMembers);
  const shiftsJson = JSON.stringify(shifts);

  const existing = getPatrolDailyStatus(params.date, siteKey, d);

  if (existing) {
    d.prepare(
      `UPDATE patrol_daily_status
       SET group_id = ?,
           sender_id = ?,
           leader_user_id = ?,
           submitted = 1,
           has_patrol = ?,
           selected_members = ?,
           shifts = ?,
           raw_message = ?,
           message_id = ?,
           received_at = ?,
           status = ?,
           updated_at = ?
       WHERE date = ? AND site_key = ?`
    ).run(
      params.groupId,
      params.senderId,
      params.leaderUserId,
      hasPatrol,
      membersJson,
      shiftsJson,
      params.rawMessage || null,
      params.messageId || null,
      receivedAt,
      statusStr,
      now,
      params.date,
      siteKey
    );
  } else {
    d.prepare(
      `INSERT INTO patrol_daily_status (
         date, site_key, group_id, sender_id, leader_user_id, submitted,
         has_patrol, selected_members, shifts, raw_message, message_id, received_at,
         reminder_count, last_reminder_at, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`
    ).run(
      params.date,
      siteKey,
      params.groupId,
      params.senderId,
      params.leaderUserId,
      hasPatrol,
      membersJson,
      shiftsJson,
      params.rawMessage || null,
      params.messageId || null,
      receivedAt,
      statusStr,
      now,
      now
    );
  }

  return getPatrolDailyStatus(params.date, siteKey, d)!;
}

/**
 * Cập nhật số lần nhắc nhở và thời gian nhắc nhở gần nhất của site.
 */
export function updatePatrolReminder(
  params: {
    date: string;
    siteKey?: string;
    groupId: string;
    leaderUserId: string;
    reminderCount: number;
    lastReminderAt: string;
  },
  database?: Database.Database
): PatrolDailyStatus {
  const d = getPatrolDb(database);
  const now = new Date().toISOString();
  const siteKey = params.siteKey || 'site_1';

  const existing = getPatrolDailyStatus(params.date, siteKey, d);

  if (existing) {
    d.prepare(
      `UPDATE patrol_daily_status
       SET reminder_count = ?,
           last_reminder_at = ?,
           updated_at = ?
       WHERE date = ? AND site_key = ?`
    ).run(params.reminderCount, params.lastReminderAt, now, params.date, siteKey);
  } else {
    d.prepare(
      `INSERT INTO patrol_daily_status (
         date, site_key, group_id, sender_id, leader_user_id, submitted,
         has_patrol, selected_members, shifts, reminder_count, last_reminder_at, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, '', ?, 0, 1, '[]', '[]', ?, ?, 'pending', ?, ?)`
    ).run(
      params.date,
      siteKey,
      params.groupId,
      params.leaderUserId,
      params.reminderCount,
      params.lastReminderAt,
      now,
      now
    );
  }

  return getPatrolDailyStatus(params.date, siteKey, d)!;
}

/**
 * Lấy trạng thái gửi báo cáo tổng hợp cho Trung đội trưởng trong ngày.
 */
export function getPatrolSummaryStatus(
  date: string,
  database?: Database.Database
): PatrolSummaryDailyStatus | null {
  const d = getPatrolDb(database);
  const row = d
    .prepare(
      `SELECT date, summary_sent, sent_at, message_id, last_content, created_at, updated_at
       FROM patrol_summary_status WHERE date = ?`
    )
    .get(date) as any;

  if (!row) return null;

  return {
    date: row.date,
    summarySent: Boolean(row.summary_sent),
    sentAt: row.sent_at || null,
    messageId: row.message_id || null,
    lastContent: row.last_content || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lưu trạng thái gửi báo cáo tổng hợp cho Trung đội trưởng trong ngày.
 */
export function savePatrolSummaryStatus(
  params: {
    date: string;
    summarySent: boolean;
    sentAt?: string;
    messageId?: string | null;
    lastContent?: string | null;
  },
  database?: Database.Database
): PatrolSummaryDailyStatus {
  const d = getPatrolDb(database);
  const now = new Date().toISOString();
  const existing = getPatrolSummaryStatus(params.date, d);

  if (existing) {
    d.prepare(`
      UPDATE patrol_summary_status
      SET summary_sent = ?,
          sent_at = ?,
          message_id = ?,
          last_content = ?,
          updated_at = ?
      WHERE date = ?
    `).run(
      params.summarySent ? 1 : 0,
      params.sentAt || now,
      params.messageId || null,
      params.lastContent || null,
      now,
      params.date
    );
  } else {
    d.prepare(`
      INSERT INTO patrol_summary_status (
        date, summary_sent, sent_at, message_id, last_content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.date,
      params.summarySent ? 1 : 0,
      params.sentAt || now,
      params.messageId || null,
      params.lastContent || null,
      now,
      now
    );
  }

  return getPatrolSummaryStatus(params.date, d)!;
}

/**
 * Quản lý danh sách thành viên Tiểu đội 1 (CRUD).
 */
export function getPatrolMembers(database?: Database.Database): PatrolMember[] {
  const d = getPatrolDb(database);
  try {
    const rows = d
      .prepare(`SELECT id, full_name, aliases, created_at FROM patrol_members ORDER BY id ASC`)
      .all() as any[];

    return rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      aliases: safeJsonParse<string[]>(r.aliases, []),
      createdAt: r.created_at,
    }));
  } catch (err: unknown) {
    console.error('[PatrolRepo] Lỗi đọc danh sách patrol_members:', err);
    return [];
  }
}

export function addPatrolMember(
  fullName: string,
  aliases: string[] = [],
  database?: Database.Database
): PatrolMember {
  const d = getPatrolDb(database);
  const now = new Date().toISOString();
  const trimmedName = fullName.trim();
  const aliasesJson = JSON.stringify(aliases.map((a) => a.trim()).filter((a) => a.length > 0));

  const res = d
    .prepare(
      `INSERT INTO patrol_members (full_name, aliases, created_at)
       VALUES (?, ?, ?)`
    )
    .run(trimmedName, aliasesJson, now);

  return {
    id: Number(res.lastInsertRowid),
    fullName: trimmedName,
    aliases,
    createdAt: now,
  };
}

export function updatePatrolMember(
  id: number,
  fullName: string,
  aliases: string[] = [],
  database?: Database.Database
): boolean {
  const d = getPatrolDb(database);
  const trimmedName = fullName.trim();
  const aliasesJson = JSON.stringify(aliases.map((a) => a.trim()).filter((a) => a.length > 0));

  const res = d
    .prepare(
      `UPDATE patrol_members
       SET full_name = ?, aliases = ?
       WHERE id = ?`
    )
    .run(trimmedName, aliasesJson, id);

  return res.changes > 0;
}

export function deletePatrolMember(id: number, database?: Database.Database): boolean {
  const d = getPatrolDb(database);
  const res = d.prepare(`DELETE FROM patrol_members WHERE id = ?`).run(id);
  return res.changes > 0;
}

/**
 * Đặt lại (reset/xóa) trạng thái tuần tra và số lần nhắc nhở để phục vụ kiểm thử.
 */
export function resetPatrolDailyStatus(
  date?: string,
  siteKey?: string,
  database?: Database.Database
): { deletedDaily: number; deletedSummary: number } {
  const d = getPatrolDb(database);
  let deletedDaily: number;
  let deletedSummary = 0;

  if (date && siteKey) {
    const info = d.prepare(`DELETE FROM patrol_daily_status WHERE date = ? AND site_key = ?`).run(date, siteKey);
    deletedDaily = info.changes;
  } else if (date) {
    const info1 = d.prepare(`DELETE FROM patrol_daily_status WHERE date = ?`).run(date);
    const info2 = d.prepare(`DELETE FROM patrol_summary_status WHERE date = ?`).run(date);
    deletedDaily = info1.changes;
    deletedSummary = info2.changes;
  } else {
    const info1 = d.prepare(`DELETE FROM patrol_daily_status`).run();
    const info2 = d.prepare(`DELETE FROM patrol_summary_status`).run();
    deletedDaily = info1.changes;
    deletedSummary = info2.changes;
  }

  return { deletedDaily, deletedSummary };
}
