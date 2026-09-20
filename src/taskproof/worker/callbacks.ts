/**
 * callbacks.ts
 *
 * Worker → official bot qua HTTP localhost. Không import zaloClient /
 * không gọi Official Bot Platform (hai identity Zalo tách biệt).
 */

import { getInternalApiKey, getOfficialBotOrigin } from '../env';

export async function postToOfficialBot(
  pathname: string,
  body: unknown,
  timeoutMs = 15_000
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${getOfficialBotOrigin()}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': getInternalApiKey(),
    },
    body: JSON.stringify(body),
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

export async function deliverQr(imageUrl: string, expiresAt: number): Promise<{ status: number; json: Record<string, unknown> }> {
  return postToOfficialBot('/internal/taskproof/deliver-qr', {
    image_url: imageUrl,
    expires_at: expiresAt,
  });
}

export async function postLoginResult(
  ok: boolean,
  error?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  return postToOfficialBot('/internal/taskproof/login-result', { ok, error });
}

export async function postLinkResult(body: {
  official_chat_id: string;
  ok: boolean;
  zca_group_id?: string;
  display_name?: string;
  error?: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  return postToOfficialBot('/internal/taskproof/link-result', body);
}

/** Quota vừa đủ — official bot gửi T6 ngay. Timeout dài vì sendPhoto. */
export async function postReportNow(
  taskId: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  return postToOfficialBot('/internal/taskproof/report-now', { task_id: taskId }, 60_000);
}

/** /quet xong — official bot gửi kết quả vào nhóm. */
export async function postScanResult(body: {
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
}): Promise<{ status: number; json: Record<string, unknown> }> {
  return postToOfficialBot('/internal/taskproof/scan-result', body);
}
