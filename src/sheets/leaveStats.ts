/**
 * leaveStats.ts
 *
 * Tính toán thống kê tần suất đi tranh thủ cho từng thành viên (F13).
 *
 * Quy tắc nghiệp vụ:
 * 1. Số lần đã được về: đếm số lượt tên xuất hiện ở cột "người về".
 * 2. Số lần mất lượt: đếm số lượt tên xuất hiện ở cột "người mất lượt".
 * 3. Lần gần nhất được về: ngày của lượt gần nhất người đó có tên ở "người về".
 * 4. Đang cách bao nhiêu lượt chưa về: đếm số lượt (hàng) kể từ lượt gần nhất
 *    được về (không tính lượt đó) tới lượt mới nhất trong sheet.
 *    Nếu chưa từng về lượt nào -> null (hiển thị "chưa từng về").
 * 5. Mặc định sắp theo "đang cách bao nhiêu lượt chưa về" giảm dần (người lâu chưa về lên đầu).
 */

import { LeaveRoster, LeaveStatsData, MemberLeaveStat } from '../types';
import { parseDMYToDate } from './dateUtils';
import { readSheetTab } from './sheetsClient';
import { parseLeaveRoster } from './leaveRosterParser';

/**
 * Tính toán số liệu thống kê từ danh sách LeaveRoster (Pure function).
 */
export function computeLeaveStats(roster: LeaveRoster): LeaveStatsData {
  if (!roster.entries || roster.entries.length === 0) {
    return {
      unit: roster.unit,
      totalTurns: 0,
      stats: [],
    };
  }

  // 1. Sắp xếp các lượt tranh thủ theo thứ tự thời gian tăng dần
  const sortedEntries = [...roster.entries].sort((a, b) => {
    const timeA = parseDMYToDate(a.date)?.getTime() || 0;
    const timeB = parseDMYToDate(b.date)?.getTime() || 0;
    return timeA - timeB;
  });

  const totalTurns = sortedEntries.length;
  const latestTurnDate = totalTurns > 0 ? sortedEntries[totalTurns - 1].date : undefined;

  // 2. Thu thập danh sách thành viên và đếm số liệu
  const memberMap = new Map<
    string,
    {
      leaveCount: number;
      missedCount: number;
      lastLeaveDate: string | null;
      lastLeaveIndex: number;
    }
  >();

  const getOrCreate = (name: string) => {
    let stat = memberMap.get(name);
    if (!stat) {
      stat = {
        leaveCount: 0,
        missedCount: 0,
        lastLeaveDate: null,
        lastLeaveIndex: -1,
      };
      memberMap.set(name, stat);
    }
    return stat;
  };

  sortedEntries.forEach((entry, index) => {
    // Cột người về
    for (const name of entry.onLeave) {
      const cleanName = String(name || '').trim();
      if (cleanName) {
        const stat = getOrCreate(cleanName);
        stat.leaveCount += 1;
        stat.lastLeaveDate = entry.date;
        stat.lastLeaveIndex = index;
      }
    }

    // Cột mất lượt
    for (const name of entry.missedTurn) {
      const cleanName = String(name || '').trim();
      if (cleanName) {
        const stat = getOrCreate(cleanName);
        stat.missedCount += 1;
      }
    }
  });

  // 3. Chuyển đổi thành MemberLeaveStat và tính số lượt cách lượt gần nhất
  const stats: MemberLeaveStat[] = [];
  for (const [name, stat] of memberMap.entries()) {
    const turnsSinceLastLeave =
      stat.lastLeaveIndex === -1 ? null : totalTurns - 1 - stat.lastLeaveIndex;

    stats.push({
      name,
      leaveCount: stat.leaveCount,
      missedCount: stat.missedCount,
      lastLeaveDate: stat.lastLeaveDate,
      turnsSinceLastLeave,
    });
  }

  // 4. Sắp xếp mặc định: "đang cách bao nhiêu lượt chưa về" giảm dần
  // Người chưa từng về (null) coi như cách xa nhất -> lên đầu bảng
  stats.sort((a, b) => {
    if (a.turnsSinceLastLeave === null && b.turnsSinceLastLeave !== null) return -1;
    if (a.turnsSinceLastLeave !== null && b.turnsSinceLastLeave === null) return 1;

    if (a.turnsSinceLastLeave !== null && b.turnsSinceLastLeave !== null) {
      if (b.turnsSinceLastLeave !== a.turnsSinceLastLeave) {
        return b.turnsSinceLastLeave - a.turnsSinceLastLeave;
      }
    }

    // Ưu tiên người có số lần về ít hơn
    if (a.leaveCount !== b.leaveCount) {
      return a.leaveCount - b.leaveCount;
    }

    // Ưu tiên người bị mất lượt nhiều hơn
    if (b.missedCount !== a.missedCount) {
      return b.missedCount - a.missedCount;
    }

    return a.name.localeCompare(b.name, 'vi');
  });

  return {
    unit: roster.unit,
    totalTurns,
    latestTurnDate,
    stats,
  };
}

/**
 * Đọc từ Google Sheet và tính toán thống kê tranh thủ (F13).
 */
export async function fetchLeaveStats(
  spreadsheetId: string,
  tabName: string
): Promise<LeaveStatsData> {
  const rows = await readSheetTab(spreadsheetId, tabName);
  const roster = parseLeaveRoster(rows);
  return computeLeaveStats(roster);
}
