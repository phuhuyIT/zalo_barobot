/**
 * zcaAdapter.ts
 *
 * Bọc zca-js. Chỉ worker process được import file này.
 * Official bot không được import zca-js.
 */

import fs from 'fs';
import path from 'path';
import { Zalo, LoginQRCallbackEventType, ThreadType, type Credentials, type API } from 'zca-js';
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
  msgId?: string;
  uidFrom?: string;
  href?: string;
  thumb?: string;
  contentType?: string;
  msgType?: string;
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
  };
}): ZcaInboundMessage {
  const content = message.data.content;
  const text = typeof content === 'string' ? content : '';
  let href = '';
  let thumb = '';
  let contentType = '';
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    href = typeof rec.href === 'string' ? rec.href : '';
    thumb = typeof rec.thumb === 'string' ? rec.thumb : '';
    contentType = typeof rec.type === 'string' ? rec.type : '';
  }
  const msgType = message.data.msgType || '';
  const isGif = /gif/i.test(contentType) || /gif/i.test(msgType) || /\.gif(\?|#|$)/i.test(href);
  const hasImage = Boolean((href || thumb) && !isGif);
  return {
    threadId: message.threadId,
    isGroup: message.type === ThreadType.Group,
    text,
    displayName: message.data.dName || '',
    hasImage,
    msgId: message.data.msgId || message.data.realMsgId || '',
    uidFrom: message.data.uidFrom || '',
    href: href || undefined,
    thumb: thumb || undefined,
    contentType: contentType || undefined,
    msgType: msgType || undefined,
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
      wireListener(activeApi);
    },

    async loginQR(opts: QrLoginOpts): Promise<ZcaCredentials> {
      const zalo = new Zalo();
      fs.mkdirSync(path.dirname(opts.qrPath), { recursive: true });

      let abortQr: (() => void) | null = null;
      let gotCreds: ZcaCredentials | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortQr?.();
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
              abortQr = () => {
                try {
                  event.actions.abort();
                } catch {
                  // abort best-effort
                }
              };
              await opts.onGenerated({ abort: abortQr });
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
            abortQr?.();
            const wrapped = err instanceof Error ? err : new Error(String(err));
            rejectCallback?.(wrapped);
          });
        })
        .then((api) => {
          activeApi = api;
          wireListener(api);
          const fromCtx = credsFromContext(api);
          return gotCreds || fromCtx;
        });

      try {
        const creds = await Promise.race([loginPromise, timeoutPromise, callbackFailed]);
        if (!creds) throw new Error('QR login finished without credentials');
        return creds;
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
      return {
        groupId: info.groupId || groupId,
        name: info.name || '',
        memberIds: Array.isArray(info.memberIds) ? info.memberIds.map(String) : [],
        currentMems: (info.currentMems || []).map((m) => ({
          id: String(m.id),
          dName: m.dName || '',
        })),
        totalMember: Number(info.totalMember || 0),
        hasMoreMember: Boolean(info.hasMoreMember),
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
  };
}
