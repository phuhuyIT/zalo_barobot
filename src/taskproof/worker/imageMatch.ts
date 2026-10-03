/**
 * imageMatch.ts
 *
 * Chấm ảnh nộp với ảnh mẫu của task bằng SIFT + RANSAC + lưới xám
 * (baseline trong demo/match-pipeline). Chỉ PASS mới được ghi minh chứng.
 * Task không có file ảnh mẫu thì không tham gia.
 */

import { spawn } from 'child_process';
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

export function scoreImagePair(referencePath: string, query: Buffer): Promise<ImageScore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-match-'));
  const queryPath = path.join(dir, 'query.bin');
  fs.writeFileSync(queryPath, query);
  const py = process.env.IMAGE_MATCH_PYTHON || 'python3';
  return new Promise((resolve, reject) => {
    const child = spawn(py, [scriptPath(), referencePath, queryPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('image match timed out'));
    }, 60_000);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `image match exit ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString('utf8')) as ImageScore;
        if (typeof parsed.score !== 'number' || !parsed.decision) {
          reject(new Error('image match returned an invalid score'));
          return;
        }
        resolve({ score: parsed.score, decision: parsed.decision });
      } catch (error) {
        reject(error);
      }
    });
  });
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
