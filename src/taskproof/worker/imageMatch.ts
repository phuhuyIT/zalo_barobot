/**
 * imageMatch.ts
 *
 * Chấm ảnh nộp với ảnh mẫu của task bằng SIFT + RANSAC + lưới xám
 * (baseline trong demo/match-pipeline). Chỉ PASS mới được ghi minh chứng.
 * Task không có file ảnh mẫu thì không tham gia.
 *
 * Một process Python (`score_cli.py --serve`) sống cùng worker. Ảnh mẫu và
 * ảnh nộp đều được cắt về phần bài viết trước SIFT. Ảnh mẫu đã prep được
 * cache trong process đó. Mọi lần chấm xếp hàng, kể cả khi hai task mở.
 * Hết 60s thì SIGKILL và đợi process thoát trước lần chấm sau.
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const IMAGE_PASS_DECISION = 'PASS';

export interface ImageScore {
  score: number;
  decision: 'PASS' | 'REVIEW' | 'FAIL';
}

export interface ImageMatchCandidate {
  id: string;
  createdAt: number;
  referencePath: string;
}

export interface BestImageMatch {
  candidate: ImageMatchCandidate;
  result: ImageScore;
}

export type ScoreImagePair = (referencePath: string, query: Buffer) => Promise<ImageScore>;

function scriptPath(): string {
  if (process.env.IMAGE_MATCH_SCRIPT) return process.env.IMAGE_MATCH_SCRIPT;
  return path.resolve(process.cwd(), 'demo/match-pipeline/score_cli.py');
}

function pythonBin(): string {
  return process.env.IMAGE_MATCH_PYTHON || 'python3';
}

function matchTimeoutMs(): number {
  const n = Number(process.env.IMAGE_MATCH_TIMEOUT_MS || 60_000);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

interface LineWaiter {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
}

class ImageMatcher {
  private child: ChildProcess | null = null;
  private spawnedKey = '';
  private chain: Promise<void> = Promise.resolve();
  private stdoutChunks: Buffer[] = [];
  private pending: LineWaiter | null = null;
  private killing: Promise<void> | null = null;

  score(referencePath: string, query: Buffer): Promise<ImageScore> {
    const run = this.chain.then(() => this.scoreOnce(referencePath, query));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async stop(): Promise<void> {
    await this.killChild();
  }

  private async scoreOnce(referencePath: string, query: Buffer): Promise<ImageScore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-match-'));
    const queryPath = path.join(dir, 'query.bin');
    fs.writeFileSync(queryPath, query);
    try {
      const child = await this.ensureChild();
      const line = await this.requestLine(
        child,
        `${JSON.stringify({ reference: referencePath, query: queryPath })}\n`
      );
      let parsed: { score?: unknown; decision?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(line) as { score?: unknown; decision?: unknown; error?: unknown };
      } catch (err) {
        await this.killChild();
        throw err;
      }
      if (typeof parsed.error === 'string' && parsed.error) {
        throw new Error(parsed.error);
      }
      if (typeof parsed.score !== 'number' || typeof parsed.decision !== 'string' || !parsed.decision) {
        await this.killChild();
        throw new Error('image match returned an invalid score');
      }
      return { score: parsed.score, decision: parsed.decision as ImageScore['decision'] };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async ensureChild(): Promise<ChildProcess> {
    const key = `${pythonBin()}\0${scriptPath()}`;
    if (this.child && this.spawnedKey === key && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    await this.killChild();
    const child = spawn(pythonBin(), [scriptPath(), '--serve'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;
    this.spawnedKey = key;
    this.stdoutChunks = [];
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      this.failPending(err);
    });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      this.stdoutChunks = [];
      this.failPending(new Error('image match process exited'));
    });
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutChunks.push(chunk);
    const all = Buffer.concat(this.stdoutChunks);
    const nl = all.indexOf(0x0a);
    if (nl < 0) {
      this.stdoutChunks = [all];
      return;
    }
    const line = all.subarray(0, nl).toString('utf8');
    const rest = all.subarray(nl + 1);
    this.stdoutChunks = rest.length ? [Buffer.from(rest)] : [];
    const waiter = this.pending;
    this.pending = null;
    waiter?.resolve(line);
  }

  private failPending(err: Error): void {
    const waiter = this.pending;
    this.pending = null;
    waiter?.reject(err);
  }

  private requestLine(child: ChildProcess, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void this.killChild().finally(() => reject(new Error('image match timed out')));
      }, matchTimeoutMs());
      this.pending = {
        resolve: (line) => finish(() => resolve(line)),
        reject: (err) => finish(() => reject(err)),
      };
      child.stdin?.write(payload, (err) => {
        if (err) finish(() => reject(err));
      });
    });
  }

  private killChild(): Promise<void> {
    if (this.killing) return this.killing;
    const child = this.child;
    this.child = null;
    this.spawnedKey = '';
    this.stdoutChunks = [];
    this.failPending(new Error('image match stopped'));
    if (!child || child.exitCode !== null) return Promise.resolve();
    this.killing = new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 1_000);
      child.once('exit', () => {
        clearTimeout(timer);
        this.killing = null;
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        this.killing = null;
        resolve();
      }
    });
    return this.killing;
  }
}

const matcher = new ImageMatcher();

export function scoreImagePair(referencePath: string, query: Buffer): Promise<ImageScore> {
  return matcher.score(referencePath, query);
}

/** Đóng process chấm ảnh. Gọi khi worker tắt. */
export function stopImageMatcher(): Promise<void> {
  return matcher.stop();
}

/** PASS với điểm cao nhất. Hòa điểm giữ task tạo sớm hơn. */
export async function pickBestImageMatch(
  query: Buffer,
  candidates: ImageMatchCandidate[],
  scorePair: ScoreImagePair = scoreImagePair
): Promise<BestImageMatch | null> {
  const ordered = [...candidates].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
  let best: BestImageMatch | null = null;
  for (const candidate of ordered) {
    const result = await scorePair(candidate.referencePath, query);
    if (result.decision !== IMAGE_PASS_DECISION) continue;
    if (!best || result.score > best.result.score) {
      best = { candidate, result };
    }
  }
  return best;
}
