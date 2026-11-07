/**
 * webApi.ts
 *
 * T13 — REST cho section Task proof trên cùng trang admin
 * (ADMIN_USERNAME / ADMIN_PASSWORD, không secret trên form).
 * Đổi setting có hiệu lực lần xử lý tiếp theo (đọc DB mỗi lần).
 */

import { Router, Request, Response } from 'express';
import { rejectCrossOriginWrite } from '../../channels/auth';
import { getDatabase } from '../../store';
import { cancelTask, completeTask } from '../records/lifecycle';
import { listTaskproofMembers } from '../records/members';
import { deleteGroupMap, listGroupMaps, saveGroupMap } from '../records/maps';
import {
  getAllTaskproofSettings,
  getTaskproofSetting,
  setTaskproofSetting,
  TASKPROOF_SETTING_DEFAULTS,
  TASKPROOF_UI_SETTING_KEYS,
  TaskproofSettingKey,
  TaskproofSettings,
} from '../records/settings';
import { listRecentTasks } from '../records/tasks';
import { getTaskByExactShortCode } from '../commands/shortCode';
import { kickTaskCompletionReport } from '../records/report';
import { postEnsureListening, postMaybeStop, postRefreshMembers } from './workerClient';

export const taskproofWebRouter = Router();
taskproofWebRouter.use(rejectCrossOriginWrite);

function handleRouteError(res: Response, error: unknown, statusCode = 500): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(statusCode).json({ success: false, error: message });
}

function parseExcludeUids(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const NUMBER_LIMITS: Partial<Record<TaskproofSettingKey, { min: number; max: number }>> = {
  default_required_count: { min: 1, max: 100 },
  default_deadline_offset_ms: { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 },
  deadline_check_interval_ms: { min: 15_000, max: 60 * 60 * 1000 },
  reminder_interval_ms: { min: 60_000, max: 24 * 60 * 60 * 1000 },
  max_auto_reminders: { min: 0, max: 20 },
  report_poll_interval_ms: { min: 15_000, max: 60 * 60 * 1000 },
  qr_login_timeout_ms: { min: 15_000, max: 300_000 },
  member_cache_max_age_ms: { min: 60_000, max: 30 * 24 * 60 * 60 * 1000 },
  max_mentions_per_message: { min: 1, max: 20 },
  max_reminder_text_len: { min: 50, max: 4000 },
  task_stale_after_ms: { min: 60 * 60 * 1000, max: 30 * 24 * 60 * 60 * 1000 },
  link_pending_ms: { min: 10_000, max: 600_000 },
};

function coerceUiSetting(key: TaskproofSettingKey, value: unknown): TaskproofSettings[TaskproofSettingKey] {
  const fallback = TASKPROOF_SETTING_DEFAULTS[key];
  if (key === 'remind_exclude_uids') {
    return parseExcludeUids(value);
  }
  if (typeof fallback === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    const limits = NUMBER_LIMITS[key];
    if (!limits) return n;
    return Math.min(limits.max, Math.max(limits.min, n));
  }
  return String(value ?? '').trim();
}

taskproofWebRouter.get('/api/taskproof/settings', (_req: Request, res: Response) => {
  try {
    const all = getAllTaskproofSettings();
    const settings: Partial<TaskproofSettings> = {};
    for (const key of TASKPROOF_UI_SETTING_KEYS) {
      settings[key] = all[key] as never;
    }
    res.json({ success: true, settings });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.put('/api/taskproof/settings', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const db = getDatabase();
    for (const [rawKey, rawValue] of Object.entries(body)) {
      if (!TASKPROOF_UI_SETTING_KEYS.includes(rawKey as TaskproofSettingKey)) continue;
      const key = rawKey as TaskproofSettingKey;
      setTaskproofSetting(key, coerceUiSetting(key, rawValue) as never, db);
    }
    const all = getAllTaskproofSettings(db);
    const settings: Partial<TaskproofSettings> = {};
    for (const key of TASKPROOF_UI_SETTING_KEYS) {
      settings[key] = all[key] as never;
    }
    res.json({ success: true, settings });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.get('/api/taskproof/group-map', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, maps: listGroupMaps() });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.post('/api/taskproof/group-map', (req: Request, res: Response) => {
  try {
    const officialChatId = String(req.body?.official_chat_id || '').trim();
    const zcaGroupId = String(req.body?.zca_group_id || '').trim();
    const displayName = req.body?.display_name ? String(req.body.display_name).trim() : null;
    const result = saveGroupMap(officialChatId, zcaGroupId, displayName);
    if (!result.ok) {
      res.status(409).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, maps: listGroupMaps() });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.delete('/api/taskproof/group-map/:officialChatId', (req: Request, res: Response) => {
  try {
    const officialChatId = decodeURIComponent(String(req.params.officialChatId || ''));
    const ok = deleteGroupMap(officialChatId);
    if (!ok) {
      res.status(404).json({ success: false, error: 'map not found' });
      return;
    }
    res.json({ success: true, maps: listGroupMaps() });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.get('/api/taskproof/tasks', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, tasks: listRecentTasks() });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.post('/api/taskproof/tasks/:shortCode/dong', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.shortCode || '');
    const task = getTaskByExactShortCode(getDatabase(), code);
    if (!task) {
      res.status(404).json({ success: false, error: 'task not found' });
      return;
    }
    const ok = completeTask(getDatabase(), task.id);
    if (!ok) {
      res.status(409).json({ success: false, error: 'task already closed' });
      return;
    }
    let reported = false;
    try {
      const results = await kickTaskCompletionReport(task.id);
      reported = results.some((row) => row.reported && row.error !== 'already_reported');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[TaskProof] UI /dong kick báo cáo ${task.short_code} lỗi:`, msg);
    }
    res.json({ success: true, short_code: task.short_code, status: 'completed', reported });
    void postMaybeStop().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProof] UI /dong maybe-stop:', msg);
    });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.post('/api/taskproof/tasks/:shortCode/huy', (req: Request, res: Response) => {
  try {
    const code = String(req.params.shortCode || '');
    const task = getTaskByExactShortCode(getDatabase(), code);
    if (!task) {
      res.status(404).json({ success: false, error: 'task not found' });
      return;
    }
    const ok = cancelTask(getDatabase(), task.id);
    if (!ok) {
      res.status(409).json({ success: false, error: 'task already closed' });
      return;
    }
    res.json({ success: true, short_code: task.short_code, status: 'cancelled' });
    void postMaybeStop().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProof] UI /huy maybe-stop:', msg);
    });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

taskproofWebRouter.post('/api/taskproof/wake-worker', async (_req: Request, res: Response) => {
  try {
    const result = await postEnsureListening();
    res.status(result.status >= 400 ? result.status : 200).json({
      success: result.status < 400,
      state: result.state,
      error: result.error,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      success: false,
      error: message,
      hint: 'Worker không chạy. /gui vẫn dùng được.',
    });
  }
});

taskproofWebRouter.post('/api/taskproof/members/refresh', async (_req: Request, res: Response) => {
  try {
    const result = await postRefreshMembers();
    const members = listTaskproofMembers();
    if (result.status >= 400) {
      const error = typeof result.json.error === 'string' ? result.json.error : 'refresh failed';
      res.status(result.status).json({ success: false, error, members });
      return;
    }
    res.json({ success: true, members, refresh: result.json.refreshed || [] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      success: false,
      error: message,
      members: listTaskproofMembers(),
      hint: 'Worker không chạy. Bấm Đánh thức worker.',
    });
  }
});

taskproofWebRouter.get('/api/taskproof', (_req: Request, res: Response) => {
  try {
    const all = getAllTaskproofSettings();
    const settings: Partial<TaskproofSettings> = {};
    for (const key of TASKPROOF_UI_SETTING_KEYS) {
      settings[key] = all[key] as never;
    }
    res.json({
      success: true,
      settings,
      maps: listGroupMaps(),
      members: listTaskproofMembers(),
      tasks: listRecentTasks(),
      default_required_count: getTaskproofSetting('default_required_count'),
    });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});
