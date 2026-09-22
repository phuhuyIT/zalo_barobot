/**
 * ocr.ts
 *
 * Tesseract vie+eng trên buffer ảnh (Section 8.2). Không OCR URL sống —
 * href/thumb phải tải xong rồi mới đưa bytes vào đây (proofIngest).
 *
 * Một worker Tesseract (singleton) và một job tại một thời điểm
 * (single-flight). tessdata nằm ở TESSDATA_PATH hoặc ./tessdata.
 */

import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';

type OcrWorker = Awaited<ReturnType<typeof createWorker>>;

let cachedWorker: OcrWorker | null = null;
let initWorkerPromise: Promise<OcrWorker> | null = null;
let flight: Promise<unknown> = Promise.resolve();

export function getTessdataDir(): string {
  const fromEnv = (process.env.TESSDATA_PATH || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), 'tessdata');
}

function hasLocalTraineddata(dir: string): boolean {
  const files = ['eng.traineddata', 'vie.traineddata'];
  return files.every(
    (name) =>
      fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, `${name}.gz`))
  );
}

async function createOcrWorker(): Promise<OcrWorker> {
  const tessdataPath = getTessdataDir();
  fs.mkdirSync(tessdataPath, { recursive: true });
  const local = hasLocalTraineddata(tessdataPath);
  console.log(`[OCR] Khởi tạo Tesseract vie+eng, tessdata=${tessdataPath} local=${local}`);
  if (local) {
    const gzip = !fs.existsSync(path.join(tessdataPath, 'eng.traineddata'));
    return createWorker('vie+eng', 1, {
      langPath: tessdataPath,
      cachePath: tessdataPath,
      gzip,
    });
  }
  return createWorker('vie+eng', 1, {
    cachePath: tessdataPath,
  });
}

export async function getOcrWorker(): Promise<OcrWorker> {
  if (cachedWorker) return cachedWorker;
  if (initWorkerPromise) return initWorkerPromise;
  initWorkerPromise = createOcrWorker()
    .then((worker) => {
      cachedWorker = worker;
      return worker;
    })
    .finally(() => {
      initWorkerPromise = null;
    });
  return initWorkerPromise;
}

export const OCR_TIMEOUT_MS = 90_000;

async function dropOcrWorker(worker: OcrWorker | null): Promise<void> {
  if (cachedWorker === worker) cachedWorker = null;
  initWorkerPromise = null;
  if (!worker) return;
  try {
    await worker.terminate();
  } catch {
    // best-effort — worker hỏng thì tạo lại lần sau
  }
}

async function recognizeBuffer(image: Buffer): Promise<string> {
  if (!image || image.length === 0) return '';
  const worker = await getOcrWorker();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      worker.recognize(image),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('ocr_timeout'));
        }, OCR_TIMEOUT_MS);
      }),
    ]);
    return (result.data.text || '').trim();
  } catch (err) {
    if (timedOut) {
      console.error('[OCR] Timeout — hủy worker Tesseract để ảnh sau không dùng instance hỏng');
      await dropOcrWorker(worker);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Hàng đợi một job. Job lỗi không chặn các ảnh sau (rule 1).
 */
export function ocrImage(image: Buffer): Promise<string> {
  const run = flight.then(
    () => recognizeBuffer(image),
    () => recognizeBuffer(image)
  );
  flight = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function terminateOcrWorker(): Promise<void> {
  const pending = flight;
  flight = Promise.resolve();
  await pending.catch(() => undefined);
  if (cachedWorker) {
    await cachedWorker.terminate();
    cachedWorker = null;
  }
  initWorkerPromise = null;
}
