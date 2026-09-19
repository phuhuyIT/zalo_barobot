/**
 * runtime.ts
 *
 * Trạng thái login worker (Step 5): session trước, QR bất đồng bộ.
 * ensure-listening trả về ngay khi cần QR — webhook không chờ quét.
 * Step 6: /lienket — pending + tin nhóm tiếp theo (zca threadId).
 * Step 7: cache thành viên + /nhac (mention / @all). Timer tự động = Step 8.
 * Ảnh nhóm chưa map không OCR. Listener đầy đủ (stop/idle) = Step 8.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getInternalApiKey, getPublicBaseUrl, getQrTmpDir, getSessionFilePath } from '../env';
import { getTaskproofSetting } from '../settings';
import { peekWorkerDatabase } from '../store';
import { looksLikeTaskproofCommand } from '../commands/parser';
import { deliverQr, postLoginResult, postLinkResult } from './callbacks';
import { conflictForPair, shouldOcrZcaGroup, upsertGroupMap } from './groupMap';
import {
  listCachedMembers,
  listLinkedOpenZcaGroups,
  refreshMemberCache,
} from './memberCache';
import {
  collectExcludeUids,
  computeMissing,
  planReminder,
  ReminderKind,
} from './reminders';
import { loadSession, saveSession, ZcaCredentials } from './session';
import { createZcaLoginPort, ZcaInboundMessage, ZcaLoginPort } from './zcaAdapter';

export type ListenState =
  | 'listening'
  | 'reusing_session'
  | 'qr_required'
  | 'pending_link'
  | 'login_failed'
  | 'qr_timeout';

export interface ListenResult {
  httpStatus: number;
  state: ListenState;
  error?: string;
}

export interface RemindResult {
  httpStatus: number;
  reminded: boolean;
  kind?: ReminderKind;
  missing_count?: number;
  state?: ListenState;
  error?: string;
  task_id?: string;
}

export interface PendingLink {
  officialChatId: string;
  expiresAt: number;
}

export interface WorkerRuntimeDeps {
  loginPort?: ZcaLoginPort;
  db?: Database.Database | null;
  now?: () => number;
  getAdminChatId?: () => string;
  getPublicBaseUrl?: () => string;
  getQrTmpDir?: () => string;
  getSessionFilePath?: () => string;
  getQrTimeoutMs?: () => number;
  getLinkPendingMs?: () => number;
  deliverQr?: (imageUrl: string, expiresAt: number) => Promise<{ status: number; json: Record<string, unknown> }>;
  postLoginResult?: (ok: boolean, error?: string) => Promise<unknown>;
  postLinkResult?: (body: {
    official_chat_id: string;
    ok: boolean;
    zca_group_id?: string;
    display_name?: string;
    error?: string;
  }) => Promise<unknown>;
  scheduleTimeout?: (fn: () => void, ms: number) => () => void;
}

export class WorkerRuntime {
  private loggedIn = false;
  private qrInFlight = false;
  private pendingLink: PendingLink | null = null;
  private readonly deps: Required<
    Pick<
      WorkerRuntimeDeps,
      | 'now'
      | 'getAdminChatId'
      | 'getPublicBaseUrl'
      | 'getQrTmpDir'
      | 'getSessionFilePath'
      | 'getQrTimeoutMs'
      | 'getLinkPendingMs'
      | 'deliverQr'
      | 'postLoginResult'
      | 'postLinkResult'
      | 'scheduleTimeout'
    >
  > & { loginPort: ZcaLoginPort; db: Database.Database | null | undefined };

  private cancelPendingTimer: (() => void) | null = null;
  private messageLoopStarted = false;

  constructor(deps: WorkerRuntimeDeps = {}) {
    this.deps = {
      loginPort: deps.loginPort ?? createZcaLoginPort(),
      db: deps.db,
      now: deps.now ?? Date.now,
      getAdminChatId: deps.getAdminChatId ?? (() => getTaskproofSetting('admin_official_chat_id')),
      getPublicBaseUrl: deps.getPublicBaseUrl ?? getPublicBaseUrl,
      getQrTmpDir: deps.getQrTmpDir ?? getQrTmpDir,
      getSessionFilePath: deps.getSessionFilePath ?? getSessionFilePath,
      getQrTimeoutMs: deps.getQrTimeoutMs ?? (() => getTaskproofSetting('qr_login_timeout_ms')),
      getLinkPendingMs: deps.getLinkPendingMs ?? (() => getTaskproofSetting('link_pending_ms')),
      deliverQr: deps.deliverQr ?? deliverQr,
      postLoginResult: deps.postLoginResult ?? postLoginResult,
      postLinkResult: deps.postLinkResult ?? postLinkResult,
      scheduleTimeout:
        deps.scheduleTimeout ??
        ((fn, ms) => {
          const t = setTimeout(fn, ms);
          return () => clearTimeout(t);
        }),
    };
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  isQrInFlight(): boolean {
    return this.qrInFlight;
  }

  hasPendingLink(): boolean {
    if (!this.pendingLink) return false;
    return this.deps.now() <= this.pendingLink.expiresAt;
  }

  countOpenLinkedTasks(): number {
    const db = this.deps.db === undefined ? peekWorkerDatabase() : this.deps.db;
    if (!db) return 0;
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE status IN ('collecting', 'overdue') AND zca_group_id IS NOT NULL`
        )
        .get() as { n: number };
      return Number(row?.n || 0);
    } catch {
      return 0;
    }
  }

  status(): {
    logged_in: boolean;
    listening: boolean;
    open_task_count: number;
    pending_link: boolean;
  } {
    return {
      logged_in: this.loggedIn,
      listening: this.loggedIn,
      open_task_count: this.countOpenLinkedTasks(),
      pending_link: this.hasPendingLink(),
    };
  }

  /**
   * Login nếu cần. Không await QR — trả qr_required ngay.
   */
  async ensureListening(_taskId?: string): Promise<ListenResult> {
    if (this.loggedIn) {
      this.startMessageLoop();
      this.refreshStaleLinkedCaches();
      return { httpStatus: 200, state: this.hasPendingLink() ? 'pending_link' : 'listening' };
    }
    if (this.qrInFlight) {
      return { httpStatus: 200, state: 'qr_required' };
    }

    const sessionPath = this.deps.getSessionFilePath();
    const saved = loadSession(sessionPath);
    if (saved) {
      try {
        await this.deps.loginPort.login(saved);
        this.loggedIn = true;
        this.startMessageLoop();
        this.refreshStaleLinkedCaches();
        return { httpStatus: 200, state: this.hasPendingLink() ? 'pending_link' : 'reusing_session' };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[TaskProofWorker] Session lưu không dùng được, chuyển sang QR:', msg);
      }
    }

    const adminChatId = this.deps.getAdminChatId();
    if (!adminChatId) {
      return {
        httpStatus: 409,
        state: 'login_failed',
        error: 'admin_official_chat_id is empty',
      };
    }
    const publicBase = this.deps.getPublicBaseUrl();
    if (!publicBase) {
      return {
        httpStatus: 409,
        state: 'login_failed',
        error: 'PUBLIC_BASE_URL is not configured',
      };
    }

    this.startQrLogin();
    return { httpStatus: 200, state: 'qr_required' };
  }

  private startQrLogin(): void {
    this.qrInFlight = true;
    const qrId = crypto.randomUUID().replace(/-/g, '');
    const qrPath = path.join(this.deps.getQrTmpDir(), `${qrId}.png`);
    const timeoutMs = this.deps.getQrTimeoutMs();
    const expiresAt = this.deps.now() + timeoutMs;
    const imageUrl = `${this.deps.getPublicBaseUrl()}/internal/taskproof/qr/${qrId}?key=${encodeURIComponent(getInternalApiKey())}`;

    void this.deps.loginPort
      .loginQR({
        qrPath,
        timeoutMs,
        onGenerated: async () => {
          const delivered = await this.deps.deliverQr(imageUrl, expiresAt);
          if (delivered.status >= 400) {
            const err =
              typeof delivered.json.error === 'string'
                ? delivered.json.error
                : 'deliver-qr failed';
            // Codespace github.dev hiện trang cảnh báo với Zalo — không abort,
            // giữ file PNG để admin quét trực tiếp.
            console.warn(
              `[TaskProofWorker] deliver-qr thất bại (${err}). Mở file QR: ${qrPath}`
            );
          }
        },
      })
      .then((creds: ZcaCredentials) => {
        saveSession(creds, this.deps.getSessionFilePath());
        this.loggedIn = true;
        this.qrInFlight = false;
        this.deleteQrFile(qrPath);
        this.startMessageLoop();
        this.refreshStaleLinkedCaches();
        return this.deps.postLoginResult(true);
      })
      .catch((err: unknown) => {
        this.qrInFlight = false;
        this.deleteQrFile(qrPath);
        const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
        const msg = err instanceof Error ? err.message : String(err);
        const state = code === 'qr_timeout' || msg === 'qr_timeout' ? 'qr_timeout' : 'login_failed';
        return this.deps.postLoginResult(false, state === 'qr_timeout' ? 'qr_timeout' : msg);
      });
  }

  private deleteQrFile(qrPath: string): void {
    try {
      if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
    } catch {
      // best-effort
    }
  }

  private db(): Database.Database | null {
    return this.deps.db === undefined ? peekWorkerDatabase() : this.deps.db;
  }

  private startMessageLoop(): void {
    if (this.messageLoopStarted) return;
    this.messageLoopStarted = true;
    this.deps.loginPort.startMessageLoop?.((msg) => {
      void this.handleZcaMessage(msg);
    });
  }

  private clearPendingTimer(): void {
    this.cancelPendingTimer?.();
    this.cancelPendingTimer = null;
  }

  private armPendingTimeout(officialChatId: string, ms: number): void {
    this.clearPendingTimer();
    this.cancelPendingTimer = this.deps.scheduleTimeout(() => {
      if (!this.pendingLink || this.pendingLink.officialChatId !== officialChatId) return;
      this.pendingLink = null;
      this.clearPendingTimer();
      void this.deps.postLinkResult({
        official_chat_id: officialChatId,
        ok: false,
        error: 'hết hạn 2 phút, không thấy tin nhóm. Gõ /lienket rồi gửi ok.',
      });
    }, ms);
  }

  /**
   * Ảnh / tin zca-js. Nhóm chưa map → không OCR.
   * Cửa /lienket A: tin nhóm không phải lệnh → lấy threadId.
   */
  handleZcaMessage(msg: ZcaInboundMessage): { linked: boolean; ocr: boolean } {
    if (msg.hasImage && !msg.isGroup) {
      return { linked: false, ocr: false };
    }
    if (msg.hasImage) {
      const db = this.db();
      const ocr = Boolean(db && shouldOcrZcaGroup(db, msg.threadId));
      if (!ocr) {
        console.log(`[TaskProofWorker] Bỏ ảnh — nhóm chưa liên kết hoặc không có task mở: ${msg.threadId}`);
      }
      if (this.hasPendingLink() && msg.isGroup && !isSlashCommand(msg.text)) {
        this.completePendingLink(msg.threadId, msg.displayName);
        return { linked: true, ocr };
      }
      return { linked: false, ocr };
    }

    if (this.hasPendingLink() && msg.isGroup && !isSlashCommand(msg.text)) {
      this.completePendingLink(msg.threadId, msg.displayName);
      return { linked: true, ocr: false };
    }
    return { linked: false, ocr: false };
  }

  shouldOcrGroup(zcaGroupId: string): boolean {
    const db = this.db();
    return Boolean(db && shouldOcrZcaGroup(db, zcaGroupId));
  }

  /**
   * /nhac: ensure-listening, refresh cache một lần, nhắc ngay (không throttle).
   * Timer DEADLINE_CHECK_INTERVAL_MS = Step 8.
   */
  async remind(taskId: string): Promise<RemindResult> {
    const listen = await this.ensureListening(taskId);
    if (listen.httpStatus >= 400) {
      return {
        httpStatus: listen.httpStatus,
        reminded: false,
        state: listen.state,
        error: listen.error,
        task_id: taskId,
      };
    }
    if (!this.loggedIn) {
      return {
        httpStatus: 200,
        reminded: false,
        state: listen.state,
        task_id: taskId,
        error: listen.state === 'qr_required' ? 'qr_required' : 'not_logged_in',
      };
    }

    const db = this.db();
    if (!db) {
      return {
        httpStatus: 409,
        reminded: false,
        state: listen.state,
        error: 'worker database is not open',
        task_id: taskId,
      };
    }

    const task = db
      .prepare(
        `SELECT id, short_code, zca_group_id, status FROM tasks WHERE id = ?`
      )
      .get(taskId) as
      | { id: string; short_code: string; zca_group_id: string | null; status: string }
      | undefined;

    if (!task) {
      return { httpStatus: 404, reminded: false, error: 'task not found', task_id: taskId };
    }
    if (task.status !== 'collecting' && task.status !== 'overdue') {
      return {
        httpStatus: 409,
        reminded: false,
        error: `task is ${task.status}`,
        task_id: taskId,
      };
    }
    if (!task.zca_group_id) {
      return {
        httpStatus: 409,
        reminded: false,
        error: 'unlinked',
        task_id: taskId,
      };
    }

    const refresh = await refreshMemberCache({
      db,
      port: this.deps.loginPort,
      zcaGroupId: task.zca_group_id,
      now: this.deps.now(),
      forceRefresh: true,
    });

    const members = listCachedMembers(db, task.zca_group_id);
    const cacheAvailable = members.length > 0;
    const submitted = (
      db
        .prepare(`SELECT uid_from FROM submissions WHERE task_id = ?`)
        .all(task.id) as Array<{ uid_from: string }>
    ).map((row) => row.uid_from);

    const exclude = collectExcludeUids({
      officialBotUid: getTaskproofSetting('official_bot_uid', db),
      zcaOwnUid: getTaskproofSetting('zca_own_uid', db),
      liveOwnId: this.deps.loginPort.getOwnId?.(),
      extra: getTaskproofSetting('remind_exclude_uids', db),
    });
    const missing = computeMissing(members, submitted, exclude);
    const plan = planReminder({
      missing,
      shortCode: task.short_code,
      maxMentions: getTaskproofSetting('max_mentions_per_message', db),
      maxTextLen: getTaskproofSetting('max_reminder_text_len', db),
      cacheAvailable,
    });

    if (plan.kind === 'none') {
      return {
        httpStatus: 200,
        reminded: false,
        kind: 'none',
        missing_count: 0,
        state: listen.state,
        task_id: taskId,
      };
    }

    if (!this.deps.loginPort.sendGroupMessage) {
      return {
        httpStatus: 409,
        reminded: false,
        kind: plan.kind,
        missing_count: plan.missingCount,
        state: listen.state,
        error: 'sendGroupMessage is not available',
        task_id: taskId,
      };
    }

    try {
      await this.deps.loginPort.sendGroupMessage(task.zca_group_id, {
        msg: plan.msg,
        mentions: plan.mentions.length > 0 ? plan.mentions : undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProofWorker] Gửi nhắc thất bại:', msg);
      return {
        httpStatus: 502,
        reminded: false,
        kind: plan.kind,
        missing_count: plan.missingCount,
        state: listen.state,
        error: msg,
        task_id: taskId,
      };
    }

    db.prepare(
      `UPDATE tasks SET reminded_at = ?, remind_count = remind_count + 1 WHERE id = ?`
    ).run(this.deps.now(), task.id);

    return {
      httpStatus: 200,
      reminded: true,
      kind: plan.kind,
      missing_count: plan.missingCount,
      state: listen.state,
      task_id: taskId,
      error: refresh.ok ? undefined : 'member_cache_unavailable',
    };
  }

  /** Listen: refresh cache già/trống, không chờ, không chặn webhook. */
  private refreshStaleLinkedCaches(): void {
    const db = this.db();
    if (!db || !this.loggedIn) return;
    const groups = listLinkedOpenZcaGroups(db);
    for (const zcaGroupId of groups) {
      void refreshMemberCache({
        db,
        port: this.deps.loginPort,
        zcaGroupId,
        now: this.deps.now(),
        forceRefresh: false,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TaskProofWorker] Refresh cache ${zcaGroupId} lỗi:`, msg);
      });
    }
  }

  private completePendingLink(zcaGroupId: string, displayName: string): void {
    const pending = this.pendingLink;
    if (!pending) return;
    const db = this.db();
    if (!db) {
      console.warn('[TaskProofWorker] /lienket A: chưa có DB');
      return;
    }
    const conflict = conflictForPair(db, pending.officialChatId, zcaGroupId);
    if (conflict) {
      this.pendingLink = null;
      this.clearPendingTimer();
      void this.deps.postLinkResult({
        official_chat_id: pending.officialChatId,
        ok: false,
        zca_group_id: zcaGroupId,
        error: conflict,
      });
      return;
    }
    const name = displayName || null;
    upsertGroupMap(db, pending.officialChatId, zcaGroupId, name, this.deps.now());
    this.pendingLink = null;
    this.clearPendingTimer();
    void this.deps.postLinkResult({
      official_chat_id: pending.officialChatId,
      ok: true,
      zca_group_id: zcaGroupId,
      display_name: displayName || zcaGroupId,
    });
  }

  linkGroup(officialChatId: string, zcaGroupId?: string): { httpStatus: number; body: Record<string, unknown> } {
    const official = officialChatId.trim();
    if (!official) {
      return { httpStatus: 400, body: { success: false, error: 'official_chat_id is required' } };
    }

    const zca = (zcaGroupId || '').trim();
    if (!zca) {
      const expiresAt = this.deps.now() + this.deps.getLinkPendingMs();
      this.pendingLink = { officialChatId: official, expiresAt };
      this.armPendingTimeout(official, this.deps.getLinkPendingMs());
      this.startMessageLoop();
      return {
        httpStatus: 200,
        body: { success: true, pending: true, expires_at: expiresAt },
      };
    }

    const db = this.db();
    if (!db) {
      return { httpStatus: 409, body: { success: false, error: 'worker database is not open' } };
    }

    const conflict = conflictForPair(db, official, zca);
    if (conflict) {
      return { httpStatus: 409, body: { success: false, error: conflict } };
    }

    upsertGroupMap(db, official, zca, null, this.deps.now());
    this.pendingLink = null;
    this.clearPendingTimer();
    return { httpStatus: 200, body: { success: true, official_chat_id: official, zca_group_id: zca } };
  }
}

function isSlashCommand(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (looksLikeTaskproofCommand(trimmed)) return true;
  if (/^\/(gui|send|id|myid)\b/i.test(trimmed)) return true;
  if (/^tuantra\b/i.test(trimmed)) return true;
  return false;
}

let singleton: WorkerRuntime | null = null;

export function getWorkerRuntime(): WorkerRuntime {
  if (!singleton) singleton = new WorkerRuntime();
  return singleton;
}

export function setWorkerRuntimeForTests(runtime: WorkerRuntime | null): void {
  singleton = runtime;
}
