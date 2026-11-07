/**
 * workerClient.ts
 *
 * Official bot → worker (127.0.0.1:3001). Timeout ngắn: webhook không
 * được treo chờ người quét QR (ensure-listening trả qr_required ngay).
 */

import { getInternalApiKey, getWorkerOrigin } from '../env';

export type EnsureListeningState =
  | 'listening'
  | 'reusing_session'
  | 'qr_required'
  | 'pending_link'
  | 'login_failed'
  | 'qr_timeout';

export interface EnsureListeningResponse {
  status: number;
  state: EnsureListeningState;
  error?: string;
  raw: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function workerFetch(
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ status: number; json: Record<string, unknown> }> {
  const key = getInternalApiKey();
  const res = await fetch(`${getWorkerOrigin()}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

export async function postEnsureListening(taskId?: string): Promise<EnsureListeningResponse> {
  const { status, json } = await workerFetch('POST', '/internal/taskproof/ensure-listening', {
    task_id: taskId,
  });
  const state = (typeof json.state === 'string' ? json.state : 'login_failed') as EnsureListeningState;
  return {
    status,
    state,
    error: typeof json.error === 'string' ? json.error : undefined,
    raw: json,
  };
}

export async function postRemind(taskId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return workerFetch('POST', '/internal/taskproof/remind', { task_id: taskId });
}

export async function postScanHistory(
  taskId: string,
  count: number,
  replyChatId: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  return workerFetch('POST', '/internal/taskproof/scan-history', {
    task_id: taskId,
    count,
    reply_chat_id: replyChatId,
  });
}

export async function postLinkGroup(
  officialChatId: string,
  zcaGroupId?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  return workerFetch('POST', '/internal/taskproof/link-group', {
    official_chat_id: officialChatId,
    zca_group_id: zcaGroupId,
  });
}

export async function getWorkerStatus(): Promise<{ status: number; json: Record<string, unknown> }> {
  return workerFetch('GET', '/internal/taskproof/status');
}

/** /huy /dong: worker xét logout nếu không còn task liên kết mở. */
export async function postMaybeStop(): Promise<{ status: number; json: Record<string, unknown> }> {
  return workerFetch('POST', '/internal/taskproof/maybe-stop');
}

/** Tải lại tên thành viên các nhóm đã map. Worker phải đang login. */
export async function postRefreshMembers(): Promise<{ status: number; json: Record<string, unknown> }> {
  return workerFetch('POST', '/internal/taskproof/refresh-members', {}, 30_000);
}

