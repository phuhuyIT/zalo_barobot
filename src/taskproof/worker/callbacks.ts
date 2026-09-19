/**
 * callbacks.ts
 *
 * Worker → official bot qua HTTP localhost. Không import zaloClient /
 * không gọi Official Bot Platform (hai identity Zalo tách biệt).
 */

import { getInternalApiKey, getOfficialBotOrigin } from '../env';

export async function postToOfficialBot(
  pathname: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${getOfficialBotOrigin()}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': getInternalApiKey(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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
