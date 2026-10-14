// 수집기 실행 잠금(scripts/backtest/run-lock.mjs) — 살아 있는 잠금은 막고, 죽은 pid·다른 날·다른 부팅·node 가 아닌 pid·
// 깨진 잠금은 치운다. 묵은 잠금을 두 프로세스가 동시에 치워도 하나만 잡는다.
// 임시 폴더만 쓴다. 실제 수집기 잠금(scripts/pc/collector.lock)은 건드리지 않는다.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { takeLock, releaseLockSync, liveLock, readLock, pidIsNode, bootMs, lockOwner } from '../scripts/backtest/run-lock.mjs';

const LOCK_MODULE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'backtest', 'run-lock.mjs')).href;

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  if (got === want) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} got=${got} want=${want}`); }
};

const dir = await mkdtemp(path.join(os.tmpdir(), 'kt-runlock-'));
const LOCK = path.join(dir, 'sub', 'collector.lock');
const info = { date: '2026-10-14', startedAtKST: '2026-10-14 08:50' };
// 끝난 프로세스의 pid(이미 죽음)
const deadPid = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString() | 0;

// 묵은 잠금을 두고 두 프로세스가 같은 순간 takeLock. 결과를 낸 뒤 3초 살아 있어 서로의 잠금이 "살아 있음"으로 보이게 한다.
// t0·t1 은 시작·끝 시각 — PC가 바빠 한쪽이 늦게 떠서 앞의 것이 끝난 뒤 들어오면 둘 다 잡는 게 맞으므로 겹친 회차만 센다.
const CHILD = `
const [url, file, goAt] = process.argv.slice(1);
const { takeLock } = await import(url);
await new Promise(r => setTimeout(r, Math.max(0, Number(goAt) - Date.now())));
const t0 = Date.now();
let r;
try { r = await takeLock(file, { date: '2026-10-14', startedAtKST: 'race' }); } catch (e) { r = { ok: 'error', err: e.message }; }
const t1 = Date.now();
process.stdout.write(JSON.stringify({ ok: r.ok, lost: !!r.lost, err: r.err, t0, t1, exitAt: t1 + 3000 }));
await new Promise(r => setTimeout(r, 3000));`;
const runChild = (file, goAt) => new Promise(resolve => {
  const c = spawn(process.execPath, ['--input-type=module', '-e', CHILD, LOCK_MODULE, file, String(goAt)]);
  let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
  c.on('exit', () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: null, out }); } });
});

try {
  let r = await takeLock(LOCK, info);
  ok('빈 자리 — 잡는다(폴더도 만든다)', r.ok, true);
  const mine = JSON.parse(await readFile(LOCK, 'utf8'));
  ok('잠금에 내 pid', mine.pid, process.pid);
  ok('잠금에 부팅 시각', typeof mine.boot, 'number');

  r = await takeLock(LOCK, info, { pid: 999999 });
  ok('살아 있는 잠금 — 못 잡는다', r.ok, false);
  ok('막은 잠금의 pid 를 알려준다', r.held?.pid, process.pid);

  releaseLockSync(LOCK, 12345);
  ok('남의 pid 로는 안 지운다', existsSync(LOCK), true);
  releaseLockSync(LOCK);
  ok('내 pid 로 지운다', existsSync(LOCK), false);

  await writeFile(LOCK, JSON.stringify({ pid: deadPid, date: info.date, startedAtKST: 'x' }));
  r = await takeLock(LOCK, info);
  ok('죽은 pid — 치우고 잡는다', r.ok && r.removed.length === 1 && r.removed[0].pid === deadPid, true);
  releaseLockSync(LOCK);

  await writeFile(LOCK, JSON.stringify({ pid: process.pid, date: '2026-10-13', startedAtKST: 'x' }));
  r = await takeLock(LOCK, info);
  ok('살아 있는 pid 라도 다른 날 잠금 — 치우고 잡는다', r.ok, true);
  releaseLockSync(LOCK);

  await writeFile(LOCK, JSON.stringify({ pid: process.pid, date: info.date, startedAtKST: 'x', boot: bootMs() - 86400e3 }));
  r = await takeLock(LOCK, info);
  ok('살아 있는 pid 라도 다른 부팅의 잠금 — 치우고 잡는다', r.ok, true);
  releaseLockSync(LOCK);

  // 살아 있지만 node 가 아닌 프로세스(ping.exe)가 pid 를 물려받은 경우
  const other = spawn(process.platform === 'win32' ? 'ping.exe' : 'sleep', process.platform === 'win32' ? ['-n', '6', '127.0.0.1'] : ['5'], { stdio: 'ignore' });
  await new Promise(res => other.once('spawn', res));
  ok('pidIsNode: node 아닌 프로세스', pidIsNode(other.pid), process.platform !== 'win32');
  if (process.platform === 'win32') {
    await writeFile(LOCK, JSON.stringify({ pid: other.pid, date: info.date, startedAtKST: 'x', boot: bootMs() }));
    r = await takeLock(LOCK, info);
    ok('같은 날 pid 를 node 아닌 프로세스가 물려받음 — 치우고 잡는다', r.ok && r.removed[0]?.pid === other.pid, true);
    releaseLockSync(LOCK);
  }
  other.kill();
  ok('pidIsNode: 나', pidIsNode(process.pid), true);
  ok('pidIsNode: 죽은 pid', pidIsNode(deadPid), false);

  await writeFile(LOCK, '');
  let t0 = Date.now();
  r = await takeLock(LOCK, info);
  ok('빈 잠금 — 1초 기다렸다 치우고 잡는다', r.ok && Date.now() - t0 >= 900, true);
  releaseLockSync(LOCK);

  await writeFile(LOCK, '{"pid":');
  r = await takeLock(LOCK, info);
  ok('깨진 잠금 — 치우고 잡는다', r.ok, true);
  releaseLockSync(LOCK);

  const asDir = path.join(dir, 'is-a-dir');
  await mkdir(asDir);
  ok('읽기 오류(폴더)는 묵은 잠금으로 보지 않고 던진다', await readLock(asDir).then(() => 'no throw', e => e.code), 'EISDIR');
  ok('readLock: 없음', await readLock(path.join(dir, 'none.lock')), null);

  ok('liveLock: 오늘·살아 있음', !!liveLock({ pid: process.pid, date: info.date }, info.date), true);
  ok('liveLock: 죽은 pid', liveLock({ pid: deadPid, date: info.date }, info.date), null);
  ok('liveLock: 다른 날', liveLock({ pid: process.pid, date: '2026-10-13' }, info.date), null);
  ok('liveLock: 다른 부팅', liveLock({ pid: process.pid, date: info.date, boot: bootMs() - 3600e3 }, info.date), null);
  ok('liveLock: 없음', liveLock(null, info.date), null);

  // 강제 종료로 남은 잠금의 pid 를 새 수집기가 그대로 물려받은 경우 — 나는 아직 잠금을 쓰지 않았으니 남은 잠금이다
  await writeFile(LOCK, JSON.stringify({ pid: process.pid, date: info.date, startedAtKST: 'x', boot: bootMs() }));
  r = await takeLock(LOCK, info);
  ok('내 pid 가 적힌 남은 잠금 — 치우고 잡는다', r.ok && r.removed[0]?.pid === process.pid, true);
  releaseLockSync(LOCK);

  // 묵은 잠금을 판정하는 사이(tasklist 가 느림) 다른 프로세스가 그것을 치우고 새로 잡은 경우 — 새 잠금을 지우면 안 된다
  await writeFile(LOCK, JSON.stringify({ pid: deadPid, date: info.date, startedAtKST: 'stale', boot: bootMs() }));
  const swapAlive = pid => {
    if (pid !== deadPid) return true;
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, date: info.date, startedAtKST: 'winner', boot: bootMs() }));
    return false;
  };
  r = await takeLock(LOCK, info, { pid: 777777, isAlive: swapAlive, settleMs: 0 });
  ok('판정 사이 바뀐 잠금 — 지우지 않고 물러난다', !r.ok && r.held?.startedAtKST === 'winner' && r.removed.length === 0, true);
  ok('판정 사이 바뀐 잠금 — 이긴 쪽 잠금이 그대로', JSON.parse(await readFile(LOCK, 'utf8')).startedAtKST, 'winner');
  releaseLockSync(LOCK);

  ok('lockOwner: 없음', await lockOwner(LOCK), 'missing');
  await takeLock(LOCK, info);
  ok('lockOwner: 내 것', await lockOwner(LOCK), 'mine');
  ok('lockOwner: 남의 것', await lockOwner(LOCK, 12345), 'other');
  releaseLockSync(LOCK);
  await writeFile(LOCK, '{"pid":');
  ok('lockOwner: 깨짐 — 판단 보류', await lockOwner(LOCK), 'unknown');
  ok('lockOwner: 읽기 오류 — 판단 보류', await lockOwner(asDir), 'unknown');
  await rm(LOCK, { force: true });

  // 묵은 잠금을 두 프로세스가 동시에 치우는 경쟁 — 겹쳐 돈 회차마다 정확히 하나만 잡아야 하고, 오류로 죽으면 안 된다
  let overlapped = 0, exactlyOne = 0, errors = 0;
  for (let i = 0; i < 4; i++) {
    const f = path.join(dir, `race-${i}.lock`);
    await writeFile(f, JSON.stringify({ pid: deadPid, date: info.date, startedAtKST: 'stale' }));
    const goAt = Date.now() + 1500;
    const res = await Promise.all([runChild(f, goAt), runChild(f, goAt)]);
    errors += res.filter(x => x.ok !== true && x.ok !== false).length;
    const [a, b] = res;
    const overlap = a.t0 && b.t0 && a.t0 < b.exitAt && b.t0 < a.exitAt;
    if (!overlap) { console.log('    겹치지 않은 회차(한쪽이 늦게 뜸) — 세지 않음', JSON.stringify(res)); continue; }
    overlapped++;
    if (res.filter(x => x.ok === true).length === 1) exactlyOne++;
    else console.log('    경쟁 결과', JSON.stringify(res));
  }
  ok('묵은 잠금 동시 치우기 — 오류로 죽지 않음', errors, 0);
  ok(`묵은 잠금 동시 치우기 — 겹친 ${overlapped}회 모두 하나만 잡음`, overlapped > 0 && exactlyOne === overlapped, true);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n통과 ${pass} / 실패 ${fail}`);
if (fail) process.exit(1);
