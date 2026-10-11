import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoreImagePair, stopImageMatcher } from '../../src/taskproof/worker/imageMatch';

const SCRIPT = `
import json, os, sys, time
pid_path = os.environ.get("MATCH_PIDFILE", "")
log_path = os.environ.get("MATCH_LOG", "")

def note(line):
    if not log_path:
        return
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(line + "\\n")

for raw in sys.stdin:
    text = raw.strip()
    if not text:
        continue
    if pid_path:
        with open(pid_path, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
    req = json.loads(text)
    ref = str(req.get("reference") or "")
    if "slow-ref" in ref:
        time.sleep(30)
    if "bad-json" in ref:
        sys.stdout.write("not-json\\n")
        sys.stdout.flush()
        continue
    if "err-ref" in ref:
        sys.stdout.write(json.dumps({"error": "nope"}) + "\\n")
        sys.stdout.flush()
        continue
    if log_path:
        note("start " + ref)
        time.sleep(0.15)
        note("end " + ref)
    sys.stdout.write(json.dumps({"score": 0.91, "decision": "PASS"}) + "\\n")
    sys.stdout.flush()
`;

describe('long-lived image matcher', () => {
  let dir = '';
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-match-test-'));
    const script = path.join(dir, 'fake_score.py');
    fs.writeFileSync(script, SCRIPT);
    previous.IMAGE_MATCH_SCRIPT = process.env.IMAGE_MATCH_SCRIPT;
    previous.IMAGE_MATCH_PYTHON = process.env.IMAGE_MATCH_PYTHON;
    previous.IMAGE_MATCH_TIMEOUT_MS = process.env.IMAGE_MATCH_TIMEOUT_MS;
    previous.MATCH_PIDFILE = process.env.MATCH_PIDFILE;
    previous.MATCH_LOG = process.env.MATCH_LOG;
    process.env.IMAGE_MATCH_SCRIPT = script;
    process.env.IMAGE_MATCH_PYTHON = 'python3';
    delete process.env.IMAGE_MATCH_TIMEOUT_MS;
    delete process.env.MATCH_PIDFILE;
    delete process.env.MATCH_LOG;
  });

  afterEach(async () => {
    await stopImageMatcher();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scores two photos one at a time on one process', async () => {
    const log = path.join(dir, 'log.txt');
    const pidfile = path.join(dir, 'pid');
    process.env.MATCH_LOG = log;
    process.env.MATCH_PIDFILE = pidfile;
    const query = Buffer.from('photo');
    const [first, second] = await Promise.all([
      scoreImagePair('ref-a', query),
      scoreImagePair('ref-b', query),
    ]);
    expect(first).toEqual({ score: 0.91, decision: 'PASS' });
    expect(second).toEqual({ score: 0.91, decision: 'PASS' });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toEqual(['start ref-a', 'end ref-a', 'start ref-b', 'end ref-b']);
    expect(fs.readFileSync(pidfile, 'utf8').trim()).toMatch(/^\d+$/);
  });

  it('keeps the process after a scorer error and replaces it after a broken line', async () => {
    const pidfile = path.join(dir, 'pid');
    process.env.MATCH_PIDFILE = pidfile;
    const query = Buffer.from('photo');
    await expect(scoreImagePair('err-ref', query)).rejects.toThrow('nope');
    const firstPid = fs.readFileSync(pidfile, 'utf8').trim();
    const ok = await scoreImagePair('ref-ok', query);
    expect(ok.decision).toBe('PASS');
    expect(fs.readFileSync(pidfile, 'utf8').trim()).toBe(firstPid);

    await expect(scoreImagePair('bad-json', query)).rejects.toThrow();
    const restarted = await scoreImagePair('ref-after', query);
    expect(restarted.decision).toBe('PASS');
    expect(fs.readFileSync(pidfile, 'utf8').trim()).not.toBe(firstPid);
  });

  it('kills a stuck scorer and scores the next photo on a new process', async () => {
    process.env.IMAGE_MATCH_TIMEOUT_MS = '500';
    const pidfile = path.join(dir, 'pid');
    process.env.MATCH_PIDFILE = pidfile;
    const query = Buffer.from('photo');
    await scoreImagePair('warmup', query);
    const firstPid = fs.readFileSync(pidfile, 'utf8').trim();
    await expect(scoreImagePair('slow-ref', query)).rejects.toThrow(/timed out/);
    const next = await scoreImagePair('after-timeout', query);
    expect(next).toEqual({ score: 0.91, decision: 'PASS' });
    expect(fs.readFileSync(pidfile, 'utf8').trim()).not.toBe(firstPid);
  });
});
