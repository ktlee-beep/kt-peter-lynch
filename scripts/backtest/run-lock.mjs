// 수집기 실행 잠금. 수집기(stream-collector.mjs)가 잡고, 제어판(scripts/pc/panel.mjs)이 읽는다.
//
// 같은 키로 수집기 둘이 뜨면 토큰 재발급이 서로의 토큰을 폐기하고 계정 연결 한도(2)를 넘긴다(아침 작업과 제어판 수동 실행이
// 겹치는 경우). 잠금 파일에 pid·날짜·부팅 시각을 남긴다. 아래 중 하나면 묵은 잠금으로 보고 지운다.
//   - 다른 날 잠금: 수집은 하루를 넘기지 않는다.
//   - 부팅 시각이 다름: 재부팅 뒤에는 같은 pid 라도 다른 프로세스다.
//   - pid 가 죽었거나, 살아 있어도 node.exe 가 아님: 강제 종료로 남은 잠금의 pid 를 같은 날 다른 프로그램이 물려받은 경우.
// 같은 날 같은 부팅 안에서 그 pid 를 다른 node 프로세스가 물려받으면 여기서는 가려내지 못한다 — 제어판이 명령줄로 한 번 더 본다.
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const bootMs = () => Math.round(Date.now() - os.uptime() * 1000);
const BOOT_TOLERANCE_MS = 120e3;   // uptime 반올림·시계 보정 여유

export const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// 살아 있고 node.exe 인지(윈도). tasklist 가 실패하면 살아 있다고 본다 — 모를 때 남의 잠금을 지우지 않는다.
export function pidIsNode(pid) {
  if (!pidAlive(pid)) return false;
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'latin1', windowsHide: true, timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return true;
  return r.stdout.split(/\r?\n/).some(line => /^"node\.exe","(\d+)"/i.test(line) && Number(line.match(/^"[^"]*","(\d+)"/)[1]) === pid);
}

// 없으면 null, 비었거나 깨졌으면 { broken: true }. 읽기 자체가 막히면(EPERM·EBUSY 등) 던진다 — 살아 있는 잠금을 지우지 않도록.
export async function readLock(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : { broken: true }; }
  catch { return { broken: true }; }
}

// 잠금이 지금 유효한지. 날짜·부팅 시각이 다르거나 pid 가 죽었으면 null.
export const liveLock = (held, today, isAlive = pidAlive) =>
  (held?.pid && held.date === today && !(held.boot && Math.abs(held.boot - bootMs()) > BOOT_TOLERANCE_MS) && isAlive(held.pid) ? held : null);

export const lockBody = ({ date, startedAtKST }, pid = process.pid) => JSON.stringify({ pid, date, startedAtKST, boot: bootMs() });

// 잡으면 { ok: true }, 다른 수집기가 살아 있으면 { ok: false, held }. 묵은 잠금을 지웠으면 removed 에 남긴다.
// settleMs: 잡은 뒤 잠깐 기다렸다 다시 읽는다. 묵은 잠금을 두 프로세스가 동시에 치우면 둘 다 만들 수 있어서
// (A 가 지우고 새로 만든 것을 B 가 묵은 것으로 알고 지움) 다시 읽어 내 것이 아니면 물러난다.
// 윈도에서 다른 프로세스가 방금 지운 파일은 잠깐 "삭제 대기"로 남아 만들기·읽기·지우기가 EPERM 으로 실패한다. 잠깐 기다렸다 다시 본다.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TRIES = 6;
export async function takeLock(file, { date, startedAtKST }, { pid = process.pid, isAlive = pidIsNode, settleMs = 400 } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const removed = [];
  let lastErr = null;
  for (let i = 0; i < TRIES; i++) {
    try {
      await writeFile(file, lockBody({ date, startedAtKST }, pid), { flag: 'wx' });
    } catch (e) {
      if (TRANSIENT.has(e.code)) { lastErr = e.code; await sleep(200); continue; }
      if (e.code !== 'EEXIST') throw e;
      let held;
      try {
        held = await readLock(file);
        // 다른 프로세스가 막 만들고 아직 쓰는 중일 수 있어 비어 있으면 한 번 기다렸다 다시 읽는다
        if (held?.broken) { await sleep(1000); held = await readLock(file); }
      } catch (e2) { if (TRANSIENT.has(e2.code)) { lastErr = e2.code; await sleep(200); continue; } throw e2; }
      if (held === null) continue;   // 그사이 없어졌으면 다시 만들어 본다
      // 내 pid 가 적힌 잠금은 아직 쓰지 않았으니 남의 것이다 — 강제 종료로 남은 잠금의 pid 를 내가 물려받은 경우
      if (held && !held.broken && held.pid !== pid && liveLock(held, date, isAlive)) return { ok: false, held, removed };
      // 지우기 직전에 다시 읽어 그대로일 때만 지운다. 판정(tasklist)이 오래 걸린 사이 다른 프로세스가 같은 묵은 잠금을 치우고
      // 새로 잡았을 수 있다 — 그걸 지우면 둘 다 잡는다.
      let again;
      try { again = await readLock(file); }
      catch (e2) { if (TRANSIENT.has(e2.code)) { lastErr = e2.code; await sleep(200); continue; } throw e2; }
      if (JSON.stringify(again) !== JSON.stringify(held)) continue;
      removed.push(held && !held.broken ? held : { pid: null, startedAtKST: '내용 없음' });
      try { await unlink(file); }
      catch (e2) {
        if (TRANSIENT.has(e2.code)) { lastErr = e2.code; await sleep(200); }
        else if (e2.code !== 'ENOENT') throw new Error(`묵은 잠금을 지우지 못함(${e2.code}): ${file}`);
      }
      continue;
    }
    if (settleMs) {
      await sleep(settleMs);
      let now;
      // 다시 읽는 사이 다른 프로세스가 내 잠금을 지우고 있으면(삭제 대기) 진 것으로 본다
      try { now = await readLock(file); } catch (e) { if (!TRANSIENT.has(e.code)) throw e; now = null; }
      if (now?.pid !== pid) return { ok: false, held: now && !now.broken ? now : { pid: null, startedAtKST: '?' }, removed, lost: true };
    }
    return { ok: true, removed };
  }
  throw new Error(`잠금을 잡지 못함(${TRIES}회, 마지막 오류 ${lastErr ?? '없음'}): ${file}`);
}

// 돌고 있는 수집기가 주기적으로 부른다. 'mine' | 'missing' | 'other' | 'unknown'(읽기 실패·깨짐 — 판단 보류).
// 'other' 면 다른 수집기가 잠금을 가져간 것이다(제어판이 남은 잠금으로 잘못 치운 경우 등). 둘이 뜨면 서로의 토큰을 폐기하므로 물러난다.
export async function lockOwner(file, pid = process.pid) {
  let held;
  try { held = await readLock(file); } catch { return 'unknown'; }
  if (held === null) return 'missing';
  if (held.broken) return 'unknown';
  return held.pid === pid ? 'mine' : 'other';
}

// 프로세스 종료 때 부른다(동기). 내 pid 의 잠금만 지운다.
export function releaseLockSync(file, pid = process.pid) {
  try { if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file); } catch { /* 이미 없음 */ }
}
