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
function splitByDelimiters(text: string): string[] {
  // Thay thế các phân tách ' và ' bằng ','
  const preprocessed = text.replace(/\s+v[aà]o?\s+/gi, ',');
  return preprocessed
    .split(/[+,\n;\t]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Phân tích lệnh `tuantra`.
 *
 * @param rawText Tin nhắn gốc nhận từ Zalo
 * @param roster Danh sách thành viên Tiểu đội 1 đã cấu hình (nếu có)
 */
export function parsePatrolCommand(
  rawText: string,
  roster: PatrolMember[] = []
): ParsePatrolCommandResult {
  // Bỏ qua tag mention bot ở đầu nếu có (ví dụ: "@Bot culi của Baro tuantra ...")
  const cleanedText = (rawText || '')
    .trim()
    .replace(/^@[\w\s\u00C0-\u1EF9]+?\s+(?=tuantra)/i, '')
    .trim();

  // Kiểm tra tiền tố lệnh tuantra (không phân biệt hoa thường, cho phép /tuantra)
  const commandMatch = cleanedText.match(/^(?:\/)?tuantra(?:\s*[\+:]|\s+|$)/i);
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

  // Trường hợp: chỉ gõ mỗi "tuantra" không kèm tên
  if (!rest) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      error:
        'Cú pháp không hợp lệ.\nVui lòng sử dụng:\ntuantra <tên>\nhoặc:\ntuantra <tên 1> <tên 2>',
    };
  }

  // Trường hợp 1: Có cấu hình danh sách thành viên Tiểu đội 1
  if (roster && roster.length > 0) {
    return parseWithRoster(rest, roster);
  }

  // Trường hợp 2: Chưa cấu hình danh sách thành viên -> phân tách theo delimiter (+, ,, \n)
  return parseWithoutRoster(rest);
}

/**
 * Xử lý khi ĐÃ CÓ danh sách thành viên Tiểu đội 1 (khớp tên và chuẩn hóa tên chuẩn).
 */
function parseWithRoster(
  input: string,
  roster: PatrolMember[]
): ParsePatrolCommandResult {
  // Kiểm tra xem có dấu phân cách tường minh (+, ,, \n) không
  const hasExplicitDelimiter = /[+,\n;]/.test(input);

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
        error: `Unable to find member: ${unresolvedNames.join(', ')}`,
      };
    }

    return validateMemberCount(matchedMembers);
  }

  // Nếu không có dấu phân cách tường minh (ví dụ: "tuantra Nguyen Van A Tran Van B" hoặc "tuantra A B C")
  // So khớp dựa trên danh sách thành viên từ dài nhất đến ngắn nhất
  const sortedRoster = [...roster].sort(
    (a, b) => normalizeVietnamese(b.fullName).length - normalizeVietnamese(a.fullName).length
  );

  let remainingNormalized = normalizeVietnamese(input);
  const matchedMembers: string[] = [];

  // Tìm kiếm các thành viên trong chuỗi
  for (const member of sortedRoster) {
    const normName = normalizeVietnamese(member.fullName);
    const aliases = (member.aliases || []).map((a) => normalizeVietnamese(a));
    const allCandidates = [normName, ...aliases];

    for (const cand of allCandidates) {
      // Tìm vị trí với ranh giới từ để tránh khớp nhầm chuỗi con
      const regex = new RegExp(`(?:^|\\s)${escapeRegExp(cand)}(?:\\s|$)`, 'i');
      if (regex.test(remainingNormalized)) {
        if (!matchedMembers.includes(member.fullName)) {
          matchedMembers.push(member.fullName);
        }
        // Xóa tên này khỏi chuỗi còn lại để tránh khớp đè
        remainingNormalized = remainingNormalized
          .replace(new RegExp(escapeRegExp(cand), 'g'), ' ')
          .replace(/\s+/g, ' ')
          .trim();
        break;
      }
    }
  }

  // Nếu còn từ nào không khớp với bất kỳ ai trong roster
  if (remainingNormalized.length > 0) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      unresolvedNames: [remainingNormalized],
      error: `Unable to find member: ${remainingNormalized}`,
    };
  }

  return validateMemberCount(matchedMembers);
}

/**
 * Xử lý khi CHƯA cấu hình danh sách thành viên.
 */
function parseWithoutRoster(input: string): ParsePatrolCommandResult {
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
      members: [single],
    };
  }

  return validateMemberCount(chunks);
}

/**
 * Kiểm tra số lượng thành viên (chỉ cho phép 1 hoặc 2 người).
 */
function validateMemberCount(members: string[]): ParsePatrolCommandResult {
  if (members.length === 0) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      error:
        'Cú pháp không hợp lệ.\nVui lòng sử dụng:\ntuantra <tên>\nhoặc:\ntuantra <tên 1> <tên 2>',
    };
  }

  if (members.length > 2) {
    return {
      isValid: false,
      commandFound: true,
      members: [],
      error: 'Chỉ hỗ trợ lịch đi tuần từ 1 đến 2 người.',
    };
  }

  return {
    isValid: true,
    commandFound: true,
    members,
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
