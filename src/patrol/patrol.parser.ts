/**
 * patrol.parser.ts
 *
 * Phân tích và chuẩn hóa lệnh `tuantra` từ Tiểu đội trưởng Tiểu đội 1.
 * Đáp ứng các yêu cầu Mục 5, 6, 7 và Test 1 - 4.
 */

import { ParsePatrolCommandResult, PatrolMember } from './patrol.types';

/**
 * Loại bỏ dấu tiếng Việt, chuyển chữ thường và chuẩn hóa khoảng trắng để so khớp.
 */
export function normalizeVietnamese(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phân tách chuỗi bằng các ký tự phân tách phổ biến (+, ,, ;, xuống dòng, ' và ').
 */
/**
 * Phân tách chuỗi bằng các ký tự phân tách phổ biến (+, ,, ;, xuống dòng, ' và ', ' and ').
 */
function splitByDelimiters(text: string): string[] {
  // Thay thế các phân tách ' và ', ' and ' bằng ','
  const preprocessed = text
    .replace(/\s+v[aà]o?\s+/gi, ',')
    .replace(/\s+and\s+/gi, ',');
  return preprocessed
    .split(/[+,\n;\t]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export interface ParsePatrolOptions {
  maxMembersPerShift?: number;
  allowMoreThanTwo?: boolean;
}

/**
 * Phân tích danh sách tên thành viên cho một ca tuần.
 */
function parseNamesForShift(
  content: string,
  roster: PatrolMember[] = [],
  maxMembers?: number
): ParsePatrolCommandResult {
  if (roster && roster.length > 0) {
    return parseWithRoster(content, roster, maxMembers);
  }
  return parseWithoutRoster(content, maxMembers);
}

/**
 * Phân tích lệnh `tuantra`.
 *
 * @param rawText Tin nhắn gốc nhận từ Zalo
 * @param roster Danh sách thành viên Tiểu đội 1 đã cấu hình (nếu có)
 * @param options Cấu hình giới hạn thành viên mỗi ca
 */
export function parsePatrolCommand(
  rawText: string,
  roster: PatrolMember[] = [],
  options?: ParsePatrolOptions
): ParsePatrolCommandResult {
  // Bỏ qua tag mention bot ở đầu nếu có (ví dụ: "@Bot culi của Baro tuantra ...")
  const cleanedText = (rawText || '')
    .trim()
    .replace(/^@[\w\s\u00C0-\u1EF9]+?\s+(?=tuantra)/i, '')
    .trim();

  // Kiểm tra tiền tố lệnh tuantra (không phân biệt hoa thường, cho phép /tuantra)
  const commandMatch = cleanedText.match(/^(?:\/)?tuantra(?:\s*[+:]|\s+|$)/i);
  if (!commandMatch) {
    return {
      isValid: false,
      commandFound: false,
      members: [],
      error: 'Tin nhắn không phải lệnh tuantra',
    };
  }

  // Cắt bỏ phần "tuantra" và ký tự phân cách đầu nếu có
  let rest = cleanedText.slice(commandMatch[0].length).trim();
  if (rest.startsWith('+')) {
    rest = rest.slice(1).trim();
  }

  // Trường hợp 1: Báo nghỉ tuần tra (tuantra 0 / tuantra nghi / tuantra none / khong)
  if (/^(?:0|nghi|none|khong|không)\b/i.test(rest)) {
    return {
      isValid: true,
      commandFound: true,
      isNoPatrol: true,
      isMultiShift: false,
      members: [],
      shifts: [],
    };
  }

  // Trường hợp: chỉ gõ mỗi "tuantra" không kèm tên
  if (!rest) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      error:
        'Cú pháp không hợp lệ.\nVui lòng sử dụng:\ntuantra <tên>\nhoặc:\ntuantra <tên 1> <tên 2>\nhoặc báo nghỉ:\ntuantra 0 / tuantra nghi / tuantra none',
    };
  }

  const effectiveMaxMembers = options?.allowMoreThanTwo
    ? undefined
    : options?.maxMembersPerShift !== undefined
    ? options.maxMembersPerShift
    : 2;

  // Trường hợp 2: Kiểm tra xem có cấu trúc đa ca không (Shift 1:, Ca 1:, ...)
  // Hỗ trợ cả khi xuống dòng hoặc gõ liên tiếp trên 1 dòng: Ca 1: A Ca 2: B
  const normalizedRest = rest.replace(/(?:\r?\n|\s+)(?=(?:shift|ca)\s*\d+\s*:)/gi, '\n');
  const lines = normalizedRest
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const shiftLineRegex = /^(?:shift|ca)\s*(\d+)\s*:(.*)$/i;
  const isMultiShift = lines.some((l) => shiftLineRegex.test(l));

  if (isMultiShift) {
    const shifts: { shiftNumber: number; shiftLabel: string; members: string[] }[] = [];
    const allMembers: string[] = [];

    for (const line of lines) {
      const match = line.match(shiftLineRegex);
      if (!match) continue;

      const shiftNumber = parseInt(match[1], 10);
      const shiftContent = match[2].trim();

      if (!shiftContent) {
        return {
          isValid: false,
          commandFound: true,
          members: [],
          error: `Ca ${shiftNumber} chưa có tên thành viên.`,
        };
      }

      const shiftParseResult = parseNamesForShift(
        shiftContent,
        roster,
        effectiveMaxMembers
      );

      if (!shiftParseResult.isValid) {
        return shiftParseResult;
      }

      shifts.push({
        shiftNumber,
        shiftLabel: `Ca ${shiftNumber}`,
        members: shiftParseResult.members,
      });

      for (const m of shiftParseResult.members) {
        if (!allMembers.includes(m)) {
          allMembers.push(m);
        }
      }
    }

    if (shifts.length === 0) {
      return {
        isValid: false,
        commandFound: true,
        members: [],
        error: 'Không tìm thấy thông tin ca tuần tra hợp lệ.',
      };
    }

    // Sắp xếp theo số ca tăng dần (Ca 1, Ca 2, ...)
    shifts.sort((a, b) => a.shiftNumber - b.shiftNumber);

    return {
      isValid: true,
      commandFound: true,
      isNoPatrol: false,
      isMultiShift: true,
      members: allMembers,
      shifts,
    };
  }

  // Trường hợp 3: Đơn ca (1 danh sách duy nhất)
  return parseNamesForShift(rest, roster, effectiveMaxMembers);
}

/**
 * Xử lý khi ĐÃ CÓ danh sách thành viên Tiểu đội 1 (khớp tên và chuẩn hóa tên chuẩn).
 */
function parseWithRoster(
  input: string,
  roster: PatrolMember[],
  maxMembers?: number
): ParsePatrolCommandResult {
  // Kiểm tra xem có dấu phân cách tường minh (+, ,, \n, ;, ' và ', ' and ') không
  const hasExplicitDelimiter = /[+,\n;]|\s+(?:v[aà]o?|and)\s+/i.test(input);

  if (hasExplicitDelimiter) {
    const rawChunks = splitByDelimiters(input);
    const matchedMembers: string[] = [];
    const unresolvedNames: string[] = [];

    for (const chunk of rawChunks) {
      const normalizedChunk = normalizeVietnamese(chunk);
      const found = roster.find((m) => {
        if (normalizeVietnamese(m.fullName) === normalizedChunk) return true;
        if (m.aliases && m.aliases.some((a) => normalizeVietnamese(a) === normalizedChunk)) {
          return true;
        }
        return false;
      });

      if (found) {
        if (!matchedMembers.includes(found.fullName)) {
          matchedMembers.push(found.fullName);
        }
      } else {
        unresolvedNames.push(chunk);
      }
    }

    if (unresolvedNames.length > 0) {
      return {
        isValid: false,
        commandFound: true,
        members: [],
        unresolvedNames,
        error: `Không tìm thấy thành viên: ${unresolvedNames.join(', ')}`,
      };
    }

    return validateMemberCount(matchedMembers, maxMembers);
  }

  // Nếu không có dấu phân cách tường minh (ví dụ: "tuantra Nguyen Van A Tran Van B" hoặc "tuantra A B C")
  // Thu thập tất cả các ứng viên (tên đầy đủ và biệt danh) và sắp xếp từ chuỗi DÀI NHẤT đến NGẮN NHẤT
  // để luôn ưu tiên khớp cụm tên dài, chính xác trước khi khớp biệt danh ngắn.
  const candidates: Array<{ candidate: string; member: PatrolMember }> = [];
  for (const member of roster) {
    const normName = normalizeVietnamese(member.fullName);
    candidates.push({ candidate: normName, member });
    for (const alias of member.aliases || []) {
      const normAlias = normalizeVietnamese(alias);
      if (normAlias && normAlias !== normName) {
        candidates.push({ candidate: normAlias, member });
      }
    }
  }

  candidates.sort((a, b) => b.candidate.length - a.candidate.length);

  let remainingNormalized = normalizeVietnamese(input);
  const matchedMembers: string[] = [];

  // Tìm kiếm các ứng viên trong chuỗi còn lại
  for (const { candidate, member } of candidates) {
    // Tìm vị trí với ranh giới từ để tránh khớp nhầm chuỗi con
    const regex = new RegExp(`(?:^|\\s)${escapeRegExp(candidate)}(?:\\s|$)`, 'i');
    if (regex.test(remainingNormalized)) {
      if (!matchedMembers.includes(member.fullName)) {
        matchedMembers.push(member.fullName);
      }
      // Xóa cụm từ này khỏi chuỗi còn lại theo ranh giới từ
      remainingNormalized = remainingNormalized
        .replace(new RegExp(`(?:^|\\s)${escapeRegExp(candidate)}(?=\\s|$)`, 'gi'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Nếu còn từ nào không khớp với bất kỳ ai trong roster
  if (remainingNormalized.length > 0) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      unresolvedNames: [remainingNormalized],
      error: `Không tìm thấy thành viên: ${remainingNormalized}`,
    };
  }

  return validateMemberCount(matchedMembers, maxMembers);
}

/**
 * Xử lý khi CHƯA cấu hình danh sách thành viên.
 */
function parseWithoutRoster(input: string, maxMembers?: number): ParsePatrolCommandResult {
  const chunks = splitByDelimiters(input);

  // Nếu chỉ có 1 chunk không có delimiter (+, ,, \n)
  if (chunks.length === 1) {
    const single = chunks[0].trim();
    if (!single) {
      return {
        isValid: false,
        commandFound: true,
        members: [],
        error: 'Tên thành viên không được để trống.',
      };
    }

    return {
      isValid: true,
      commandFound: true,
      isNoPatrol: false,
      isMultiShift: false,
      members: [single],
      shifts: [{ shiftNumber: 1, shiftLabel: 'Ca 1', members: [single] }],
    };
  }

  return validateMemberCount(chunks, maxMembers);
}

/**
 * Kiểm tra số lượng thành viên trong ca.
 */
function validateMemberCount(
  members: string[],
  maxMembers?: number
): ParsePatrolCommandResult {
  if (members.length === 0) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      error:
        'Cú pháp không hợp lệ.\nVui lòng sử dụng:\ntuantra <tên>\nhoặc:\ntuantra <tên 1> <tên 2>',
    };
  }

  if (maxMembers !== undefined && members.length > maxMembers) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      error:
        maxMembers === 2
          ? 'Chỉ hỗ trợ lịch đi tuần từ 1 đến 2 người.'
          : `Chỉ hỗ trợ lịch đi tuần tối đa ${maxMembers} người.`,
    };
  }

  return {
    isValid: true,
    commandFound: true,
    isNoPatrol: false,
    isMultiShift: false,
    members,
    shifts: [{ shiftNumber: 1, shiftLabel: 'Ca 1', members }],
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
