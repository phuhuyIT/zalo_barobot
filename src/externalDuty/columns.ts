/**
 * Đọc các cột ca của một ngày và khớp từ khóa `ca 2` với đúng cột trên sheet.
 * `ca 2` không chọn cột `Đi tuần - Ca 2`.
 */

import { HeaderStyle } from '../types';
import { isPlaceholderOrEmpty, normalizeDate } from '../sheets/dateUtils';
import { detectSingleRowLayout } from '../sheets/gateDutySingleRowParser';
import { detectTwoRowLayout, ColumnHeader } from '../sheets/gateDutyTwoRowParser';
import { ShiftColumn } from './types';

export function foldText(value: string): string {
  return value
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bca\s*(\d+)\b/g, 'ca $1')
    .replace(/\s+/g, ' ')
    .trim();
}

function caNumberFromOwnHeader(header: ColumnHeader): number | null {
  if (header.parentName) return null;
  const match = header.name.match(/^ca\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

export function readShiftColumns(
  rows: unknown[][],
  headerStyle: HeaderStyle,
  targetDate: string
): { found: boolean; unit?: string; rowIndex?: number; columns: ShiftColumn[] } {
  const normalizedTarget = normalizeDate(targetDate);
  if (!normalizedTarget) {
    return { found: false, columns: [] };
  }

  if (headerStyle === 'single_row') {
    const layout = detectSingleRowLayout(rows);
    const start = layout.headerRowIndex + 1;
    for (let r = start; r < rows.length; r++) {
      const row = rows[r] || [];
      if (normalizeDate(row[layout.dateColIndex]) !== normalizedTarget) continue;
      return {
        found: true,
        unit: layout.unit,
        rowIndex: r,
        columns: layout.taskColumns.map((col) => toShiftColumn(col, row[col.index])),
      };
    }
    return { found: false, unit: layout.unit, columns: [] };
  }

  const layout = detectTwoRowLayout(rows);
  const start = layout.headerRow2Index + 1;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r] || [];
    if (normalizeDate(row[layout.dateColIndex]) !== normalizedTarget) continue;
    return {
      found: true,
      unit: layout.unit,
      rowIndex: r,
      columns: layout.taskColumns.map((col) => toShiftColumn(col, row[col.index])),
    };
  }
  return { found: false, unit: layout.unit, columns: [] };
}

function toShiftColumn(header: ColumnHeader, rawValue: unknown): ShiftColumn {
  const raw = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
  return {
    name: header.name,
    parentName: header.parentName,
    subName: header.subName,
    raw,
    empty: isPlaceholderOrEmpty(rawValue),
    caNumber: caNumberFromOwnHeader(header),
    colIndex: header.index,
  };
}

/** Ô ghi đúng "Chờ" là ca chưa xếp. Ô trống, "-", "N/A", "Empty" không phải ca chờ. */
export function isChoCell(value: string): boolean {
  return foldText(value) === 'cho';
}

export function findChoColumns(columns: ShiftColumn[]): ShiftColumn[] {
  return columns.filter((col) => col.caNumber !== null && isChoCell(col.raw));
}

export function matchShiftColumn(
  columns: ShiftColumn[],
  query: string
): { ok: true; column: ShiftColumn } | { ok: false; reason: 'none' | 'many' } {
  const canon = foldText(query);
  const caMatch = canon.match(/^ca (\d+)$/);
  const patrol = /\btuan\b/.test(canon) && /\bca \d+\b/.test(canon);
  const caToken = canon.match(/\bca (\d+)\b/);

  let hits: ShiftColumn[];
  if (caMatch) {
    const n = Number(caMatch[1]);
    hits = columns.filter((col) => col.caNumber === n);
  } else if (patrol && caToken) {
    const n = Number(caToken[1]);
    hits = columns.filter((col) => {
      const name = foldText(`${col.parentName || ''} ${col.subName || col.name}`);
      return /\btuan\b/.test(name) && new RegExp(`\\bca ${n}\\b`).test(name);
    });
  } else {
    hits = columns.filter((col) => foldText(col.name) === canon || foldText(col.name).startsWith(`${canon} `));
  }

  if (hits.length === 1) return { ok: true, column: hits[0] };
  if (hits.length === 0) return { ok: false, reason: 'none' };
  return { ok: false, reason: 'many' };
}

export function columnHeaders(columns: ShiftColumn[]): string[] {
  return columns.map((col) => col.name);
}
