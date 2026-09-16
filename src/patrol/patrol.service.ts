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
  getPatrolSiteConfig,
  getPatrolSummaryStatus,
  savePatrolSummaryStatus,
} from './patrol.repository';
import { parsePatrolCommand } from './patrol.parser';
import {
  PatrolCommandPayload,
  PatrolCommandResult,
  PatrolShift,
  PatrolSiteConfig,
} from './patrol.types';
import { getRecipientChatId, getConfig } from '../config';

export interface SitePatrolDisplayData {
  siteKey: string;
  displayName: string;
  hasPatrol: boolean;
  isMultiShift?: boolean;
  shifts: PatrolShift[];
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
 */
export function getPlatoonLeaderChatId(): string {
  const envId = (process.env.PLATOON_LEADER_CHAT_ID || '').trim();

  if (envId) return envId;

  // Tra cứu từ recipients trong config
  try {
    return getRecipientChatId('platoon_leader') || '';
  } catch (_) {
    return '';
  }
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
  let effectiveTabName = '';
  let headerStyle: 'two_row_merged' | 'single_row' = 'two_row_merged';

  try {
    const effective = getEffectiveScheduleConfig('patrol_summary');
    effectiveTabName = effective.effectiveTabName;
    headerStyle = effective.squad?.header_style || 'two_row_merged';
  } catch (_) {
    try {
      const effective = getEffectiveScheduleConfig('main_duty');
      effectiveTabName = effective.effectiveTabName;
      headerStyle = effective.squad?.header_style || 'two_row_merged';
    } catch (e: any) {
      throw new Error(`Không thể xác định cấu hình tab Tiểu đội 2: ${e.message}`);
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

  // 1. Tìm site mà senderId trùng khớp với leaderUserId
  let matchedSite = configs.find((s) => s.leaderUserId && s.leaderUserId === senderId) || null;

  // Fallback: nếu chưa cấu hình trong DB, kiểm tra env vars cho site_1
  if (!matchedSite) {
    const s1Leader = getSquad1LeaderUserId();
    const s2Leader = (process.env.SITE_2_LEADER_USER_ID || '').trim();

    if (s1Leader && senderId === s1Leader) {
      matchedSite = configs.find((s) => s.siteKey === 'site_1') || {
        siteKey: 'site_1',
        displayName: 'Trụ sở 1 (Tân Phước Khánh)',
        leaderUserId: s1Leader,
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
  if (!/(?:^|\s|\/)tuantra(?:\s*[\+:]|\s+|$)/i.test(text)) {
    return { handled: false, success: false };
  }

  console.log(`[Patrol] Nhận lệnh "${text}" từ sender_id: ${senderId} trong chat_id: ${chatId}`);

  const zalo = options?.zaloClient || new ZaloClient();
  const platoonLeaderId = getPlatoonLeaderChatId();

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

  // 4. Kiểm tra Idempotency cho messageId (tránh webhook retry)
  const currentDailyStatus = getPatrolDailyStatus(todayDmy, matchedSite.siteKey, options?.database);
  if (messageId && currentDailyStatus?.messageId === messageId) {
    console.log(`[Patrol] Bỏ qua messageId trùng lặp đã xử lý trước đó: ${messageId}`);
    return {
      handled: true,
      success: true,
      siteKey: matchedSite.siteKey,
      ignoredReason: 'duplicate_message',
      members: currentDailyStatus.selectedMembers,
      shifts: currentDailyStatus.shifts,
      summarySent: false,
    };
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

  // 6. Xử lý logic ghép Sheet (áp dụng cho Site 1 / merge_with_sheet)
  let mergedShifts: PatrolShift[] = [];
  let mergedMembers: string[] = [];

  if (matchedSite.mergeWithSheet) {
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
      } catch (sheetErr: any) {
        console.error('[Patrol] PATROL SUMMARY FAILED');
        console.error('Reason: Cannot resolve current team\'s patrol schedule:', sheetErr.message);
        return {
          handled: true,
          success: false,
          siteKey: matchedSite.siteKey,
          error: `Không thể đọc lịch đi tuần của tiểu đội từ Google Sheet: ${sheetErr.message}`,
        };
      }
    }

    const sheetShifts = groupPatrolTasksIntoShifts(mySquadTasks);
    const sheetShiftCount = sheetShifts.length;

    const reportedShiftCount = parseResult.isNoPatrol
      ? 0
      : parseResult.isMultiShift
      ? parseResult.shifts?.length || 0
      : 1;

    // Mục 4: Kiểm tra số ca khớp giữa người báo cáo và Sheet
    if (reportedShiftCount !== sheetShiftCount) {
      console.warn(
        `[Patrol] LỆCH SỐ CA: Người báo cáo có ${reportedShiftCount} ca, Sheet có ${sheetShiftCount} ca`
      );

      // Gửi cảnh báo riêng cho Admin qua kênh nhắc nhở
      try {
        const config = getConfig();
        const adminChatId = getRecipientChatId('admin', config);
        if (adminChatId) {
          const warnMsg =
            `⚠️ CẢNH BÁO LỆCH SỐ CA TUẦN TRA (${todayDmy}):\n` +
            `Tại ${matchedSite.displayName}, Google Sheet có ${sheetShiftCount} ca nhưng người báo cáo gửi ${reportedShiftCount} ca.\n` +
            `Hệ thống tạm dừng tự động gửi báo cáo tổng hợp. Vui lòng kiểm tra lại Google Sheet hoặc nhắc người báo cáo điều chỉnh.`;
          await zalo.sendMessage(adminChatId, warnMsg);
          console.log(`[Patrol] Đã gửi cảnh báo lệch ca tới Admin (${adminChatId}).`);
        }
      } catch (adminErr: any) {
        console.error('[Patrol] Lỗi gửi cảnh báo tới Admin:', adminErr.message);
      }

      return {
        handled: true,
        success: false,
        siteKey: matchedSite.siteKey,
        error: `Lệch số ca tuần tra: Google Sheet có ${sheetShiftCount} ca nhưng người báo cáo gửi ${reportedShiftCount} ca (Shift count mismatch)`,
      };
    }

    // Ghép theo thứ tự vị trí (left -> right)
    if (parseResult.isNoPatrol) {
      mergedShifts = [];
      mergedMembers = [];
    } else if (parseResult.isMultiShift && parseResult.shifts) {
      mergedShifts = parseResult.shifts.map((shift, idx) => {
        const sheetShiftMembers = sheetShifts[idx]?.members || [];
        const members = [...shift.members, ...sheetShiftMembers];
        return {
          shiftNumber: shift.shiftNumber,
          shiftLabel: shift.shiftLabel || `Ca ${shift.shiftNumber}`,
          members,
        };
      });
      mergedMembers = mergedShifts.flatMap((s) => s.members);
    } else {
      // Đơn ca: ghép toàn bộ thành viên của Sheet Ca 1 (bao gồm cả Người 1 và Người 2 nếu có)
      const sheetShiftMembers = sheetShifts[0]?.members || [];
      mergedMembers = [...parseResult.members, ...sheetShiftMembers];
      mergedShifts = [
        {
          shiftNumber: 1,
          shiftLabel: 'Ca 1',
          members: mergedMembers,
        },
      ];
    }
  } else {
    // Site 2 / không ghép sheet
    if (parseResult.isNoPatrol) {
      mergedShifts = [];
      mergedMembers = [];
    } else {
      mergedShifts = parseResult.shifts || [];
      mergedMembers = parseResult.members;
    }
  }

  // 7. Kiểm tra xem lịch của site có thay đổi so với lần nộp trước không
  const isScheduleChanged =
    !currentDailyStatus?.submitted ||
    currentDailyStatus?.hasPatrol !== !parseResult.isNoPatrol ||
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
      hasPatrol: !parseResult.isNoPatrol,
      rawMessage: text,
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
          (parseResult.isNoPatrol
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
      isNoPatrol: parseResult.isNoPatrol,
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
        (parseResult.isNoPatrol
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
    isNoPatrol: parseResult.isNoPatrol,
    waitingForOtherSite: false,
    summarySent,
  };
}
