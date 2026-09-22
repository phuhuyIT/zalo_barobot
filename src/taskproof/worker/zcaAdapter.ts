/**
 * zcaAdapter.ts
 *
 * Bọc zca-js. Chỉ worker process được import file này.
 * Official bot không được import zca-js.
 */

import fs from 'fs';
import path from 'path';
import {
  Zalo,
  LoginQRCallbackEventType,
  ThreadType,
  GroupMessage,
  type Credentials,
  type API,
  type Message,
} from 'zca-js';
import { HISTORY_API_MAX_COUNT, parseZcaTs } from '../quet';
import { isImageHref } from './imageFetch';
import { ZcaCredentials } from './session';

export interface QrLoginOpts {
  qrPath: string;
  timeoutMs: number;
  onGenerated: (info: { abort: () => void }) => Promise<void>;
}

export interface ZcaInboundMessage {
  threadId: string;
  isGroup: boolean;
  text: string;
  displayName: string;
  hasImage: boolean;
  isLinkCard?: boolean;
  shareHref?: string;
  msgId?: string;
  uidFrom?: string;
  href?: string;
  thumb?: string;
  contentType?: string;
  msgType?: string;
  ts?: number;
}

export interface ZcaHistoryPage {
  more: number;
  messages: ZcaInboundMessage[];
}

export interface ZcaMention {
  pos: number;
  uid: string;
  len: number;
}

export interface ZcaGroupInfoSnapshot {
  groupId: string;
  name: string;
  memberIds: string[];
  currentMems: Array<{ id: string; dName: string }>;
  totalMember: number;
  hasMoreMember: boolean;
  memVerList: string[];
  adminIds: string[];
  creatorId: string;
  lockViewMember: boolean;
}

export interface ZcaMemberProfile {
  id: string;
  displayName: string;
}

export interface ZcaLoginPort {
  login(credentials: ZcaCredentials): Promise<void>;
  loginQR(opts: QrLoginOpts): Promise<ZcaCredentials>;
  startMessageLoop?(handler: (msg: ZcaInboundMessage) => void): void;
  stopMessageLoop?(): void;
  logout?(): void;
  getOwnId?(): string;
  getGroupInfo?(groupId: string): Promise<ZcaGroupInfoSnapshot | null>;
  getGroupMembersInfo?(ids: string[]): Promise<ZcaMemberProfile[]>;
  sendGroupMessage?(
    threadId: string,
    content: { msg: string; mentions?: ZcaMention[] }
  ): Promise<void>;
  getGroupChatHistory?(groupId: string, count?: number): Promise<ZcaHistoryPage>;
}

type RecentHistoryApi = API & {
  fetchRecentGroup?: (props: { groupId: string; count: number }) => Promise<unknown>;
};

type HistoryUtils = {
  makeURL: (baseURL: string, params?: Record<string, string | number>, apiVersion?: boolean) => string;
  encodeAES: (data: string) => string | null;
  request: (url: string, options?: { method?: string; body?: URLSearchParams }) => Promise<Response>;
  resolve: (res: Response, cb?: (result: { data: unknown }) => unknown) => Promise<unknown>;
};

const HARDCODED_CM_HOST = 'https://tt-group-cm.chat.zalo.me';
const HISTORY_GLOBAL_MSG_ID = 10000000000000000;

export function recentGroupHosts(map: {
  group_cloud_message?: string[];
  group?: string[];
}): string[] {
  const hosts: string[] = [];
  const push = (raw: string) => {
    const clean = (raw || '').replace(/\/$/, '');
    if (clean && !hosts.includes(clean)) hosts.push(clean);
  };
  if (map.group_cloud_message?.[0]) push(map.group_cloud_message[0]);
  const groupHost = (map.group?.[0] || '').replace(/\/$/, '');
  if (groupHost.includes('tt-group-wpa')) {
    push(groupHost.replace('tt-group-wpa', 'tt-group-cm'));
  }
  push(HARDCODED_CM_HOST);
  return hosts;
}

export function capHistoryCount(count: number): number {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(HISTORY_API_MAX_COUNT, Math.max(1, Math.floor(n)));
}

/** Payload zlapi getRecentGroup — getrecentv2 không nhận count > 50. */
export function buildRecentGroupParams(
  groupId: string,
  count: number,
  imei: string
): Record<string, unknown> {
  return {
    groupId: String(groupId),
    globalMsgId: HISTORY_GLOBAL_MSG_ID,
    count: capHistoryCount(count),
    msgIds: [],
    imei,
    src: 1,
  };
}

export function formatHistoryApiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
  const detail =
    code !== undefined && code !== null && String(code) !== ''
      ? `#${code} ${msg}`
      : msg;
  return `Zalo không trả lịch sử nhóm (${detail}). Thử /nhac để người đã gửi ảnh gửi lại.`;
}

export function unwrapHistoryPayload(raw: unknown): { groupMsgs: unknown[]; more: number } {
  let data: unknown = raw;
  for (let i = 0; i < 4; i++) {
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        break;
      }
      continue;
    }
    if (!data || typeof data !== 'object') break;
    const rec = data as Record<string, unknown>;
    if (Array.isArray(rec.groupMsgs)) {
      return { groupMsgs: rec.groupMsgs, more: Number(rec.more || 0) };
    }
    if (Array.isArray(rec.msgs)) {
      return { groupMsgs: rec.msgs, more: Number(rec.more || 0) };
    }
    if (rec.data !== undefined) {
      data = rec.data;
      continue;
    }
    break;
  }
  return { groupMsgs: [], more: 0 };
}

function mapHistoryMessages(groupId: string, ownUid: string, raw: unknown): ZcaHistoryPage {
  const { groupMsgs, more } = unwrapHistoryPayload(raw);
  const messages = groupMsgs.map((item) => {
    const inbound = normalizeZcaInbound(new GroupMessage(ownUid, item as ConstructorParameters<typeof GroupMessage>[1]));
    if (!inbound.threadId) inbound.threadId = groupId;
    return inbound;
  });
  return { more, messages };
}

async function requestRecentGroup(
  utils: HistoryUtils,
  ctx: { imei: string },
  host: string,
  groupId: string,
  count: number,
  method: 'GET' | 'POST'
): Promise<unknown> {
  const encryptedParams = utils.encodeAES(
    JSON.stringify(buildRecentGroupParams(groupId, count, ctx.imei))
  );
  if (!encryptedParams) throw new Error('Failed to encrypt params');
  const query: Record<string, string | number> = { nretry: 0 };
  if (method === 'GET') query.params = encryptedParams;
  const url = utils.makeURL(`${host}/api/cm/getrecentv2`, query);
  const response = await utils.request(
    url,
    method === 'POST'
      ? { method: 'POST', body: new URLSearchParams({ params: encryptedParams }) }
      : { method: 'GET' }
  );
  return utils.resolve(response);
}

function wireRecentHistoryApi(api: RecentHistoryApi): void {
  if (api.fetchRecentGroup) return;
  api.custom('fetchRecentGroup', async ({ ctx, utils, props }) => {
    const groupId = String(props.groupId || '');
    const count = capHistoryCount(Number(props.count) || 50);
    const hosts = recentGroupHosts(
      api.zpwServiceMap as { group_cloud_message?: string[]; group?: string[] }
    );
    const attempts: Array<{ host: string; method: 'GET' | 'POST' }> = [
      ...hosts.map((host) => ({ host, method: 'GET' as const })),
      { host: hosts[hosts.length - 1] || HARDCODED_CM_HOST, method: 'POST' },
    ];
    let lastErr: unknown;
    const seen = new Set<string>();
    for (const attempt of attempts) {
      const key = `${attempt.method} ${attempt.host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        return await requestRecentGroup(
          utils as HistoryUtils,
          ctx,
          attempt.host,
          groupId,
          count,
          attempt.method
        );
      } catch (err: unknown) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code?: unknown }).code
            : '';
        console.error(
          '[TaskProofWorker] getrecentv2 lỗi:',
          attempt.method,
          attempt.host,
          'count=',
          count,
          code || '',
          msg
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'getrecentv2 failed'));
  });
}

function fetchOldGroupMessagesViaWs(
  api: API,
  groupId: string,
  timeoutMs = 8000
): Promise<ZcaHistoryPage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.listener.off('old_messages', onOld);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('websocket timeout')));
    }, timeoutMs);
    const onOld = (messages: Message[], type: ThreadType) => {
      if (type !== ThreadType.Group) return;
      const mapped = messages
        .filter((m) => String(m.threadId || '') === String(groupId))
        .map((m) => normalizeZcaInbound(m));
      if (mapped.length === 0 && messages.length > 0) return;
      finish(() => resolve({ more: 0, messages: mapped }));
    };
    api.listener.on('old_messages', onOld);
    api.listener.requestOldMessages(ThreadType.Group);
  });
}

function credsFromContext(api: { getContext: () => unknown }): ZcaCredentials | null {
  const ctx = api.getContext() as {
    cookie?: { toJSON?: () => { cookies?: unknown } | undefined };
    imei?: string;
    userAgent?: string;
  };
  if (!ctx?.imei || !ctx.userAgent) return null;
  const serialized = ctx.cookie?.toJSON?.();
  return {
    cookie: serialized?.cookies ?? ctx.cookie,
    imei: ctx.imei,
    userAgent: ctx.userAgent,
  };
}

function asIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // comma / space separated
    }
    return trimmed.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function mediaFromRecord(rec: Record<string, unknown>): {
  href: string;
  thumb: string;
  contentType: string;
} {
  let href = firstNonEmptyString(rec.href);
  let thumb = firstNonEmptyString(rec.thumb, rec.oriUrl, rec.originUrl);
  const contentType = typeof rec.type === 'string' ? rec.type : '';
  const paramsRaw = rec.params;
  if (typeof paramsRaw === 'string' && paramsRaw.trim().startsWith('{')) {
    try {
      const params = JSON.parse(paramsRaw) as Record<string, unknown>;
      href = href || firstNonEmptyString(params.href, params.imageUrl, params.originUrl, params.oriUrl);
      thumb = thumb || firstNonEmptyString(params.thumb, params.thumbUrl, params.previewUrl);
    } catch {
      // params không phải JSON ảnh
    }
  }
  return { href, thumb, contentType };
}

function extractMedia(content: unknown): { href: string; thumb: string; contentType: string } {
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object') {
        const media = mediaFromRecord(item as Record<string, unknown>);
        if (media.href || media.thumb) return media;
      }
    }
    return { href: '', thumb: '', contentType: '' };
  }
  if (content && typeof content === 'object') {
    return mediaFromRecord(content as Record<string, unknown>);
  }
  return { href: '', thumb: '', contentType: '' };
}

export function normalizeZcaInbound(message: {
  type: number;
  threadId: string;
  data: {
    content?: unknown;
    dName?: string;
    msgId?: string;
    realMsgId?: string;
    uidFrom?: string;
    msgType?: string;
    ts?: string | number;
  };
}): ZcaInboundMessage {
  const content = message.data.content;
  const text = typeof content === 'string' ? content : '';
  const media = extractMedia(content);
  const href = media.href;
  const thumb = media.thumb;
  const contentType = media.contentType;
  const msgType = message.data.msgType || '';
  const isGif = /gif/i.test(contentType) || /gif/i.test(msgType) || /\.gif(\?|#|$)/i.test(href);
  const isPhotoType = /^chat\.photo/i.test(msgType) || /photo/i.test(contentType);
  const isLinkType =
    /^(chat\.link|chat\.recommended)$/i.test(msgType) ||
    /^(recommend|link|share)$/i.test(contentType);
  const hrefLooksLikeImage = isImageHref(href) || isImageHref(thumb);
  const isLinkCard =
    !isGif &&
    Boolean(href || thumb) &&
    (isLinkType ||
      (!isPhotoType && !hrefLooksLikeImage && !/^https?:\/\/(?:photo-|fsh-)/i.test(href || thumb)));
  const hasImage = Boolean((href || thumb) && !isGif && !isLinkCard);
  return {
    threadId: message.threadId,
    isGroup: message.type === ThreadType.Group,
    text,
    displayName: message.data.dName || '',
    hasImage,
    isLinkCard,
    shareHref: isLinkCard ? href : undefined,
    msgId: message.data.msgId || message.data.realMsgId || '',
    uidFrom: message.data.uidFrom || '',
    href: href || undefined,
    thumb: thumb || undefined,
    contentType: contentType || undefined,
    msgType: msgType || undefined,
    ts: parseZcaTs(message.data.ts) || undefined,
  };
}

export function createZcaLoginPort(): ZcaLoginPort {
  let activeApi: API | null = null;
  let loopHandler: ((msg: ZcaInboundMessage) => void) | null = null;
  let wired = false;

  const wireListener = (api: API) => {
    if (!loopHandler || wired) return;
    wired = true;
    api.listener.on('message', (message) => {
      try {
        loopHandler?.(normalizeZcaInbound(message));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[TaskProofWorker] Lỗi xử lý tin zca-js:', msg);
      }
    });
    api.listener.start({ retryOnClose: true });
  };

  return {
    async login(credentials: ZcaCredentials): Promise<void> {
      const zalo = new Zalo();
      activeApi = await zalo.login(credentials as Credentials);
      wireRecentHistoryApi(activeApi);
      wireListener(activeApi);
    },

    async loginQR(opts: QrLoginOpts): Promise<ZcaCredentials> {
      const zalo = new Zalo();
      fs.mkdirSync(path.dirname(opts.qrPath), { recursive: true });

      const qrCtl: { abort: (() => void) | null } = { abort: null };
      let gotCreds: ZcaCredentials | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;

      const dropApi = (api: API | null) => {
        if (!api) return;
        try {
          api.listener.stop();
        } catch {
          // best-effort
        }
        if (activeApi === api) activeApi = null;
      };

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          qrCtl.abort?.();
          dropApi(activeApi);
          reject(Object.assign(new Error('qr_timeout'), { code: 'qr_timeout' }));
        }, opts.timeoutMs);
      });

      // zca-js không await callback — lỗi trong async callback phải reject
      // promise của mình, không để unhandledRejection giết worker.
      let rejectCallback: ((err: Error) => void) | null = null;
      const callbackFailed = new Promise<never>((_, reject) => {
        rejectCallback = reject;
      });

      const loginPromise = zalo
        .loginQR({ qrPath: opts.qrPath }, (event) => {
          void (async () => {
            if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
              await event.actions.saveToFile(opts.qrPath);
              qrCtl.abort = () => {
                try {
                  event.actions.abort();
                } catch {
                  // abort best-effort
                }
              };
              await opts.onGenerated({ abort: qrCtl.abort });
            } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
              gotCreds = {
                cookie: event.data.cookie,
                imei: event.data.imei,
                userAgent: event.data.userAgent,
              };
            } else if (
              event.type === LoginQRCallbackEventType.QRCodeExpired ||
              event.type === LoginQRCallbackEventType.QRCodeDeclined
            ) {
              try {
                event.actions.abort();
              } catch {
                // spec: không auto-retry
              }
            }
          })().catch((err: unknown) => {
            qrCtl.abort?.();
            const wrapped = err instanceof Error ? err : new Error(String(err));
            rejectCallback?.(wrapped);
          });
        })
        .then((api) => {
          if (timedOut) {
            dropApi(api);
            return { api: null as API | null, creds: null as ZcaCredentials | null };
          }
          const fromCtx = credsFromContext(api);
          return { api, creds: gotCreds || fromCtx };
        });

      try {
        const result = (await Promise.race([loginPromise, timeoutPromise, callbackFailed])) as {
          api: API | null;
          creds: ZcaCredentials | null;
        };
        if (!result?.api || !result.creds) throw new Error('QR login finished without credentials');
        activeApi = result.api;
        wireRecentHistoryApi(result.api);
        wireListener(result.api);
        return result.creds;
      } catch (err) {
        try {
          qrCtl.abort?.();
        } catch {
          // best-effort
        }
        dropApi(activeApi);
        throw err;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },

    startMessageLoop(handler: (msg: ZcaInboundMessage) => void): void {
      loopHandler = handler;
      if (activeApi) wireListener(activeApi);
    },

    stopMessageLoop(): void {
      loopHandler = null;
      try {
        activeApi?.listener.stop();
      } catch {
        // best-effort
      }
      wired = false;
    },

    logout(): void {
      loopHandler = null;
      try {
        activeApi?.listener.stop();
      } catch {
        // best-effort
      }
      activeApi = null;
      wired = false;
    },

    getOwnId(): string {
      try {
        return activeApi?.getOwnId() || '';
      } catch {
        return '';
      }
    },

    async getGroupInfo(groupId: string): Promise<ZcaGroupInfoSnapshot | null> {
      if (!activeApi) return null;
      const res = await activeApi.getGroupInfo(groupId);
      const map = res?.gridInfoMap || {};
      const info = map[groupId] || Object.values(map)[0];
      if (!info) return null;
      const extra = info as typeof info & {
        memVerList?: unknown;
        setting?: { lockViewMember?: number };
      };
      return {
        groupId: info.groupId || groupId,
        name: info.name || '',
        memberIds: asIdList(info.memberIds),
        currentMems: (info.currentMems || []).map((m) => ({
          id: String(m.id),
          dName: m.dName || '',
        })),
        totalMember: Number(info.totalMember || 0),
        hasMoreMember: Boolean(info.hasMoreMember),
        memVerList: asIdList(extra.memVerList),
        adminIds: asIdList(info.adminIds),
        creatorId: info.creatorId ? String(info.creatorId) : '',
        lockViewMember: Number(extra.setting?.lockViewMember || 0) === 1,
      };
    },

    async getGroupMembersInfo(ids: string[]): Promise<ZcaMemberProfile[]> {
      if (!activeApi || ids.length === 0) return [];
      const res = await activeApi.getGroupMembersInfo(ids);
      const profiles = res?.profiles || {};
      return Object.values(profiles).map((p) => ({
        id: String(p.id),
        displayName: p.displayName || p.zaloName || String(p.id),
      }));
    },

    async sendGroupMessage(
      threadId: string,
      content: { msg: string; mentions?: ZcaMention[] }
    ): Promise<void> {
      if (!activeApi) throw new Error('zca-js is not logged in');
      await activeApi.sendMessage(
        { msg: content.msg, mentions: content.mentions },
        threadId,
        ThreadType.Group
      );
    },

    async getGroupChatHistory(groupId: string, count = 50): Promise<ZcaHistoryPage> {
      if (!activeApi) return { more: 0, messages: [] };
      // zca-js getGroupChatHistory (/api/group/history) 404 trên Zalo hiện tại.
      wireRecentHistoryApi(activeApi);
      const fetchRecent = (activeApi as RecentHistoryApi).fetchRecentGroup;
      if (!fetchRecent) {
        throw new Error('fetchRecentGroup is not available');
      }
      try {
        const raw = await fetchRecent({ groupId, count: capHistoryCount(count) });
        return mapHistoryMessages(groupId, activeApi.getOwnId() || '', raw);
      } catch (err: unknown) {
        console.error('[TaskProofWorker] getrecentv2 hết cách HTTP, thử websocket:', formatHistoryApiError(err));
        try {
          return await fetchOldGroupMessagesViaWs(activeApi, groupId);
        } catch (wsErr: unknown) {
          const wsMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
          console.error('[TaskProofWorker] websocket history lỗi:', wsMsg);
          throw new Error(formatHistoryApiError(err));
        }
      }
    },
  };
}
