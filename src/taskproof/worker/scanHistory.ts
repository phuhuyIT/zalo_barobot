/**
 * scanHistory.ts
 *
 * Lọc ảnh trong N tin /quet rồi ingest chỉ đúng task được gọi.
 * Không gọi zca-js — runtime fetch history, hàm này chỉ lọc rồi đối chiếu ảnh.
 */

import Database from 'better-sqlite3';
import { looksLikeTaskproofCommand } from '../commands/parser';
import { getTaskproofExcludeUids } from '../records/settings';
import {
  HISTORY_API_MAX_COUNT,
  historyFetchCount,
  ScanHistorySummary,
} from '../quet';
import { ingestProofImage, ProofImage, ProofIngestDeps, ProofIngestResult } from './proofIngest';
import { ZcaInboundMessage } from './zcaAdapter';

export interface ScanHistoryInput {
  taskId: string;
  shortCode: string;
  zcaGroupId: string;
  count: number;
  messages: ZcaInboundMessage[];
  more?: number;
}

/**
 * getrecentv2 và websocket history thường trả một trang lớn hơn count
 * (hay gặp ~20) và không cắt theo số tin /quet yêu cầu. Giữ đúng N tin mới nhất.
 * Tin không có ts xếp sau các tin có ts; cùng ts thì giữ thứ tự API (mới trước).
 */
export function takeRecentMessages(
  messages: ZcaInboundMessage[],
  count: number
): ZcaInboundMessage[] {
  const limit = historyFetchCount(count);
  if (messages.length <= limit) return messages;
  const ranked = messages.map((message, index) => ({
    message,
    index,
    ts: message.ts || 0,
  }));
  ranked.sort((a, b) => b.ts - a.ts || a.index - b.index);
  const newest = ranked.slice(0, limit);
  newest.sort((a, b) => a.ts - b.ts || a.index - b.index);
  return newest.map((row) => row.message);
}

export function selectLookbackImages(
  messages: ZcaInboundMessage[],
  excludeUids?: Set<string>
): ZcaInboundMessage[] {
  return messages
    .filter((msg) => {
      if (!msg.hasImage || msg.isLinkCard) return false;
      const uid = (msg.uidFrom || '').trim();
      if (!msg.msgId || !uid || uid === '0') return false;
      if (excludeUids?.has(uid)) return false;
      if (looksLikeTaskproofCommand(msg.text || '')) return false;
      return true;
    })
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export function historyWasTruncated(
  messages: ZcaInboundMessage[],
  fetchCount: number,
  more = 0
): boolean {
  if (fetchCount < HISTORY_API_MAX_COUNT) return false;
  if (more > 0) return true;
  return messages.length >= HISTORY_API_MAX_COUNT;
}

export interface ScanHistoryDeps extends ProofIngestDeps {
  /** Worker xếp ảnh /quet vào cùng hàng đợi với ảnh đang listen. */
  runIngest?: (image: ProofImage) => Promise<ProofIngestResult>;
}

export async function scanGroupHistoryForTask(
  db: Database.Database,
  input: ScanHistoryInput,
  deps: ScanHistoryDeps = {}
): Promise<ScanHistorySummary> {
  const fetchCount = historyFetchCount(input.count);
  const excludeUids = deps.excludeUids ?? getTaskproofExcludeUids(db);
  const images = selectLookbackImages(takeRecentMessages(input.messages, fetchCount), excludeUids);
  const truncated = historyWasTruncated(input.messages, fetchCount, input.more || 0);

  const summary: ScanHistorySummary = {
    shortCode: input.shortCode,
    count: fetchCount,
    scanned: images.length,
    recorded: 0,
    skipped: 0,
    discarded: 0,
    closed: false,
    truncated,
  };

  for (const msg of images) {
    const image: ProofImage = {
      threadId: msg.threadId || input.zcaGroupId,
      msgId: msg.msgId || '',
      uidFrom: msg.uidFrom || '',
      displayName: msg.displayName,
      href: msg.href,
      thumb: msg.thumb,
    };
    let result: ProofIngestResult;
    try {
      result = deps.runIngest
        ? await deps.runIngest(image)
        : await ingestProofImage(db, image, deps, {
            onlyTaskId: input.taskId,
            ignoreProcessed: true,
            skipIfAlreadySubmitted: true,
          });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      console.error('[TaskProofWorker] /quet ingest lỗi:', text);
      summary.discarded += 1;
      continue;
    }
    if (result.outcome === 'recorded') {
      summary.recorded += 1;
      console.log(
        `[TaskProofWorker] /quet ghi nhận thành công từ uid=${image.uidFrom} (tên: "${image.displayName || image.uidFrom}") cho task ${input.shortCode}`
      );
      if (result.closed) summary.closed = true;
    } else if (result.outcome === 'skipped') {
      summary.skipped += 1;
      console.log(
        `[TaskProofWorker] /quet bỏ qua ảnh msg=${image.msgId} từ uid=${image.uidFrom}: lý do ${result.reason}`
      );
    } else {
      summary.discarded += 1;
      console.log(
        `[TaskProofWorker] /quet loại bỏ ảnh msg=${image.msgId} từ uid=${image.uidFrom}: lý do ${result.reason}`
      );
    }
  }

  return summary;
}
