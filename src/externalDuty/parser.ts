/**
 * Cú pháp: `a2 ca1 Nguyễn Văn A` hoặc `culi ca4 Trần Văn B`.
 * Nhiều người cách nhau bằng dấu phẩy. Không có chữ doi, không có dấu hai chấm.
 */

import { DoiLine, ExternalDutyConfig, ExternalSquad } from './types';
import { foldText } from './columns';

export interface ParseDoiSuccess {
  ok: true;
  lines: DoiLine[];
}

export interface ParseDoiFailure {
  ok: false;
  notCommand?: boolean;
  error: string;
}

function squadForAlias(alias: string, config: ExternalDutyConfig): ExternalSquad | null {
  const word = alias.trim().toLowerCase();
  if (word === config.aliasMain.trim().toLowerCase()) return 'main';
  if (word === config.aliasCuli.trim().toLowerCase()) return 'culi';
  return null;
}

const MAX_NAMES_PER_SHIFT = 8;
const MAX_NAME_LENGTH = 80;
const MAX_COMMAND_LINES = 20;

export function splitPeople(raw: string): { cleared: boolean; names: string[] } {
  const text = raw.trim();
  if (text === '0') return { cleared: true, names: [] };
  const names = text
    .split(/\s*(?:,|\+| và | va )\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return { cleared: false, names };
}

export function parseConfirmWord(text: string): 'yes' | 'no' | null {
  const word = foldText(text);
  if (word === 'yes' || word === 'dung') return 'yes';
  if (word === 'no' || word === 'ko' || word === 'k' || word === 'khong') return 'no';
  return null;
}

export function parseDoiMessage(text: string, config: ExternalDutyConfig): ParseDoiSuccess | ParseDoiFailure {
  const aliasPattern = [config.aliasMain, config.aliasCuli]
    .map((alias) => alias.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean)
    .join('|');
  if (!aliasPattern) return { ok: false, notCommand: true, error: 'Chưa cấu hình alias' };

  const lines: DoiLine[] = [];
  let sawAlias = false;
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(new RegExp(`^(?:\\/)?(${aliasPattern})\\s+ca\\s*(\\d+)\\b\\s*(.*)$`, 'i'));
    if (!match) continue;
    sawAlias = true;
    const squad = squadForAlias(match[1], config);
    if (!squad) {
      return { ok: false, error: `Không rõ tiểu đội "${match[1]}". Dùng ${config.aliasMain} hoặc ${config.aliasCuli}.` };
    }
    const people = splitPeople(match[3]);
    if (!people.cleared && people.names.length === 0) {
      return {
        ok: false,
        error: `Thiếu tên.\nVí dụ: ${config.aliasMain} ca1 Nguyễn Văn A`,
      };
    }
    if (
      people.names.length > MAX_NAMES_PER_SHIFT ||
      people.names.some((name) => name.length > MAX_NAME_LENGTH)
    ) {
      return { ok: false, error: 'Tên quá dài hoặc quá nhiều người trong một ca.' };
    }
    if (lines.length >= MAX_COMMAND_LINES) {
      return { ok: false, error: 'Quá nhiều dòng lệnh.' };
    }
    lines.push({
      squad,
      shiftQuery: `ca ${match[2]}`,
      names: people.names,
      cleared: people.cleared,
    });
  }
  if (!sawAlias) return { ok: false, notCommand: true, error: 'Tin nhắn không phải lệnh xếp ca' };
  if (lines.length === 0) {
    return { ok: false, error: `Ví dụ: ${config.aliasMain} ca1 Nguyễn Văn A` };
  }
  return { ok: true, lines };
}
