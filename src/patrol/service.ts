import Database from 'better-sqlite3';
import { ZaloClient } from '../core/zaloClient';
import { getEffectiveScheduleConfig } from '../core';
import { fetchDutySchedule, getVietnamTimeParts } from '../sheets';
import {
  getPatrolDailyStatus,
  getAllPatrolDailyStatusForDate,
  savePatrolSubmission,
  getPatrolMembers,
  getPatrolSiteConfigs,
  getPatrolSummaryStatus,
  savePatrolSummaryStatus,
  getPatrolReporterStatus,
  savePatrolReporterSubmission,
} from './repository';
import { parsePatrolCommand } from './parser';
import {
  PatrolCommandPayload,
  PatrolCommandResult,
  PatrolReporterStatus,
  PatrolShift,
  PatrolSiteConfig,
} from './types';
import { getRecipientChatId, getConfig } from '../config';
import { getRecipient } from '../store';

export interface SitePatrolDisplayData {
  siteKey: string;
  displayName: string;
  hasPatrol: boolean;
  isMultiShift?: boolean;
  shifts: PatrolShift[];
  /** Khi trụ sở chưa nộp. Không dùng cho tin nhắn đã gửi. */
  pendingLabel?: string;
}

/**
 * Lấy cấu hình User ID của Tiểu đội trưởng 1.
 */
export function getSquad1LeaderUserId(): string {
  return (
    process.env.TIUDOI_1_LEADER_USER_ID ||
    process.env.TIEU_DOI_1_LEADER_USER_ID ||
    process.env.SQUAD_1_LEADER_USER_ID ||
    ''
  ).trim();
}

/**
 * Lấy cấu hình Chat ID của nhóm đi tuần (PATROL_GROUP_ID).
 */
export function getPatrolGroupId(): string {
  return (
    process.env.PATROL_GROUP_ID ||
    process.env.PATROL_CHAT_ID ||
    ''
  ).trim();
}

/**
 * Lấy Chat ID của Trung đội trưởng nhận báo cáo.
 * Ưu tiên:
 * 1. Bảng recipients trong SQLite DB (được cấu hình qua Web UI)
 * 2. Biến môi trường PLATOON_LEADER_CHAT_ID
 * 3. File config YAML
 */
export function getPlatoonLeaderChatId(database?: Database.Database): string {
  // 1. Ưu tiên tra cứu từ recipients trong DB SQLite
  try {
    const recipient = getRecipient('platoon_leader', database);
    if (recipient && recipient.chat_id && recipient.chat_id.trim()) {
      return recipient.chat_id.trim();
    }
  } catch (_) {}

  // 2. Dự phòng từ biến môi trường PLATOON_LEADER_CHAT_ID
  const envId = (process.env.PLATOON_LEADER_CHAT_ID || '').trim();
  if (envId) return envId;

  // 3. Dự phòng từ config YAML nếu có
  try {
    const fromConfig = getRecipientChatId('platoon_leader');
    if (fromConfig && fromConfig !== 'platoon_leader') {
      return fromConfig.trim();
    }
  } catch (_) {}

  return '';
}

/**
 * Kiểm tra xem 2 mảng chuỗi có giống hệt nhau không.
 */
function areArraysEqual(arr1: string[], arr2: string[]): boolean {
  if (arr1.length !== arr2.length) return false;
  return arr1.every((val, idx) => val === arr2[idx]);
}

/**
 * Định dạng nội dung tin nhắn báo cáo lịch đi tuần 2 site theo chuẩn tiếng Việt (Mục 6).
 */
export function formatTwoSitesPatrolMessage(
  targetDate: string,
  sitesData: SitePatrolDisplayData[]
): string {
  const lines: string[] = [];
  lines.push(`LỊCH TUẦN TRA (${targetDate})`);

  for (const site of sitesData) {
    lines.push('');
    // Chuẩn hóa tên địa bàn/khu vực sang tiếng Việt:
    // Ghi là Trụ sở 1 (Tân Phước Khánh) và Trụ sở 2 (Thạnh Hội)
    let title = (site.displayName || '').trim();
    if (site.siteKey === 'site_1' && (title === 'site_1' || title === 'Tân Phước Khánh')) {
      title = 'Trụ sở 1 (Tân Phước Khánh)';
    } else if (site.siteKey === 'site_2' && (title === 'site_2' || title === 'Thạnh Hội')) {
      title = 'Trụ sở 2 (Thạnh Hội)';
    } else {
      title = title
        .replace(/^Site\s*1\s*\(?/i, 'Trụ sở 1 (')
        .replace(/^1\.\s*Tân Phước Khánh/i, 'Trụ sở 1 (Tân Phước Khánh)')
        .replace(/^Site\s*2\s*\(?/i, 'Trụ sở 2 (')
        .replace(/^2\.\s*Thạnh Hội/i, 'Trụ sở 2 (Thạnh Hội)')
        .trim();
    }
    if (title.startsWith('Trụ sở 1 (') && !title.includes(')')) {
      title = `${title})`;
    }
    if (title.startsWith('Trụ sở 2 (') && !title.includes(')')) {
      title = `${title})`;
    }
    if (!title.endsWith(':')) {
      title = `${title}:`;
    }
    lines.push(title);

    if (site.pendingLabel) {
      lines.push(site.pendingLabel);
      continue;
    }

    if (!site.hasPatrol || !site.shifts || site.shifts.length === 0) {
      lines.push('(Hôm nay không có ca tuần tra)');
      continue;
    }

    if (site.shifts.length === 1 && !site.isMultiShift) {
      const namesStr = site.shifts[0].members.join(', ');
      const formatted = namesStr.endsWith('.') ? namesStr : `${namesStr}.`;
      lines.push(`- ${formatted}`);
    } else {
      for (const shift of site.shifts) {
        const label = shift.shiftLabel || `Ca ${shift.shiftNumber}`;
        const namesStr = shift.members.join(', ');
        const formatted = namesStr.endsWith('.') ? namesStr : `${namesStr}.`;
        lines.push(`${label}: ${formatted}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Lịch đi tuần cả ngày cho thẻ Tổng quan: hai trụ sở đã nộp, cộng cột Đi tuần trên sheet khi Trụ sở 1 chưa nộp.
 */
export async function buildPatrolOverviewMessage(
  targetDate: string,
  options?: {
    database?: Database.Database;
    sheetTasks?: { taskName: string; assignee: string; subTask?: string }[];
    skipSheetFetch?: boolean;
  }
): Promise<string> {
  const sites = getPatrolSiteConfigs(options?.database).filter((site) => site.enabled);
  const daily = getAllPatrolDailyStatusForDate(targetDate, options?.database);
  const sitesData: SitePatrolDisplayData[] = sites.map((site) => {
    const status = daily.find((row) => row.siteKey === site.siteKey);
    if (!status?.submitted) {
      return {
        siteKey: site.siteKey,
        displayName: site.displayName,
        hasPatrol: false,
        shifts: [],
        pendingLabel: 'Chưa nộp',
      };
    }
    return {
      siteKey: site.siteKey,
      displayName: site.displayName,
      hasPatrol: status.hasPatrol,
      isMultiShift: status.shifts.length > 1,
      shifts: status.shifts,
    };
  });

  const lines = [formatTwoSitesPatrolMessage(targetDate, sitesData)];
  const site1 = daily.find((row) => row.siteKey === 'site_1');
  if (site1?.submitted) return lines[0];

  let tasks = options?.sheetTasks;
  if (!tasks && !options?.skipSheetFetch) {
    try {
      tasks = await fetchMySquadPatrolTasks(targetDate);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Patrol] Không đọc được cột Đi tuần cho Tổng quan:', message);
      tasks = [];
      lines.push('', 'Tiểu đội 2:', 'Không đọc được cột Đi tuần trên sheet.');
      return lines.join('\n');
    }
  }

  lines.push('', 'Tiểu đội 2:');
  if (!tasks || tasks.length === 0) {
    lines.push('Không có tên đi tuần trên sheet.');
  } else {
    for (const task of tasks) {
      lines.push(`- ${task.taskName}: ${task.assignee}`);
    }
  }
  return lines.join('\n');
}

/**
 * Xây dựng nội dung tin nhắn báo cáo lịch đi tuần tổng hợp cho Trung đội trưởng.
 * Hỗ trợ cả chữ ký mới (sitesData) và chữ ký cũ (squad1Members, mySquadPatrolTasks).
 */
export function buildCombinedPatrolMessage(
  targetDate: string,
  squad1MembersOrSites: string[] | SitePatrolDisplayData[],
  mySquadPatrolTasks?: { taskName: string; assignee: string; subTask?: string }[]
): string {
  if (
    Array.isArray(squad1MembersOrSites) &&
    squad1MembersOrSites.length > 0 &&
    typeof squad1MembersOrSites[0] === 'object' &&
    'siteKey' in squad1MembersOrSites[0]
  ) {
    return formatTwoSitesPatrolMessage(
      targetDate,
      squad1MembersOrSites as SitePatrolDisplayData[]
    );
  }

  // Chữ ký tương thích ngược cho các unit test cũ
  const squad1Members = (squad1MembersOrSites as string[]) || [];
  const lines: string[] = [];
  lines.push(`📋 LỊCH ĐI TUẦN TRA NGÀY ${targetDate}`);
  lines.push('');

  lines.push('Tiểu đội 1:');
  for (const name of squad1Members) {
    lines.push(`- ${name}`);
  }

  lines.push('');
  lines.push('Tiểu đội 2:');
  for (const t of mySquadPatrolTasks || []) {
    if (t.subTask) {
      lines.push(`- ${t.subTask}: ${t.assignee}`);
    } else {
      lines.push(`- ${t.taskName}: ${t.assignee}`);
    }
  }

  return lines.join('\n');
}

/**
 * Lấy danh sách ca đi tuần của Tiểu đội mình (Tiểu đội 2) từ Google Sheets cho ngày hôm nay.
 */
export async function fetchMySquadPatrolTasks(targetDate: string): Promise<
  { taskName: string; assignee: string; subTask?: string }[]
> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Biến môi trường GOOGLE_SHEET_ID chưa được cấu hình.');
  }

  // Tái sử dụng cấu hình tab và parser của schedule 'patrol_summary' hoặc 'main_duty'
  let effectiveTabName: string;
  let headerStyle: 'two_row_merged' | 'single_row';

  try {
    const effective = getEffectiveScheduleConfig('patrol_summary');
    effectiveTabName = effective.effectiveTabName;
    headerStyle = effective.squad?.header_style || 'two_row_merged';
  } catch {
    try {
      const effective = getEffectiveScheduleConfig('main_duty');
      effectiveTabName = effective.effectiveTabName;
      headerStyle = effective.squad?.header_style || 'two_row_merged';
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Không thể xác định cấu hình tab Tiểu đội 2: ${msg}`, { cause: e });
    }
  }

  const dutyData = await fetchDutySchedule(
    spreadsheetId,
    effectiveTabName,
    headerStyle,
    targetDate
  );

  if (!dutyData || !dutyData.tasks || dutyData.tasks.length === 0) {
    return [];
  }

  // Lọc riêng các nhiệm vụ đi tuần / tuần tra theo quy ước sẵn có trong patrolOnlyFormatter
  const patrolTasks = dutyData.tasks.filter((t) => {
    const fullName = `${t.parentTask || ''} ${t.taskName}`.toLowerCase();
    return fullName.includes('đi tuần') || fullName.includes('tuần tra');
  });

  return patrolTasks.map((t) => ({
    taskName: t.taskName,
    assignee: t.assignee,
    subTask: t.subTask,
  }));
}

/**
 * Nhóm các nhiệm vụ đi tuần từ Google Sheet thành các ca tuần tra.
 * Phân biệt rõ ngữ nghĩa giữa "Số người trong ca" và "Số ca":
 * - Nếu các subTask là 'Người 1', 'Người 2' (hoặc không chứa từ khóa Ca/Shift):
 *   -> Toàn bộ thành viên thuộc CÙNG 1 CA tuần tra (tổ tuần tra nhiều người).
 * - Nếu các subTask chứa từ khóa 'Ca 1', 'Ca 2' / 'Shift 1', 'Shift 2':
 *   -> Phân tách thành CÁC CA RIÊNG BIỆT theo số ca tương ứng.
 */
export function groupPatrolTasksIntoShifts(
  tasks: { taskName: string; assignee: string; subTask?: string }[]
): {
  shiftNumber: number;
  shiftLabel: string;
  members: string[];
}[] {
  if (!tasks || tasks.length === 0) return [];

  // Kiểm tra xem có bất kỳ task nào chứa từ khóa phân ca tường minh (Ca 1, Ca 2, Shift 1, Shift 2) không
  const hasExplicitShiftKeyword = tasks.some((t) => {
    const textToCheck = `${t.subTask || ''} ${t.taskName || ''}`;
    return /(?:ca|shift)\s*\d+/i.test(textToCheck);
  });

  if (!hasExplicitShiftKeyword) {
    // Trường hợp 1 ca tuần tra nhưng có 1 hoặc nhiều người (ví dụ: 'Người 1', 'Người 2', hoặc không có subTask)
    const members = tasks.map((t) => t.assignee.trim()).filter(Boolean);
    return [
      {
        shiftNumber: 1,
        shiftLabel: 'Ca 1',
        members,
      },
    ];
  }

  // Trường hợp có phân chia ca tường minh (Ca 1, Ca 2, ...)
  const shiftMap = new Map<number, { label: string; members: string[] }>();

  for (const t of tasks) {
    const textToCheck = `${t.subTask || ''} ${t.taskName || ''}`;
    const match = textToCheck.match(/(?:ca|shift)\s*(\d+)/i);
    const shiftNum = match ? parseInt(match[1], 10) : 1;
    const label = `Ca ${shiftNum}`;

    if (!shiftMap.has(shiftNum)) {
      shiftMap.set(shiftNum, { label, members: [] });
    }
    const assignee = (t.assignee || '').trim();
    if (assignee && !shiftMap.get(shiftNum)!.members.includes(assignee)) {
      shiftMap.get(shiftNum)!.members.push(assignee);
    }
  }

  return Array.from(shiftMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([shiftNumber, data]) => ({
      shiftNumber,
      shiftLabel: data.label,
      members: data.members,
    }));
}

/**
 * User ID người báo cáo thứ hai của Trụ sở 1, từ biến môi trường.
 * Dùng khi cột trong SQLite còn trống.
 */
export function getSite1SecondLeaderUserId(): string {
  return (
    process.env.SITE_1_LEADER_2_USER_ID ||
    process.env.TIUDOI_1_LEADER_2_USER_ID ||
    ''
  ).trim();
}

/**
 * Những người được phép gửi lịch của một site.
 * Trụ sở 1 có thể có hai người. Trụ sở 2 luôn một người.
 */
export function getSiteReporterIds(site: PatrolSiteConfig): string[] {
  const ids: string[] = [];
  const primary = (site.leaderUserId || '').trim();
  if (primary) ids.push(primary);
  if (site.siteKey === 'site_1') {
    const second = (site.leaderUserId2 || getSite1SecondLeaderUserId()).trim();
    if (second && !ids.includes(second)) ids.push(second);
  }
  return ids;
}

export interface ReportedPatrolPiece {
  hasPatrol: boolean;
  isMultiShift: boolean;
  members: string[];
  shifts: PatrolShift[];
}

/**
 * Ghép phần lịch của hai người ở Trụ sở 1.
 * Hai người phải cùng báo nghỉ, hoặc cùng một kiểu chia ca. Lệch thì không đoán.
 */
export function combineHeadquartersReports(
  pieces: ReportedPatrolPiece[]
):
  | { ok: true; hasPatrol: boolean; isMultiShift: boolean; members: string[]; shifts: PatrolShift[] }
  | { ok: false; error: string } {
  if (pieces.length === 0) {
    return { ok: false, error: 'Chưa có báo cáo nào từ Trụ sở 1.' };
  }

  const anyPatrol = pieces.some((p) => p.hasPatrol);
  const anyOff = pieces.some((p) => !p.hasPatrol);
  if (anyPatrol && anyOff) {
    return {
      ok: false,
      error:
        'Hai người báo cáo Trụ sở 1 không khớp: một người có ca tuần tra, một người báo nghỉ.',
    };
  }
  if (!anyPatrol) {
    return { ok: true, hasPatrol: false, isMultiShift: false, members: [], shifts: [] };
  }

  const multiFlags = pieces.map((p) => p.isMultiShift);
  if (multiFlags.some(Boolean) && multiFlags.some((flag) => !flag)) {
    return {
      ok: false,
      error: 'Hai người báo cáo Trụ sở 1 không khớp: một người gửi một ca, một người gửi nhiều ca.',
    };
  }

  if (!multiFlags[0]) {
    const members: string[] = [];
    for (const piece of pieces) {
      for (const name of piece.members) {
        if (name && !members.includes(name)) members.push(name);
      }
    }
    return {
      ok: true,
      hasPatrol: true,
      isMultiShift: false,
      members,
      shifts: [{ shiftNumber: 1, shiftLabel: 'Ca 1', members }],
    };
  }

  const shiftKey = (piece: ReportedPatrolPiece) =>
    [...piece.shifts]
      .map((s) => s.shiftNumber)
      .sort((a, b) => a - b)
      .join(',');
  const keys = pieces.map(shiftKey);
  if (new Set(keys).size > 1) {
    return {
      ok: false,
      error: 'Hai người báo cáo Trụ sở 1 lệch số ca. Hệ thống không tự ghép khi số ca khác nhau.',
    };
  }

  const shiftNumbers = [...pieces[0].shifts]
    .map((s) => s.shiftNumber)
    .sort((a, b) => a - b);
  const shifts: PatrolShift[] = shiftNumbers.map((shiftNumber) => {
    const members: string[] = [];
    let shiftLabel = `Ca ${shiftNumber}`;
    for (const piece of pieces) {
      const shift = piece.shifts.find((s) => s.shiftNumber === shiftNumber);
      if (shift?.shiftLabel) shiftLabel = shift.shiftLabel;
      for (const name of shift?.members || []) {
        if (name && !members.includes(name)) members.push(name);
      }
    }
    return { shiftNumber, shiftLabel, members };
  });

  return {
    ok: true,
    hasPatrol: true,
    isMultiShift: true,
    members: shifts.flatMap((s) => s.members),
    shifts,
  };
}

/** Để lần gửi lại cùng messageId vẫn được xét, khi ghép lịch thất bại. */
function releaseReporterMessageId(
  date: string,
  siteKey: string,
  reporterUserId: string,
  database?: Database.Database
): void {
  const row = getPatrolReporterStatus(date, siteKey, reporterUserId, database);
  if (!row?.messageId) return;
  savePatrolReporterSubmission(
    {
      date,
      siteKey,
      reporterUserId,
      groupId: row.groupId,
      senderId: row.senderId || reporterUserId,
      selectedMembers: row.selectedMembers,
      shifts: row.shifts,
      hasPatrol: row.hasPatrol,
      isMultiShift: row.isMultiShift,
      rawMessage: row.rawMessage,
      receivedAt: row.receivedAt,
    },
    database
  );
}

function reporterPiece(row: PatrolReporterStatus): ReportedPatrolPiece {
  return {
    hasPatrol: row.hasPatrol,
    isMultiShift: row.isMultiShift,
    members: row.selectedMembers,
    shifts: row.shifts,
  };
}

async function warnPatrolAdmin(zalo: ZaloClient, message: string): Promise<void> {
  try {
    const config = getConfig();
    const adminChatId = getRecipientChatId('admin', config);
    if (!adminChatId) return;
    await zalo.sendMessage(adminChatId, message);
    console.log(`[Patrol] Đã gửi cảnh báo tới Admin (${adminChatId}).`);
  } catch (adminErr: unknown) {
    const messageText = adminErr instanceof Error ? adminErr.message : String(adminErr);
    console.error('[Patrol] Lỗi gửi cảnh báo tới Admin:', messageText);
  }
}

/**
 * Ghép phần lịch đã báo với cột Tuần tra trên Google Sheet.
 * Site không bật ghép sheet thì giữ nguyên phần đã báo.
 */
async function resolveMergedShifts(
  matchedSite: PatrolSiteConfig,
  todayDmy: string,
  report: { isNoPatrol: boolean; isMultiShift: boolean; members: string[]; shifts: PatrolShift[] },
  options:
    | {
        database?: Database.Database;
        skipSheetFetchForTesting?: boolean;
        mockMySquadTasks?: { taskName: string; assignee: string; subTask?: string }[];
      }
    | undefined,
  zalo: ZaloClient
): Promise<{ ok: true; shifts: PatrolShift[]; members: string[] } | { ok: false; error: string }> {
  if (!matchedSite.mergeWithSheet) {
    if (report.isNoPatrol) return { ok: true, shifts: [], members: [] };
    const shifts = report.shifts.length > 0
      ? report.shifts
      : [{ shiftNumber: 1, shiftLabel: 'Ca 1', members: report.members }];
    const members = report.members.length > 0 ? report.members : shifts.flatMap((s) => s.members);
    return { ok: true, shifts, members };
  }

  let mySquadTasks: { taskName: string; assignee: string; subTask?: string }[] = [];
  if (options?.mockMySquadTasks) {
    mySquadTasks = options.mockMySquadTasks;
  } else if (!options?.skipSheetFetchForTesting) {
    try {
      console.log(`[Patrol] Đang tải lịch đi tuần từ Google Sheets ngày ${todayDmy}...`);
      mySquadTasks = await fetchMySquadPatrolTasks(todayDmy);
      console.log(
        `[Patrol] Lịch Google Sheets giải quyết thành công (${mySquadTasks.length} ca):`,
        mySquadTasks.map((t) => `${t.taskName}: ${t.assignee}`).join(', ')
      );
    } catch (sheetErr: unknown) {
      const messageText = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
      console.error('[Patrol] PATROL SUMMARY FAILED');
      console.error('Reason: Cannot resolve current team\'s patrol schedule:', messageText);
      return {
        ok: false,
        error: `Không thể đọc lịch đi tuần của tiểu đội từ Google Sheet: ${messageText}`,
      };
    }
  }

  const sheetShifts = groupPatrolTasksIntoShifts(mySquadTasks);
  const sheetShiftCount = sheetShifts.length;
  const reportedShiftCount = report.isNoPatrol ? 0 : report.isMultiShift ? report.shifts.length : 1;

  if (reportedShiftCount !== sheetShiftCount) {
    console.warn(
      `[Patrol] LỆCH SỐ CA: Người báo cáo có ${reportedShiftCount} ca, Sheet có ${sheetShiftCount} ca`
    );
    const warnMsg =
      `⚠️ CẢNH BÁO LỆCH SỐ CA TUẦN TRA (${todayDmy}):\n` +
      `Tại ${matchedSite.displayName}, Google Sheet có ${sheetShiftCount} ca nhưng người báo cáo gửi ${reportedShiftCount} ca.\n` +
      `Hệ thống tạm dừng tự động gửi báo cáo tổng hợp. Vui lòng kiểm tra lại Google Sheet hoặc nhắc người báo cáo điều chỉnh.`;
    await warnPatrolAdmin(zalo, warnMsg);
    return {
      ok: false,
      error: `Lệch số ca tuần tra: Google Sheet có ${sheetShiftCount} ca nhưng người báo cáo gửi ${reportedShiftCount} ca (Shift count mismatch)`,
    };
  }

  if (report.isNoPatrol) {
    return { ok: true, shifts: [], members: [] };
  }

  if (report.isMultiShift) {
    const shifts = report.shifts.map((shift, idx) => {
      const sheetShiftMembers = sheetShifts[idx]?.members || [];
      const members = [...shift.members, ...sheetShiftMembers];
      return {
        shiftNumber: shift.shiftNumber,
        shiftLabel: shift.shiftLabel || `Ca ${shift.shiftNumber}`,
        members,
      };
    });
    return { ok: true, shifts, members: shifts.flatMap((s) => s.members) };
  }

  const sheetShiftMembers = sheetShifts[0]?.members || [];
  const members = [...report.members, ...sheetShiftMembers];
  return {
    ok: true,
    shifts: [{ shiftNumber: 1, shiftLabel: 'Ca 1', members }],
    members,
  };
}

/**
 * Tìm site phù hợp cho lệnh tuantra nhận được dựa trên người gửi hoặc nhóm gửi.
 */
export function resolveSiteForCommand(
  senderId: string,
  chatId: string,
  database?: Database.Database
): {
  matchedSite: PatrolSiteConfig | null;
  isAuthorizedSender: boolean;
  isAuthorizedChat: boolean;
} {
  const configs = getPatrolSiteConfigs(database).filter((s) => s.enabled);

  // 1. Tìm site mà senderId trùng người báo cáo (Trụ sở 1 có thể có hai người)
  let matchedSite = configs.find((s) => getSiteReporterIds(s).includes(senderId)) || null;

  // Fallback: nếu chưa cấu hình trong DB, kiểm tra env vars cho site_1
  if (!matchedSite) {
    const s1Leader = getSquad1LeaderUserId();
    const s1Second = getSite1SecondLeaderUserId();
    const s2Leader = (process.env.SITE_2_LEADER_USER_ID || '').trim();

    if ((s1Leader && senderId === s1Leader) || (s1Second && senderId === s1Second)) {
      matchedSite = configs.find((s) => s.siteKey === 'site_1') || {
        siteKey: 'site_1',
        displayName: 'Trụ sở 1 (Tân Phước Khánh)',
        leaderUserId: s1Leader,
        leaderUserId2: s1Second,
        chatId: getPatrolGroupId(),
        mergeWithSheet: true,
        reminderTimes: ['06:30', '06:35', '06:40'],
        maxReminders: 3,
        enabled: true,
      };
    } else if (s2Leader && senderId === s2Leader) {
      matchedSite = configs.find((s) => s.siteKey === 'site_2') || {
        siteKey: 'site_2',
        displayName: 'Trụ sở 2 (Thạnh Hội)',
        leaderUserId: s2Leader,
        chatId: (process.env.SITE_2_PATROL_GROUP_ID || '').trim(),
        mergeWithSheet: false,
        reminderTimes: ['06:30', '06:35', '06:40'],
        maxReminders: 3,
        enabled: true,
      };
    }
  }

  // 2. Nếu senderId không khớp bất kỳ site nào -> Không được ủy quyền
  if (!matchedSite) {
    return {
      matchedSite: null,
      isAuthorizedSender: false,
      isAuthorizedChat: false,
    };
  }

  // 3. Kiểm tra group / chat
  // Hợp lệ nếu là chat riêng trực tiếp tới bot (chatId === senderId) hoặc trùng nhóm tuần tra của site (hoặc PATROL_GROUP_ID)
  const isDirectChat = Boolean(chatId && chatId === senderId);
  const isSiteGroup = Boolean(matchedSite.chatId && chatId === matchedSite.chatId);
  const isGlobalPatrolGroup = Boolean(getPatrolGroupId() && chatId === getPatrolGroupId());

  const isAuthorizedChat =
    isDirectChat ||
    isSiteGroup ||
    (!matchedSite.chatId && !getPatrolGroupId()) ||
    (matchedSite.siteKey === 'site_1' && isGlobalPatrolGroup);

  return {
    matchedSite,
    isAuthorizedSender: true,
    isAuthorizedChat,
  };
}

/**
 * Xử lý lệnh `tuantra` nhận từ Webhook.
 */
export async function handlePatrolCommand(
  payload: PatrolCommandPayload,
  options?: {
    zaloClient?: ZaloClient;
    database?: Database.Database;
    skipSheetFetchForTesting?: boolean;
    mockMySquadTasks?: { taskName: string; assignee: string; subTask?: string }[];
    skipTwoSiteWait?: boolean;
  }
): Promise<PatrolCommandResult> {
  const text = (payload.text || '').trim();
  const chatId = String(payload.chatId || '').trim();
  const senderId = String(payload.senderId || '').trim();
  const messageId = payload.messageId ? String(payload.messageId).trim() : undefined;

  // 1. Kiểm tra xem tin nhắn có phải lệnh tuantra không
  if (!/(?:^|\s|\/)tuantra(?:\s*[+:]|\s+|$)/i.test(text)) {
    return { handled: false, success: false };
  }

  console.log(`[Patrol] Nhận lệnh "${text}" từ sender_id: ${senderId} trong chat_id: ${chatId}`);

  const zalo = options?.zaloClient || new ZaloClient();
  const platoonLeaderId = getPlatoonLeaderChatId(options?.database);

  // 2. Xác định Site và kiểm tra quyền gửi lệnh
  const { matchedSite, isAuthorizedSender, isAuthorizedChat } = resolveSiteForCommand(
    senderId,
    chatId,
    options?.database
  );

  if (!isAuthorizedSender || !matchedSite) {
    console.warn(`[Patrol] BỎ QUA: Người gửi "${senderId}" không được ủy quyền cho bất kỳ site nào.`);
    return {
      handled: true,
      success: false,
      ignoredReason: 'unauthorized_sender',
      error: 'Sender is not an authorized patrol leader',
    };
  }

  if (!isAuthorizedChat) {
    console.warn(`[Patrol] BỎ QUA: Chat/Nhóm "${chatId}" không hợp lệ đối với ${matchedSite.siteKey}.`);
    return {
      handled: true,
      success: false,
      ignoredReason: 'unauthorized_group',
      error: 'Command received from an unauthorized chat or group',
    };
  }

  const isDirectChat = Boolean(chatId && chatId === senderId);

  // 3. Xác định ngày hôm nay theo múi giờ Việt Nam (Asia/Ho_Chi_Minh)
  const vnTime = getVietnamTimeParts(new Date());
  const todayDmy = vnTime.dateDMY; // DD/MM/YYYY

  const reporterIds = getSiteReporterIds(matchedSite);
  const twoReporters = matchedSite.siteKey === 'site_1' && reporterIds.length >= 2;

  // 4. Kiểm tra Idempotency cho messageId (tránh webhook retry)
  const currentDailyStatus = getPatrolDailyStatus(todayDmy, matchedSite.siteKey, options?.database);
  if (messageId) {
    const duplicateSource = twoReporters
      ? getPatrolReporterStatus(todayDmy, matchedSite.siteKey, senderId, options?.database)
      : currentDailyStatus;
    if (duplicateSource?.messageId === messageId && duplicateSource.submitted) {
      console.log(`[Patrol] Bỏ qua messageId trùng lặp đã xử lý trước đó: ${messageId}`);
      return {
        handled: true,
        success: true,
        siteKey: matchedSite.siteKey,
        ignoredReason: 'duplicate_message',
        members: duplicateSource.selectedMembers,
        shifts: duplicateSource.shifts,
        summarySent: false,
      };
    }
  }

  // 5. Phân tích lệnh tuantra
  // Áp dụng danh sách quân số Ban CHQS phường để chuẩn hóa tên cho cả 2 trụ sở
  const roster = getPatrolMembers(options?.database);
  const parseResult = parsePatrolCommand(text, roster, {
    allowMoreThanTwo: !matchedSite.mergeWithSheet,
  });

  if (!parseResult.isValid) {
    console.warn(`[Patrol] Cú pháp không hợp lệ: ${parseResult.error}`);

    try {
      const errorMsg = `⚠️ ${parseResult.error}`;
      await zalo.sendMessage(chatId, errorMsg);
    } catch (err: any) {
      console.error(`[Patrol] Không thể gửi phản hồi lỗi cú pháp:`, err.message);
    }

    return {
      handled: true,
      success: false,
      siteKey: matchedSite.siteKey,
      error: parseResult.error,
    };
  }

  // 6. Trụ sở 1 do hai người gửi: lưu từng người, chờ đủ rồi mới ghép và đối chiếu Sheet.
  let reportIsNoPatrol = Boolean(parseResult.isNoPatrol);
  let reportIsMultiShift = Boolean(parseResult.isMultiShift);
  let reportMembers = parseResult.members;
  let reportShifts = parseResult.shifts || [];
  let storedRawMessage = text;

  if (twoReporters) {
    savePatrolReporterSubmission(
      {
        date: todayDmy,
        siteKey: matchedSite.siteKey,
        reporterUserId: senderId,
        groupId: chatId,
        senderId,
        selectedMembers: parseResult.members,
        shifts: parseResult.shifts || [],
        hasPatrol: !parseResult.isNoPatrol,
        isMultiShift: Boolean(parseResult.isMultiShift),
        rawMessage: text,
        messageId,
        receivedAt: new Date().toISOString(),
      },
      options?.database
    );

    const reporterRows = reporterIds.map((id) =>
      getPatrolReporterStatus(todayDmy, matchedSite.siteKey, id, options?.database)
    );
    const pendingIds = reporterIds.filter((_, idx) => !reporterRows[idx]?.submitted);

    if (pendingIds.length > 0) {
      console.log(
        `[Patrol] ${matchedSite.displayName} đã nhận lịch của ${senderId}. Còn chờ ${pendingIds.length} người báo cáo nữa.`
      );
      if (isDirectChat) {
        try {
          const ownLines = parseResult.isNoPatrol
            ? `(Hôm nay không có ca tuần tra)`
            : parseResult.members.map((m) => `• ${m}`).join('\n');
          const confirmMsg =
            `✅ Đã nhận phần lịch của bạn cho ${matchedSite.displayName} ngày ${todayDmy}:\n` +
            `${ownLines}\n\n` +
            `⏳ Đang chờ người báo cáo còn lại của ${matchedSite.displayName}. ` +
            `Khi đủ 2 người, hệ thống sẽ ghép lịch và gửi tổng hợp cho Trung đội trưởng.`;
          await zalo.sendMessage(chatId, confirmMsg);
        } catch (confirmErr: unknown) {
          const messageText = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
          console.error('[Patrol] Lỗi gửi xác nhận chờ người còn lại:', messageText);
        }
      }
      return {
        handled: true,
        success: true,
        siteKey: matchedSite.siteKey,
        members: parseResult.members,
        shifts: parseResult.shifts,
        isNoPatrol: parseResult.isNoPatrol,
        waitingForOtherReporter: true,
        waitingForOtherSite: false,
        summarySent: false,
      };
    }

    const combined = combineHeadquartersReports(reporterRows.map((row) => reporterPiece(row!)));
    if (!combined.ok) {
      releaseReporterMessageId(todayDmy, matchedSite.siteKey, senderId, options?.database);
      console.warn(`[Patrol] Không ghép được lịch Trụ sở 1: ${combined.error}`);
      const warnMsg =
        `⚠️ CẢNH BÁO LỆCH LỊCH TUẦN TRA (${todayDmy}):\n` +
        `Tại ${matchedSite.displayName}, hai người báo cáo không khớp nhau.\n` +
        `${combined.error}\n` +
        `Hệ thống tạm dừng tự động gửi báo cáo tổng hợp.`;
      await warnPatrolAdmin(zalo, warnMsg);
      try {
        await zalo.sendMessage(chatId, `⚠️ ${combined.error}`);
      } catch (sendErr: unknown) {
        const messageText = sendErr instanceof Error ? sendErr.message : String(sendErr);
        console.error('[Patrol] Lỗi gửi cảnh báo lệch lịch cho người báo cáo:', messageText);
      }
      return {
        handled: true,
        success: false,
        siteKey: matchedSite.siteKey,
        error: combined.error,
      };
    }

    reportIsNoPatrol = !combined.hasPatrol;
    reportIsMultiShift = combined.isMultiShift;
    reportMembers = combined.members;
    reportShifts = combined.shifts;
    storedRawMessage = reporterIds
      .map((id) => getPatrolReporterStatus(todayDmy, matchedSite.siteKey, id, options?.database)?.rawMessage || '')
      .filter(Boolean)
      .join('\n---\n');
  }

  const merged = await resolveMergedShifts(
    matchedSite,
    todayDmy,
    {
      isNoPatrol: reportIsNoPatrol,
      isMultiShift: reportIsMultiShift,
      members: reportMembers,
      shifts: reportShifts,
    },
    options,
    zalo
  );
  if (!merged.ok) {
    if (twoReporters) {
      releaseReporterMessageId(todayDmy, matchedSite.siteKey, senderId, options?.database);
    }
    return {
      handled: true,
      success: false,
      siteKey: matchedSite.siteKey,
      error: merged.error,
    };
  }

  const mergedShifts = merged.shifts;
  const mergedMembers = merged.members;
  const effectiveNoPatrol = reportIsNoPatrol;

  // 7. Kiểm tra xem lịch của site có thay đổi so với lần nộp trước không
  const isScheduleChanged =
    !currentDailyStatus?.submitted ||
    currentDailyStatus?.hasPatrol !== !effectiveNoPatrol ||
    !areArraysEqual(currentDailyStatus.selectedMembers, mergedMembers);

  // 8. Lưu trạng thái nộp vào SQLite
  savePatrolSubmission(
    {
      date: todayDmy,
      siteKey: matchedSite.siteKey,
      groupId: chatId,
      senderId: senderId,
      leaderUserId: matchedSite.leaderUserId || senderId,
      selectedMembers: mergedMembers,
      shifts: mergedShifts,
      hasPatrol: !effectiveNoPatrol,
      rawMessage: storedRawMessage,
      messageId: messageId,
      receivedAt: new Date().toISOString(),
    },
    options?.database
  );

  console.log(
    `[Patrol] Đã lưu trạng thái nộp lịch của ${matchedSite.displayName} ngày ${todayDmy} vào SQLite.`
  );

  // 9. Kiểm tra điều kiện tổng hợp & gửi (Mục 5: Đợi cả 2 site cùng nộp)
  const allConfiguredSites = getPatrolSiteConfigs(options?.database).filter((s) => s.enabled);
  const allDailyStatuses = getAllPatrolDailyStatusForDate(todayDmy, options?.database);

  const allSubmitted =
    options?.skipTwoSiteWait ||
    allConfiguredSites.every((site) =>
      allDailyStatuses.some((st) => st.siteKey === site.siteKey && st.submitted)
    );

  let summarySent = false;

  if (!allSubmitted) {
    // Chưa đủ 2 site -> tiếp tục chờ
    const pendingSites = allConfiguredSites.filter(
      (site) => !allDailyStatuses.some((st) => st.siteKey === site.siteKey && st.submitted)
    );
    const pendingNames = pendingSites.map((s) => s.displayName).join(', ');

    console.log(
      `[Patrol] ${matchedSite.displayName} đã nộp. Hệ thống đang chờ các site còn lại: ${pendingNames}`
    );

    if (isDirectChat) {
      try {
        const confirmMsg =
          `✅ Đã nhận lịch tuần tra ${matchedSite.displayName} ngày ${todayDmy}:\n` +
          (effectiveNoPatrol
            ? `(Hôm nay không có ca tuần tra)`
            : mergedMembers.map((m) => `• ${m}`).join('\n')) +
          `\n\n` +
          `⏳ Đang chờ ${pendingNames} nộp lịch để tổng hợp và gửi báo cáo cho Trung đội trưởng.`;
        await zalo.sendMessage(chatId, confirmMsg);
      } catch (confirmErr: any) {
        console.error('[Patrol] Lỗi gửi xác nhận chờ cho người nộp:', confirmErr.message);
      }
    }

    return {
      handled: true,
      success: true,
      siteKey: matchedSite.siteKey,
      members: mergedMembers,
      shifts: mergedShifts,
      isNoPatrol: effectiveNoPatrol,
      waitingForOtherSite: true,
      summarySent: false,
    };
  }

  // ĐÃ ĐỦ CẢ 2 SITE -> Xây dựng và gửi báo cáo tổng hợp
  const summaryStatus = getPatrolSummaryStatus(todayDmy, options?.database);
  const shouldSendSummary = !summaryStatus?.summarySent || isScheduleChanged;

  if (shouldSendSummary) {
    const sitesData: SitePatrolDisplayData[] = allConfiguredSites.map((site) => {
      const st = allDailyStatuses.find((x) => x.siteKey === site.siteKey);
      return {
        siteKey: site.siteKey,
        displayName: site.displayName,
        hasPatrol: st ? st.hasPatrol : true,
        isMultiShift: Boolean(st && st.shifts && st.shifts.length > 1),
        shifts: st?.shifts || [],
      };
    });

    const combinedMessage = formatTwoSitesPatrolMessage(todayDmy, sitesData);

    if (platoonLeaderId) {
      console.log(`[Patrol] Đang gửi lịch tổng hợp 2 site tới Trung đội trưởng (${platoonLeaderId})...`);
      try {
        // Quản lý tin nhắn cũ (F4): xóa tin nhắn cũ trước đó nếu có
        const oldSummaryMessageId = summaryStatus?.messageId;
        if (oldSummaryMessageId) {
          try {
            await zalo.deleteMessage(platoonLeaderId, oldSummaryMessageId);
            console.log(`[Patrol] Đã xóa tin nhắn tổng hợp cũ: ${oldSummaryMessageId}`);
          } catch (delErr: any) {
            console.warn('[Patrol] Không thể xóa tin nhắn cũ (tiếp tục gửi mới):', delErr.message);
          }
        }

        const sentRes = await zalo.sendMessage(platoonLeaderId, combinedMessage);
        summarySent = true;
        console.log(`[Patrol] Đã gửi thành công lịch tổng hợp tới Trung đội trưởng.`);

        savePatrolSummaryStatus(
          {
            date: todayDmy,
            summarySent: true,
            sentAt: new Date().toISOString(),
            messageId: sentRes?.messageId || null,
            lastContent: combinedMessage,
          },
          options?.database
        );
      } catch (sendErr: any) {
        console.error(`[Patrol] Lỗi gửi tới Trung đội trưởng:`, sendErr.message);
        return {
          handled: true,
          success: false,
          siteKey: matchedSite.siteKey,
          error: `Gửi lịch tới Trung đội trưởng thất bại: ${sendErr.message}`,
        };
      }
    } else {
      console.warn(`[Patrol] CẢNH BÁO: Chưa cấu hình Chat ID của Trung đội trưởng (PLATOON_LEADER_CHAT_ID).`);
    }
  } else {
    console.log(`[Patrol] Lịch không thay đổi so với bản đã gửi, bỏ qua gửi lại cho Trung đội trưởng.`);
  }

  // Gửi xác nhận phản hồi cho người nộp qua chat riêng
  if (isDirectChat) {
    try {
      const confirmMsg =
        `✅ Đã nhận lịch tuần tra ${matchedSite.displayName} ngày ${todayDmy}:\n` +
        (effectiveNoPatrol
          ? `(Hôm nay không có ca tuần tra)`
          : mergedMembers.map((m) => `• ${m}`).join('\n')) +
        `\n\n` +
        (summarySent
          ? `📋 Đã tổng hợp lịch tuần tra các địa bàn và gửi báo cáo cho Trung đội trưởng.`
          : `(Báo cáo tổng hợp hôm nay đã được gửi trước đó).`);
      await zalo.sendMessage(chatId, confirmMsg);
    } catch (confirmErr: any) {
      console.error('[Patrol] Lỗi gửi xác nhận cho người nộp:', confirmErr.message);
    }
  }

  return {
    handled: true,
    success: true,
    siteKey: matchedSite.siteKey,
    members: mergedMembers,
    shifts: mergedShifts,
    isNoPatrol: effectiveNoPatrol,
    waitingForOtherSite: false,
    summarySent,
  };
}
