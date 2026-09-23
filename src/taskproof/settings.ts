/**
 * settings.ts
 *
 * Cài đặt vận hành task-proof (T13). Đọc mỗi lần dùng, không cache lâu:
 *   giá trị trong DB  >  default trong code
 * Không đọc secret từ file / env vào bảng này. Secret chỉ nằm ở env
 * (INTERNAL_API_KEY, ADMIN_PASSWORD, ZALO_BOT_TOKEN, …).
 */

import Database from 'better-sqlite3';
import { getDatabase, getRecipient } from '../store';

export interface TaskproofSettings {
  ocr_match_threshold: number;
  default_required_count: number;
  default_deadline_offset_ms: number;
  deadline_check_interval_ms: number;
  reminder_interval_ms: number;
  max_auto_reminders: number;
  report_poll_interval_ms: number;
  qr_login_timeout_ms: number;
  member_cache_max_age_ms: number;
  max_mentions_per_message: number;
  max_reminder_text_len: number;
  task_stale_after_ms: number;
  link_pending_ms: number;
  default_report_group_id: string;
  admin_official_chat_id: string;
  official_bot_uid: string;
  zca_own_uid: string;
  remind_exclude_uids: string[];
}

export type TaskproofSettingKey = keyof TaskproofSettings;

export const TASKPROOF_SETTING_DEFAULTS: TaskproofSettings = {
  ocr_match_threshold: 0.5,
  default_required_count: 12,
  default_deadline_offset_ms: 3_600_000,
  deadline_check_interval_ms: 60_000,
  reminder_interval_ms: 3_600_000,
  max_auto_reminders: 3,
  report_poll_interval_ms: 60_000,
  qr_login_timeout_ms: 90_000,
  member_cache_max_age_ms: 86_400_000,
  max_mentions_per_message: 8,
  max_reminder_text_len: 1500,
  task_stale_after_ms: 604_800_000,
  link_pending_ms: 120_000,
  default_report_group_id: '',
  admin_official_chat_id: '',
  official_bot_uid: '',
  zca_own_uid: '',
  remind_exclude_uids: [],
};

export function getTaskproofExcludeUids(database?: Database.Database): Set<string> {
  const zcaOwn = database
    ? getTaskproofSetting('zca_own_uid', database)
    : getTaskproofSetting('zca_own_uid');
  const officialBot = database
    ? getTaskproofSetting('official_bot_uid', database)
    : getTaskproofSetting('official_bot_uid');
  const remindExclude = database
    ? getTaskproofSetting('remind_exclude_uids', database)
    : getTaskproofSetting('remind_exclude_uids');

  const out = new Set<string>();
  if (zcaOwn?.trim()) out.add(zcaOwn.trim());
  if (officialBot?.trim()) out.add(officialBot.trim());
  if (Array.isArray(remindExclude)) {
    for (const id of remindExclude) {
      const s = (id || '').trim();
      if (s) out.add(s);
    }
  }
  return out;
}

const FORBIDDEN_SETTING_KEYS = new Set([
  'INTERNAL_API_KEY',
  'INTERNAL_CRON_TOKEN',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'WEB_UI_USER',
  'WEB_UI_PASSWORD',
  'ZALO_BOT_TOKEN',
  'ZALO_WEBHOOK_SECRET',
  'PUBLIC_BASE_URL',
  'ZCA_SESSION_FILE_PATH',
  'PROOF_DIR',
]);

/** Khóa chỉnh trên Web UI (Section 8.12 A). Secret / PUBLIC_BASE_URL không nằm đây. */
export const TASKPROOF_UI_SETTING_KEYS: TaskproofSettingKey[] = [
  'official_bot_uid',
  'zca_own_uid',
  'remind_exclude_uids',
  'default_report_group_id',
  'admin_official_chat_id',
  'max_mentions_per_message',
  'max_reminder_text_len',
  'ocr_match_threshold',
  'default_required_count',
  'default_deadline_offset_ms',
  'max_auto_reminders',
  'reminder_interval_ms',
  'task_stale_after_ms',
  'link_pending_ms',
  'qr_login_timeout_ms',
];

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

function coerceSetting<K extends TaskproofSettingKey>(
  key: K,
  parsed: unknown
): TaskproofSettings[K] {
  const fallback = TASKPROOF_SETTING_DEFAULTS[key];
  if (Array.isArray(fallback)) {
    return (Array.isArray(parsed) ? parsed.map(String) : fallback) as TaskproofSettings[K];
  }
  if (typeof parsed !== typeof fallback) {
    return fallback;
  }
  if (typeof parsed === 'string') {
    return parsed.trim() as TaskproofSettings[K];
  }
  return parsed as TaskproofSettings[K];
}

export function getTaskproofSetting<K extends TaskproofSettingKey>(
  key: K,
  database?: Database.Database
): TaskproofSettings[K] {
  const fallback = TASKPROOF_SETTING_DEFAULTS[key];
  try {
    const row = dbOf(database)
      .prepare(`SELECT value_json FROM taskproof_settings WHERE key = ?`)
      .get(key) as { value_json: string } | undefined;
    if (!row) return fallback;
    return coerceSetting(key, JSON.parse(row.value_json));
  } catch {
    return fallback;
  }
}

export function getAllTaskproofSettings(database?: Database.Database): TaskproofSettings {
  const result: TaskproofSettings = {
    ...TASKPROOF_SETTING_DEFAULTS,
    remind_exclude_uids: [...TASKPROOF_SETTING_DEFAULTS.remind_exclude_uids],
  };
  try {
    const rows = dbOf(database)
      .prepare(`SELECT key, value_json FROM taskproof_settings`)
      .all() as Array<{ key: string; value_json: string }>;
    for (const row of rows) {
      if (!(row.key in TASKPROOF_SETTING_DEFAULTS)) continue;
      const key = row.key as TaskproofSettingKey;
      try {
        result[key] = coerceSetting(key, JSON.parse(row.value_json)) as never;
      } catch {
        // giữ default nếu JSON hỏng
      }
    }
  } catch {
    // bảng chưa có — trả default trong code
  }
  return result;
}

export function setTaskproofSetting<K extends TaskproofSettingKey>(
  key: K,
  value: TaskproofSettings[K],
  database?: Database.Database
): void {
  if (FORBIDDEN_SETTING_KEYS.has(key)) {
    throw new Error(`Refusing to store secret key in taskproof_settings: ${key}`);
  }
  dbOf(database)
    .prepare(
      `INSERT INTO taskproof_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), Date.now());
}

/**
 * Seed default khi thiếu row. admin_official_chat_id copy từ
 * recipients.admin nếu đang trống (Section 5.2).
 */
export function seedTaskproofSettings(database: Database.Database): void {
  const now = Date.now();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO taskproof_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)`
  );

  for (const [key, value] of Object.entries(TASKPROOF_SETTING_DEFAULTS)) {
    insert.run(key, JSON.stringify(value), now);
  }

  // One-shot: seed cũ = 1 → 12. Sau khi đã migrate, admin đặt 1 thì giữ nguyên.
  const migrated = database
    .prepare(`SELECT value_json FROM taskproof_settings WHERE key = ?`)
    .get('_migrated_required_count_1_to_12') as { value_json: string } | undefined;
  if (!migrated) {
    if (getTaskproofSetting('default_required_count', database) === 1) {
      setTaskproofSetting('default_required_count', 12, database);
    }
    database
      .prepare(
        `INSERT INTO taskproof_settings (key, value_json, updated_at)
         VALUES ('_migrated_required_count_1_to_12', 'true', ?)`
      )
      .run(now);
  }

  const currentAdmin = getTaskproofSetting('admin_official_chat_id', database);
  if (!currentAdmin) {
    try {
      const admin = getRecipient('admin', database);
      if (admin?.chat_id) {
        setTaskproofSetting('admin_official_chat_id', admin.chat_id, database);
      }
    } catch {
      // recipients chưa sẵn sàng — để trống
    }
  }
}
