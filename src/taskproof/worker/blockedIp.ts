/**
 * blockedIp.ts
 *
 * Chặn IP nội bộ khi tải URL (SSRF). Dùng chung cho ảnh minh chứng.
 */

import net from 'node:net';

export function isBlockedIp(ip: string): boolean {
  const value = (ip || '').trim().toLowerCase();
  if (!value) return true;

  if (value.startsWith('::ffff:')) {
    return isBlockedIp(value.slice(7));
  }

  const v4 = net.isIP(value);
  if (v4 === 4) {
    const parts = value.split('.').map((item) => Number(item));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (v4 === 6) {
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fe80:')) return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    return false;
  }

  return true;
}
