/**
 * unfurlQueue.ts
 *
 * Hàng đợi nội bộ trên process bot chính. Concurrency 1–2.
 * Không đưa fetch Facebook sang worker zca-js.
 */

const MAX_CONCURRENCY = 2;

const pending: Array<() => Promise<void>> = [];
let active = 0;

function pump(): void {
  while (active < MAX_CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    if (!job) return;
    active += 1;
    Promise.resolve()
      .then(job)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[TaskProof] unfurl job lỗi:', msg);
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/** Đẩy job và trả về ngay — không chờ Facebook GET. */
export function enqueueUnfurl(job: () => Promise<void>): void {
  pending.push(job);
  pump();
}

export function resetUnfurlQueueForTests(): void {
  pending.length = 0;
  active = 0;
}
