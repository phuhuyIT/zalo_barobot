/**
 * runtime.ts
 *
 * Trạng thái login worker (Step 5): session trước, QR bất đồng bộ.
 * ensure-listening trả về ngay khi cần QR — webhook không chờ quét.
 * Step 6: /lienket — pending + tin nhóm tiếp theo (zca threadId).
 * Step 7: cache thành viên + /nhac (mention / @all).
 * Step 8: listen/stop — chỉ online khi có task liên kết mở, cửa pending, hoặc QR.
 * Task chưa liên kết không giữ worker. Timer DEADLINE_CHECK_INTERVAL_MS nhắc tự động.
 * Step 9: ảnh nhóm đã map + task mở → đối chiếu với ảnh mẫu, ghi file, đóng khi đủ quota.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getProofDir, getPublicBaseUrl, getQrTmpDir, getSessionFilePath, QR_URL_TTL_MS } from '../env';
import { signedQueryString } from '../http/internalAuth';
import {
  countLinkedOpenTasks,
  listDueAutoReminders,
  markOverdueTasks,
  shouldKeepWorkerOnline,
} from '../records/lifecycle';
import {
  getTaskproofExcludeUids,
  getTaskproofSetting,
  setTaskproofSetting,
} from '../records/settings';
import { peekWorkerDatabase } from '../records/store';
import { looksLikeTaskproofCommand } from '../commands/parser';
import { historyFetchCount, QUET_DEFAULT_COUNT, ScanHistorySummary } from '../quet';
import { deliverQr, postLoginResult, postLinkResult, postReportNow, postScanResult } from './callbacks';
import { conflictForPair, isMappedZcaGroup, shouldScoreZcaGroup, upsertGroupMap } from './groupMap';
import {
  listCachedMembers,
  listLinkedOpenZcaGroups,
  observeMember,
  refreshMemberCache,
  stripMemberId,
} from './memberCache';
import {
  collectExcludeUids,
  computeMissing,
  planReminder,
  ReminderKind,
} from './reminders';
import { ingestProofImage, ProofIngestDeps, ProofIngestResult } from './proofIngest';
import { ScoreImagePair } from './imageMatch';
import { scanGroupHistoryForTask } from './scanHistory';
import { loadSession, saveSession, ZcaCredentials } from './session';
import { createZcaLoginPort, ZcaInboundMessage, ZcaLoginPort } from './zcaAdapter';

async function defaultKickReport(taskId: string): Promise<unknown> {
  try {
    const { status, json } = await postReportNow(taskId);
    if (status >= 400) {
      console.warn(
        `[TaskProofWorker] report-now ${taskId} HTTP ${status}`,
        typeof json.error === 'string' ? json.error : ''
      );
    }
    return json;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TaskProofWorker] report-now ${taskId} lỗi:`, msg);
    return undefined;
  }
}

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
  scheduleInterval?: (fn: () => void, ms: number) => () => void;
  scoreImages?: ScoreImagePair;
  downloadImage?: (url: string) => Promise<Buffer | null>;
  getProofDir?: () => string;
  kickReport?: (taskId: string) => Promise<unknown>;
  postScanResult?: (body: {
    reply_chat_id: string;
    short_code: string;
    count: number;
    scanned: number;
    recorded: number;
    skipped: number;
    discarded: number;
    closed: boolean;
    truncated: boolean;
    error?: string;
  }) => Promise<unknown>;
}

export interface ScanHistoryResult extends ScanHistorySummary {
  httpStatus: number;
  state?: ListenState;
  task_id?: string;
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
      | 'scheduleInterval'
    >
  > & {
    loginPort: ZcaLoginPort;
    db: Database.Database | null | undefined;
    scoreImages?: ScoreImagePair;
    downloadImage?: (url: string) => Promise<Buffer | null>;
    getProofDir: () => string;
    kickReport: (taskId: string) => Promise<unknown>;
    postScanResult: (body: {
      reply_chat_id: string;
      short_code: string;
      count: number;
      scanned: number;
      recorded: number;
      skipped: number;
      discarded: number;
      closed: boolean;
      truncated: boolean;
      error?: string;
    }) => Promise<unknown>;
  };

  private cancelPendingTimer: (() => void) | null = null;
  private cancelDeadlineTimer: (() => void) | null = null;
  private messageLoopStarted = false;
  private readonly scanInFlight = new Set<string>();
  private readonly knownBotUids = new Map<string, string[]>();
  private listenLock: Promise<void> = Promise.resolve();
  private deadlineTickInFlight = false;
  private ingestActive = 0;
  private readonly ingestPending: Array<() => Promise<void>> = [];
  /** Một ảnh một lúc, kể cả /quet. Hai process SIFT chồng nhau khoảng 500MB. */
  private static readonly MAX_INGEST = 1;

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
      scheduleInterval:
        deps.scheduleInterval ??
        ((fn, ms) => {
          const t = setInterval(fn, ms);
          if (typeof t.unref === 'function') t.unref();
          return () => clearInterval(t);
        }),
      scoreImages: deps.scoreImages,
      downloadImage: deps.downloadImage,
      getProofDir: deps.getProofDir ?? getProofDir,
      kickReport: deps.kickReport ?? defaultKickReport,
      postScanResult: deps.postScanResult ?? postScanResult,
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
    const db = this.db();
    if (!db) return 0;
    return countLinkedOpenTasks(db);
  }

  shouldStayOnline(): boolean {
    return shouldKeepWorkerOnline({
      linkedOpenCount: this.countOpenLinkedTasks(),
      pendingLink: this.hasPendingLink(),
      qrInFlight: this.qrInFlight,
    });
  }

  status(): {
    logged_in: boolean;
    listening: boolean;
    open_task_count: number;
    pending_link: boolean;
  } {
    return {
      logged_in: this.loggedIn,
      listening: this.loggedIn && this.messageLoopStarted,
      open_task_count: this.countOpenLinkedTasks(),
      pending_link: this.hasPendingLink(),
    };
  }

  /**
   * Login nếu cần. Không await QR — trả qr_required ngay.
   * Serialize: hai /task cùng lúc không mở hai phiên QR.
   */
  async ensureListening(_taskId?: string): Promise<ListenResult> {
    const run = this.listenLock.then(() => this.ensureListeningBody(_taskId));
    this.listenLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async ensureListeningBody(_taskId?: string): Promise<ListenResult> {
    if (this.loggedIn) {
      this.startMessageLoop();
      this.startDeadlineTimer();
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
        this.persistOwnUid();
        this.startMessageLoop();
        this.startDeadlineTimer();
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
    const pathname = `/internal/taskproof/qr/${qrId}`;
    const base = this.deps.getPublicBaseUrl().replace(/\/$/, '');
    const imageUrl = `${base}${pathname}?${signedQueryString(pathname, QR_URL_TTL_MS)}`;

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
      .then(async (creds: ZcaCredentials) => {
        saveSession(creds, this.deps.getSessionFilePath());
        this.loggedIn = true;
        this.qrInFlight = false;
        this.deleteQrFile(qrPath);
        this.persistOwnUid();
        this.startMessageLoop();
        this.startDeadlineTimer();
        this.refreshStaleLinkedCaches();
        try {
          await this.deps.postLoginResult(true);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[TaskProofWorker] postLoginResult sau QR thành công lỗi:', msg);
        }
      })
      .catch((err: unknown) => {
        this.qrInFlight = false;
        this.deleteQrFile(qrPath);
        const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
        const msg = err instanceof Error ? err.message : String(err);
        const state = code === 'qr_timeout' || msg === 'qr_timeout' ? 'qr_timeout' : 'login_failed';
        this.maybeStopListening();
        void Promise.resolve(
          this.deps.postLoginResult(false, state === 'qr_timeout' ? 'qr_timeout' : msg)
        ).catch((notifyErr: unknown) => {
          const text = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          console.warn('[TaskProofWorker] postLoginResult thất bại:', text);
        });
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
      void Promise.resolve(
        this.deps.postLinkResult({
          official_chat_id: officialChatId,
          ok: false,
          error: 'hết hạn 2 phút, không thấy tin nhóm. Gõ /lienket rồi gửi ok.',
        })
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[TaskProofWorker] postLinkResult timeout lỗi:', msg);
      });
      this.maybeStopListening();
    }, ms);
  }

  /**
   * Không còn task liên kết mở / pending / QR → logout zca-js, dừng listener.
   * Không xóa session file — lần ensure-listening sau tái sử dụng.
   */
  maybeStopListening(): boolean {
    if (this.shouldStayOnline()) return false;
    this.stopDeadlineTimer();
    if (!this.loggedIn && !this.messageLoopStarted) return false;

    console.log('[TaskProofWorker] Không còn task liên kết mở — logout zca-js, dừng listener.');
    try {
      this.deps.loginPort.stopMessageLoop?.();
    } catch {
      // best-effort
    }
    try {
      this.deps.loginPort.logout?.();
    } catch {
      // best-effort
    }
    this.loggedIn = false;
    this.messageLoopStarted = false;
    return true;
  }

  private startDeadlineTimer(): void {
    if (this.cancelDeadlineTimer || !this.loggedIn) return;
    const db = this.db();
    const ms = db
      ? getTaskproofSetting('deadline_check_interval_ms', db)
      : getTaskproofSetting('deadline_check_interval_ms');
    this.cancelDeadlineTimer = this.deps.scheduleInterval(() => {
      void this.runDeadlineTick();
    }, ms);
  }

  private stopDeadlineTimer(): void {
    this.cancelDeadlineTimer?.();
    this.cancelDeadlineTimer = null;
  }

  /**
   * Tick DEADLINE_CHECK_INTERVAL_MS: lật overdue, nhắc tự động, rồi xét stop.
   * Lỗi một task không chặn các task còn lại.
   */
  async runDeadlineTick(): Promise<void> {
    if (this.deadlineTickInFlight) return;
    this.deadlineTickInFlight = true;
    try {
      if (!this.loggedIn) {
        this.maybeStopListening();
        return;
      }
      const db = this.db();
      if (!db) {
        this.maybeStopListening();
        return;
      }

      const now = this.deps.now();
      const flipped = markOverdueTasks(db, now);
      if (flipped > 0) {
        console.log(`[TaskProofWorker] ${flipped} task quá hạn → overdue (không đóng).`);
      }

      const due = listDueAutoReminders(db, now, {
        maxAutoReminders: getTaskproofSetting('max_auto_reminders', db),
        reminderIntervalMs: getTaskproofSetting('reminder_interval_ms', db),
      });
      for (const task of due) {
        try {
          await this.deliverReminder(task.id, { forceRefresh: false, onlyWhenEmpty: true });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[TaskProofWorker] Auto-remind ${task.short_code} lỗi:`, msg);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProofWorker] Deadline tick lỗi:', msg);
    } finally {
      this.deadlineTickInFlight = false;
      this.maybeStopListening();
    }
  }

  /**
   * Ảnh / tin zca-js. Nhóm chưa map → không chấm.
   * Cửa /lienket A: tin nhóm không phải lệnh → lấy threadId.
   * Ảnh hợp lệ: xếp hàng đối chiếu (không chặn listener).
   * Thẻ xem trước web (chat.link): không phải minh chứng.
   */
  handleZcaMessage(msg: ZcaInboundMessage): {
    linked: boolean;
    proof: boolean;
    job?: Promise<ProofIngestResult>;
  } {
    const db = this.db();
    const excludeUids = db ? getTaskproofExcludeUids(db) : undefined;
    const isExcluded = Boolean(
      msg.uidFrom === '0' || (excludeUids && msg.uidFrom && excludeUids.has(msg.uidFrom))
    );

    if (db && msg.isGroup && msg.uidFrom && !isExcluded && isMappedZcaGroup(db, msg.threadId)) {
      observeMember(db, msg.threadId, msg.uidFrom, msg.displayName, this.deps.now());
    }

    let linked = false;
    if (this.hasPendingLink() && msg.isGroup && !isSlashCommand(msg.text)) {
      this.completePendingLink(msg.threadId, msg.displayName);
      linked = true;
    }

    if (looksLikeTaskproofCommand(msg.text)) {
      return { linked, proof: false };
    }

    if (msg.isLinkCard) {
      console.log(
        `[TaskProofWorker] Bỏ thẻ xem trước msg=${msg.msgId || ''} group=${msg.threadId}`
      );
      return { linked, proof: false };
    }

    if (!msg.hasImage || !msg.isGroup) {
      return { linked, proof: false };
    }

    if (isExcluded) {
      console.log(
        `[TaskProofWorker] Bỏ ảnh từ bot hoặc self uid=${msg.uidFrom || ''} group=${msg.threadId}`
      );
      return { linked, proof: false };
    }

    const score = Boolean(db && shouldScoreZcaGroup(db, msg.threadId));
    if (!score) {
      console.log(
        `[TaskProofWorker] Bỏ ảnh — nhóm chưa liên kết hoặc không có task mở: ${msg.threadId}`
      );
      return { linked, proof: false };
    }

    console.log(
      `[TaskProofWorker] Hàng đợi đối chiếu msg=${msg.msgId || ''} group=${msg.threadId} type=${msg.msgType || ''}`
    );
    const job = this.enqueueIngest(() => this.ingestProof(msg));
    return { linked, proof: true, job };
  }

  private enqueueIngest(job: () => Promise<ProofIngestResult>): Promise<ProofIngestResult> {
    return new Promise((resolve) => {
      const wrapped = async () => {
        try {
          resolve(await job());
        } catch (err: unknown) {
          const text = err instanceof Error ? err.message : String(err);
          resolve({ outcome: 'discarded', reason: text });
        }
      };
      this.ingestPending.push(wrapped);
      this.pumpIngest();
    });
  }

  private pumpIngest(): void {
    while (this.ingestActive < WorkerRuntime.MAX_INGEST && this.ingestPending.length > 0) {
      const next = this.ingestPending.shift();
      if (!next) return;
      this.ingestActive += 1;
      void next().finally(() => {
        this.ingestActive -= 1;
        this.pumpIngest();
      });
    }
  }

  private proofIngestDeps(db: Database.Database): ProofIngestDeps {
    return {
      now: this.deps.now,
      scoreImages: this.deps.scoreImages,
      downloadImage: this.deps.downloadImage,
      loadSession: () => loadSession(this.deps.getSessionFilePath()),
      proofDir: this.deps.getProofDir(),
      kickReport: this.deps.kickReport,
      excludeUids: getTaskproofExcludeUids(db),
    };
  }

  private async ingestProof(msg: ZcaInboundMessage): Promise<ProofIngestResult> {
    const db = this.db();
    if (!db) return { outcome: 'skipped', reason: 'no_db' };
    try {
      const result = await ingestProofImage(
        db,
        {
          threadId: msg.threadId,
          msgId: msg.msgId || '',
          uidFrom: msg.uidFrom || '',
          displayName: msg.displayName,
          href: msg.href,
          thumb: msg.thumb,
        },
        this.proofIngestDeps(db)
      );
      if (result.outcome !== 'recorded') {
        const reason = 'reason' in result ? result.reason : '';
        console.log(
          `[TaskProofWorker] Ingest ${result.outcome}${reason ? ` ${reason}` : ''} msg=${msg.msgId || ''}`
        );
      }
      if (result.outcome === 'recorded' && result.closed) {
        this.maybeStopListening();
      }
      return result;
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      console.error('[TaskProofWorker] Ingest minh chứng lỗi:', text);
      return { outcome: 'discarded', reason: text };
    }
  }

  /** Spec: zca_own_uid có thể tự điền sau getOwnId(). Không ghi đè uid số người dùng đã set. */
  private persistOwnUid(): void {
    const db = this.db();
    const own = (this.deps.loginPort.getOwnId?.() || '').trim();
    if (!db || !own) return;
    const current = (getTaskproofSetting('zca_own_uid', db) || '').trim();
    if (current === own) return;
    if (/^\d{6,}$/.test(current) && current !== own) return;
    try {
      setTaskproofSetting('zca_own_uid', own, db);
      console.log(`[TaskProofWorker] Ghi zca_own_uid=${own}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] Không ghi được zca_own_uid:', msg);
    }
  }

  shouldScoreGroup(zcaGroupId: string): boolean {
    const db = this.db();
    return Boolean(db && shouldScoreZcaGroup(db, zcaGroupId));
  }

  /**
   * /nhac: ensure-listening, refresh cache một lần, nhắc ngay (không throttle).
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

    const result = await this.deliverReminder(taskId, { forceRefresh: true });
    return { ...result, state: result.state ?? listen.state };
  }

  /**
   * /quet: validate rồi chạy scan nền. HTTP trả 202 ngay — đối chiếu ảnh có thể lâu.
   */
  enqueueScanHistory(
    taskId: string,
    count: number,
    replyChatId: string
  ): { httpStatus: number; state: string; error?: string; count?: number; task_id?: string } {
    const prepared = this.prepareScanHistory(taskId);
    if (prepared.httpStatus >= 400) {
      return {
        httpStatus: prepared.httpStatus,
        state: prepared.error || 'error',
        error: prepared.error,
        task_id: taskId,
      };
    }
    if (this.scanInFlight.has(taskId)) {
      return {
        httpStatus: 409,
        state: 'already_scanning',
        error: 'already_scanning',
        task_id: taskId,
      };
    }
    this.scanInFlight.add(taskId);
    void this.scanHistory(taskId, count, replyChatId)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[TaskProofWorker] /quet lỗi:', msg);
        const chatId = replyChatId.trim();
        if (!chatId) return;
        return this.deps.postScanResult({
          reply_chat_id: chatId,
          short_code: prepared.shortCode || '',
          count,
          scanned: 0,
          recorded: 0,
          skipped: 0,
          discarded: 0,
          closed: false,
          truncated: false,
          error: msg,
        });
      })
      .finally(() => {
        this.scanInFlight.delete(taskId);
      });
    return {
      httpStatus: 202,
      state: 'scanning',
      count,
      task_id: taskId,
    };
  }

  /**
   * Quét lịch sử nhóm cho một task. Test gọi trực tiếp (không qua HTTP 202).
   */
  async scanHistory(
    taskId: string,
    count: number = QUET_DEFAULT_COUNT,
    replyChatId?: string
  ): Promise<ScanHistoryResult> {
    const fetchCount = historyFetchCount(count);
    const prepared = this.prepareScanHistory(taskId);
    if (prepared.httpStatus >= 400 || !prepared.task || !prepared.db) {
      const failed: ScanHistoryResult = {
        httpStatus: prepared.httpStatus,
        shortCode: prepared.shortCode || '',
        count: fetchCount,
        scanned: 0,
        recorded: 0,
        skipped: 0,
        discarded: 0,
        closed: false,
        truncated: false,
        error: prepared.error,
        task_id: taskId,
        state: prepared.state,
      };
      await this.maybePostScanResult(replyChatId || prepared.officialChatId, failed);
      return failed;
    }

    let messages: ZcaInboundMessage[] = [];
    let more = 0;
    try {
      const page = await this.deps.loginPort.getGroupChatHistory?.(prepared.task.zca_group_id, fetchCount);
      messages = page?.messages || [];
      more = page?.more || 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const failed: ScanHistoryResult = {
        httpStatus: 502,
        shortCode: prepared.task.short_code,
        count: fetchCount,
        scanned: 0,
        recorded: 0,
        skipped: 0,
        discarded: 0,
        closed: false,
        truncated: false,
        error: msg,
        task_id: taskId,
      };
      await this.maybePostScanResult(replyChatId || prepared.task.official_chat_id, failed);
      return failed;
    }

    const db = prepared.db;
    const deps = this.proofIngestDeps(db);
    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId,
        shortCode: prepared.task.short_code,
        zcaGroupId: prepared.task.zca_group_id,
        count: fetchCount,
        messages,
        more,
      },
      {
        ...deps,
        runIngest: (image) =>
          this.enqueueIngest(() =>
            ingestProofImage(db, image, deps, {
              onlyTaskId: taskId,
              ignoreProcessed: true,
              skipIfAlreadySubmitted: true,
            })
          ),
      }
    );
    const result: ScanHistoryResult = { ...summary, httpStatus: 200, task_id: taskId };
    await this.maybePostScanResult(replyChatId || prepared.task.official_chat_id, result);
    // After a successful scan, send a reminder to the group showing who hasn't submitted + post link
    if (!result.closed && result.recorded > 0) {
      try {
        await this.deliverReminder(taskId, { forceRefresh: false });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[TaskProofWorker] /quet auto-remind lỗi:', msg);
      }
    }
    if (result.closed) this.maybeStopListening();
    return result;
  }

  private prepareScanHistory(
    taskId: string
  ): {
    httpStatus: number;
    error?: string;
    state?: ListenState;
    db?: Database.Database;
    task?: {
      id: string;
      short_code: string;
      zca_group_id: string;
      official_chat_id: string;
      status: string;
    };
    shortCode?: string;
    officialChatId?: string;
  } {
    const db = this.db();
    if (!db) {
      return { httpStatus: 409, error: 'worker database is not open' };
    }
    if (!this.loggedIn) {
      return { httpStatus: 409, error: 'not_logged_in', state: 'login_failed' };
    }
    const task = db
      .prepare(
        `SELECT id, short_code, zca_group_id, official_chat_id, status FROM tasks WHERE id = ?`
      )
      .get(taskId) as
      | {
          id: string;
          short_code: string;
          zca_group_id: string | null;
          official_chat_id: string;
          status: string;
        }
      | undefined;
    if (!task) {
      return { httpStatus: 404, error: 'task not found' };
    }
    if (task.status !== 'collecting' && task.status !== 'overdue') {
      return { httpStatus: 409, error: `task is ${task.status}`, shortCode: task.short_code };
    }
    if (!task.zca_group_id) {
      return {
        httpStatus: 409,
        error: 'unlinked',
        shortCode: task.short_code,
        officialChatId: task.official_chat_id,
      };
    }
    return {
      httpStatus: 200,
      db,
      shortCode: task.short_code,
      officialChatId: task.official_chat_id,
      task: {
        id: task.id,
        short_code: task.short_code,
        zca_group_id: task.zca_group_id,
        official_chat_id: task.official_chat_id,
        status: task.status,
      },
    };
  }

  private async maybePostScanResult(
    replyChatId: string | undefined,
    summary: ScanHistoryResult
  ): Promise<void> {
    const chatId = (replyChatId || '').trim();
    if (!chatId) return;
    try {
      await this.deps.postScanResult({
        reply_chat_id: chatId,
        short_code: summary.shortCode,
        count: summary.count,
        scanned: summary.scanned,
        recorded: summary.recorded,
        skipped: summary.skipped,
        discarded: summary.discarded,
        closed: summary.closed,
        truncated: summary.truncated,
        error: summary.error,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] scan-result gửi official bot lỗi:', msg);
    }
  }

  /**
   * Gửi đúng một tin nhắc. /nhac: forceRefresh. Timer: onlyWhenEmpty, có throttle ở shouldAutoRemind.
   */
  private async deliverReminder(
    taskId: string,
    opts: { forceRefresh: boolean; onlyWhenEmpty?: boolean }
  ): Promise<RemindResult> {
    const db = this.db();
    if (!db) {
      return {
        httpStatus: 409,
        reminded: false,
        error: 'worker database is not open',
        task_id: taskId,
      };
    }

    const task = db
      .prepare(
        `SELECT id, short_code, zca_group_id, status, link FROM tasks WHERE id = ?`
      )
      .get(taskId) as
      | { id: string; short_code: string; zca_group_id: string | null; status: string; link: string }
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

    const configuredBot = stripMemberId(getTaskproofSetting('official_bot_uid', db) || '');
    const cachedBefore = listCachedMembers(db, task.zca_group_id);
    const configuredBotInGroup =
      Boolean(configuredBot) &&
      cachedBefore.some((member) => stripMemberId(member.user_id) === configuredBot);
    const learnBot = Boolean(configuredBot) && !configuredBotInGroup;
    const refresh = await refreshMemberCache({
      db,
      port: this.deps.loginPort,
      zcaGroupId: task.zca_group_id,
      now: this.deps.now(),
      forceRefresh: opts.forceRefresh || learnBot,
      onlyWhenEmpty: learnBot ? false : opts.onlyWhenEmpty,
    });

    const seenBots = refresh.botUids.length > 0 ? refresh.botUids : this.knownBotUids.get(task.zca_group_id) || [];
    if (refresh.botUids.length > 0) this.knownBotUids.set(task.zca_group_id, refresh.botUids);
    const configuredIsBot = seenBots.some((id) => stripMemberId(id) === configuredBot);
    if (seenBots.length > 0 && !configuredIsBot && (!configuredBot || learnBot)) {
      try {
        setTaskproofSetting('official_bot_uid', seenBots[0], db);
        console.log(
          `[TaskProofWorker] Ghi official_bot_uid=${seenBots[0]} (uid cũ không phải thành viên nhóm)`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[TaskProofWorker] Không ghi được official_bot_uid:', msg);
      }
    }

    const members = listCachedMembers(db, task.zca_group_id);
    const exclude = collectExcludeUids({
      officialBotUid: getTaskproofSetting('official_bot_uid', db),
      zcaOwnUid: getTaskproofSetting('zca_own_uid', db),
      liveOwnId: this.deps.loginPort.getOwnId?.(),
      extra: [...getTaskproofSetting('remind_exclude_uids', db), ...seenBots],
    });
    const cacheAvailable = members.some((member) => member.user_id && !exclude.has(member.user_id));
    const submitted = (
      db
        .prepare(`SELECT uid_from FROM submissions WHERE task_id = ?`)
        .all(task.id) as Array<{ uid_from: string }>
    ).map((row) => row.uid_from);

    const missing = computeMissing(members, submitted, exclude);
    const plan = planReminder({
      missing,
      shortCode: task.short_code,
      maxMentions: getTaskproofSetting('max_mentions_per_message', db),
      maxTextLen: getTaskproofSetting('max_reminder_text_len', db),
      cacheAvailable,
      link: task.link,
    });

    if (plan.kind === 'none') {
      return {
        httpStatus: 200,
        reminded: false,
        kind: 'none',
        missing_count: 0,
        task_id: taskId,
      };
    }

    if (!this.deps.loginPort.sendGroupMessage) {
      return {
        httpStatus: 409,
        reminded: false,
        kind: plan.kind,
        missing_count: plan.missingCount,
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

  private notifyLinkResult(body: {
    official_chat_id: string;
    ok: boolean;
    zca_group_id?: string;
    display_name?: string;
    error?: string;
  }): void {
    void Promise.resolve(this.deps.postLinkResult(body)).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] postLinkResult lỗi:', msg);
    });
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
      this.notifyLinkResult({
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
    this.notifyLinkResult({
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
