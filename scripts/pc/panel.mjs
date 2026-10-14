// KT 단타 수집기 제어판 — 이 PC에서만 열리는 작은 웹 화면(http://127.0.0.1:4787).
//
// 하는 일: 수집기(scripts/backtest/stream-collector.mjs)가 도는지, 오늘 얼마나 모았는지, 작업 스케줄러 일정, 오늘 구독 중인
// 종목, 다음 수집에 쓸 저녁 후보, 저장 용량, 로그를 한 화면에 보여 주고, 수집 시작·중지와 후보 다시 고르기를 버튼으로 한다.
// 시세는 보지 않는다(토큰을 쓰지 않는다). 수집기와 후보 빌더는 따로 떠서 이 창을 닫아도 계속 돈다.
//
// 사용: node scripts/pc/panel.mjs            제어판을 띄우고 창을 연다(이미 떠 있으면 창만 연다)
//       node scripts/pc/panel.mjs --install  실행 파일(KT-Collector.exe)과 바탕화면·시작 메뉴 바로가기를 만든다(install-app.mjs)
//       --no-open  창을 열지 않는다(시험용)   --tab  엣지 앱 창 대신 기본 브라우저 탭으로 연다   --port <n>  포트(기본 4787)
// 30분 동안 화면에서 요청이 없으면 스스로 꺼진다(창이 열려 있으면 10초마다 묻기 때문에 꺼지지 않는다).
//
// 보안: 127.0.0.1 에만 붙는다. Host 헤더가 127.0.0.1/localhost 가 아니면 거부(DNS 리바인딩), 버튼 요청(POST)은
// X-KT-Panel 헤더가 있어야 받는다 — 다른 사이트가 브라우저를 시켜 버튼을 누르게 할 수 없다(사용자 정의 헤더는 CORS 사전요청을
// 부르는데 여기서 허락하지 않는다).
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, readdir, stat, writeFile, appendFile, open, unlink } from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindow, inBuildWindow, BUILD_FILE_RE } from '../backtest/build-window.mjs';
import { readLock, liveLock, pidAlive, releaseLockSync } from '../backtest/run-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BT = path.join(ROOT, 'scripts', 'backtest');
const COLLECTOR = path.join(BT, 'stream-collector.mjs');
const BUILDER = path.join(BT, 'universe-builder.mjs');
const LOCK_FILE = path.join(HERE, 'collector.lock');   // stream-collector.mjs 와 같은 경로
const STOP_FILE = path.join(HERE, 'collector.stop');
const TICKS = path.join(BT, 'ticks'), UNIVERSE = path.join(BT, 'universe'), CACHE = path.join(BT, 'cache');
const LOGS = { collector: 'collector.log', universe: 'universe.log', morning: 'morning.log', evening: 'evening.log', panel: 'panel.log' };
const COLLECT_FROM = '07:00', COLLECT_UNTIL = '20:05';   // stream-collector.mjs 기본 수집 창과 같게
const BUILD_BLOCK = ['07:00', '15:40'];                   // 평일 이 사이 빌드는 어느 수집에도 안 쓰인다(build-window.mjs)
const BUILD_COOLDOWN_MS = 30 * 60 * 1000;                 // 네이버 테마 내부 API 호출 최소화
const IDLE_MS = 30 * 60 * 1000;
const STOP_STUCK_MS = 30 * 1000;                          // 중지 요청 뒤 이만큼 지나도 안 멈추면 강제 종료를 허용

const argv = process.argv.slice(2);
const PORT = Number(argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 4787);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) { console.error(`--port 는 1024~65535 사이 정수여야 합니다(받은 값: ${PORT})`); process.exit(2); }
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}/`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// ---------- 시각 ----------
const kst = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
};
const nextWeekday = ymd => {
  const d = new Date(`${ymd}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
};
const panelLog = async msg => { const t = kst(); await appendFile(path.join(HERE, LOGS.panel), `[${t.date} ${t.hm}] ${msg}\n`).catch(() => {}); };

// ---------- 설치(실행 파일·바로가기) ----------
if (argv.includes('--install')) {
  await import('./install-app.mjs');
} else {
  startServer();
}

// ---------- 시스템 조회(PowerShell, 30초 캐시) ----------
// 작업 스케줄러 상태와, 잠금 없이 도는 예전 버전 수집기·빌더 프로세스를 찾는다.
// 오류는 모두 종료 코드로 알린다(Get-CimInstance 실패는 기본이 "계속"이라 빈 목록이 정상처럼 보인다). 오류 문구는 stdout 에 JSON 으로.
// hidden: 명령줄을 읽을 수 없는 node 프로세스(관리자 권한·다른 계정). 수집기인지 알 수 없으므로 따로 센다.
const SYS_PS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
$t = @(Get-ScheduledTask | Where-Object TaskName -like 'KT-PeterLynch*' | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  [pscustomobject]@{ name = $_.TaskName; state = "$($_.State)"; result = $i.LastTaskResult;
    last = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null };
    next = if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null } } })
$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
$p = @($all | Where-Object { $_.CommandLine -match 'stream-collector\\.mjs|universe-builder\\.mjs' } | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; started = $_.CreationDate.ToString('yyyy-MM-dd HH:mm') } })
$h = @($all | Where-Object { -not $_.CommandLine } | ForEach-Object { $_.ProcessId })
ConvertTo-Json -Compress -Depth 4 @{ tasks = $t; procs = $p; hidden = $h }
} catch { ConvertTo-Json -Compress @{ error = "$_" }; exit 3 }`;
let sysCache = { at: 0, value: null, pending: null };
function sysInfo(force = false) {
  if (!force && sysCache.value && Date.now() - sysCache.at < 30000) return Promise.resolve(sysCache.value);
  if (sysCache.pending) return sysCache.pending;
  sysCache.pending = new Promise(resolve => {
    const t0 = Date.now();   // at 은 조회를 시작한 시각 — 프로세스 목록은 이 시각 이후의 모습이다
    execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(SYS_PS, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 }, (err, out) => {
        let v;
        try {
          // err.message 에는 인코딩된 명령 전체가, stderr 에는 CLIXML 이 들어 있다 — 스크립트가 stdout 에 낸 오류 첫 줄만 보인다
          if (err) {
            let msg = '';
            try { msg = String(JSON.parse(String(out ?? '').trim()).error ?? ''); } catch {}
            throw new Error(msg.trim().split('\n')[0].slice(0, 200) || (err.killed ? '20초 안에 끝나지 않음' : `종료 코드 ${err.code}`));
          }
          const j = JSON.parse(out.trim()); v = { tasks: j.tasks ?? [], procs: j.procs ?? [], hidden: j.hidden ?? [], at: t0 };
        }
        catch (e) { v = { tasks: [], procs: [], hidden: [], at: t0, error: `시스템 조회 실패: ${e.message.split('\n')[0]}` }; }
        sysCache = { at: t0, value: v, pending: null };
        resolve(v);
      });
  });
  return sysCache.pending;
}
const isCollectorProc = p => /stream-collector\.mjs/.test(p.cmd) && !/--dry/.test(p.cmd);
const isBuilderProc = p => /universe-builder\.mjs/.test(p.cmd);

// ---------- 파일 읽기 ----------
async function tail(file, bytes = 64 * 1024) {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let s = buf.toString('utf8');
    if (size > len) s = s.slice(s.indexOf('\n') + 1);   // 잘린 첫 줄 버림
    return s;
  } catch { return ''; } finally { await fh?.close(); }
}
const readJson = async f => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
async function dirFiles(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  // 쓰는 중에 지워진 파일 하나 때문에 목록 전체를 잃지 않도록 파일별로 건너뛴다
  const rows = await Promise.all(names.map(async n => {
    try { const s = await stat(path.join(dir, n)); return { name: n, size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() }; } catch { return null; }
  }));
  return rows.filter(Boolean);
}

// 코어 종목 이름(일봉 캐시의 name). 파일이 커서 한 번 읽은 이름은 기억한다.
const nameMemo = new Map();
async function codeName(code) {
  if (nameMemo.has(code)) return nameMemo.get(code);
  const j = await readJson(path.join(CACHE, `${code}.json`));
  nameMemo.set(code, j?.name ?? null);
  return j?.name ?? null;
}

const STATS_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] trade=(\d+) book=(\d+) \(표집 제외 (\d+)\) err=(\d+) 마지막수신 (\d+)초 전/;
async function collectorLogInfo(today) {
  const lines = (await tail(path.join(HERE, LOGS.collector), 256 * 1024)).split(/\r?\n/).filter(Boolean);
  let stats = null;
  for (let i = lines.length - 1; i >= 0 && !stats; i--) {
    const m = lines[i].match(STATS_RE);
    if (m && m[1] === today) stats = { at: m[2], trade: +m[3], book: +m[4], bookSkipped: +m[5], errors: +m[6], lastRecvSec: +m[7] };
  }
  return { stats, recent: lines.slice(-6) };
}

const subsMemo = new Map();
async function todaySubscriptions(today) {
  const files = (await dirFiles(path.join(TICKS, today))).filter(f => /^subscriptions-\d{4}\.json$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  const last = files.at(-1);
  if (!last) return null;
  const key = `${today}/${last.name}/${last.mtime}`;
  if (subsMemo.has(key)) return subsMemo.get(key);
  const j = await readJson(path.join(TICKS, today, last.name));
  if (!j) return null;
  const core = await Promise.all((j.core ?? []).map(async c => ({ code: c, name: await codeName(c) })));
  const v = { file: last.name, startedAtKST: j.startedAtKST, until: j.until, picksFile: j.picksFile, picksBuiltAtKST: j.picksBuiltAtKST,
    picksReason: j.picksReason ?? null, coreStaleDropped: j.coreStaleDropped ?? [], coreCacheNewest: j.coreCacheNewest ?? null,
    picks: j.picks ?? [], core, tradeCount: (j.trade ?? []).length, bookCount: (j.book ?? []).length, runs: files.length };
  subsMemo.set(key, v);
  return v;
}

// 다음 수집일과 그날 쓰일 저녁 빌드. 수집기 loadPicks 와 같은 규칙으로 고른다(창 안 최신 빌드부터, 후보가 빈 빌드는 건너뜀).
// 평일에 오늘 수집이 아직 시작되지 않았으면(수집 기록 없음) 다음 수집은 오늘이다.
const buildMemo = new Map();
async function readBuild(name) {
  if (buildMemo.has(name)) return buildMemo.get(name);
  const j = await readJson(path.join(UNIVERSE, name));
  if (!j) return null;   // 쓰는 중이라 반만 읽혔을 수 있어 기억하지 않는다
  const v = {
    file: name, builtAtKST: j.builtAtKST, counts: j.counts ?? null,
    picks: (j.picks ?? []).filter(p => p?.code).map(p => ({ code: p.code, name: p.name, market: p.market, price: p.price, changeRate: p.changeRate,
      tradeValue: p.tradeValue, bucket: p.bucket, tickPct: p.tickPct, themes: (p.themes ?? []).map(t => t.name) })),
  };
  buildMemo.set(name, v);
  return v;
}
async function nextBuild(now, todayStarted) {
  const target = !now.weekend && now.hm < COLLECT_UNTIL && !todayStarted ? now.date : nextWeekday(now.date);
  const [lo, hi] = buildWindow(target);
  const names = (await dirFiles(UNIVERSE)).filter(f => BUILD_FILE_RE.test(f.name) && inBuildWindow(f.name, target)).map(f => f.name).sort();
  const base = { target, window: [lo.replace('_', ' ').replace(/(\d{2})(\d{2})$/, '$1:$2'), hi.replace('_', ' ').replace(/(\d{2})(\d{2})$/, '$1:$2')] };
  if (!names.length) return { ...base, file: null };
  const skipped = [];
  let firstRead = null;
  for (const name of names.reverse()) {
    const b = await readBuild(name);
    if (!b) { skipped.push(`${name}(읽지 못함)`); continue; }
    firstRead ??= b;
    if (b.picks.length) return { ...base, ...b, skipped };
    skipped.push(`${name}(후보 0)`);
  }
  return { ...base, ...(firstRead ?? { file: names[0], error: '빌드 파일을 읽지 못함' }), skipped };
}

let storageCache = { at: 0, value: null };
async function storage() {
  if (storageCache.value && Date.now() - storageCache.at < 60000) return storageCache.value;
  const days = (await dirFiles(TICKS)).filter(f => f.dir && /^\d{4}-\d{2}-\d{2}$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
  const value = await Promise.all(days.map(async d => {
    const files = await dirFiles(path.join(TICKS, d.name));
    const gz = files.filter(f => f.name.endsWith('.ndjson.gz'));
    return { date: d.name, files: gz.length, bytes: gz.reduce((s, f) => s + f.size, 0) };
  }));
  storageCache = { at: Date.now(), value };
  return value;
}

// ---------- 상태 ----------
let lastStart = { at: 0, pid: null, exit: undefined, exitAt: 0 };
let builder = { child: null, startedAt: 0, exit: null };
// 잠금(새 버전)과 프로세스 목록(예전 버전·교차 확인)을 합쳐 본다.
//  - procs 는 최대 30초 묵은 캐시라 이미 끝난 pid 는 걸러낸다(끝난 직후 "예전 버전 수집 중"으로 잘못 보이지 않게).
//  - 잠금의 pid 가 살아 있어도, 잠금이 생긴 뒤 조회한 프로세스 목록에 수집기로 없으면 남은 잠금이다(같은 날 pid 를 다른 node 가 물려받음).
//    그 pid 의 명령줄을 읽을 수 없으면(hidden) 수집기인지 모르므로 남은 잠금으로 보지 않는다.
async function collectorState(now, sys) {
  let raw, lockError = null;
  try { raw = await readLock(LOCK_FILE); } catch (e) { raw = null; lockError = `잠금 파일을 읽지 못함(${e.code ?? e.message})`; }
  const live = liveLock(raw, now.date);
  const procs = sys.procs.filter(p => isCollectorProc(p) && pidAlive(p.pid));
  const hidden = (sys.hidden ?? []).filter(pidAlive);
  const lockMtime = live ? (await stat(LOCK_FILE).catch(() => null))?.mtimeMs ?? 0 : 0;
  const orphan = live && !sys.error && sys.at > lockMtime + 3000 && !procs.some(p => p.pid === live.pid) && !hidden.includes(live.pid);
  const held = orphan ? null : live;
  const legacy = !held && procs.length > 0;
  const running = !!held || procs.length > 0;
  const launchEnded = lastStart.exit !== undefined;
  const starting = !running && !launchEnded && Date.now() - lastStart.at < 20000;
  const stopStat = running ? await stat(STOP_FILE).catch(() => null) : null;
  return { running, starting, legacy, pid: held?.pid ?? procs[0]?.pid ?? null, startedAtKST: held?.startedAtKST ?? procs[0]?.started ?? null,
    instances: Math.max(procs.length, held ? 1 : 0), stopRequested: !!stopStat, stopStuck: !!stopStat && Date.now() - stopStat.mtimeMs > STOP_STUCK_MS,
    orphanLock: orphan ? { pid: live.pid, startedAtKST: live.startedAtKST } : null, lockError, hiddenNodes: hidden.length,
    lastLaunch: lastStart.at ? { pid: lastStart.pid, at: lastStart.at, exit: lastStart.exit ?? null, exitAt: lastStart.exitAt || null } : null };
}

const TASK_LABEL = {
  'KT-PeterLynch-Morning': '아침 수집 (평일 08:50 ~ 20:05)',
  'KT-PeterLynch-Evening': '내일 후보 고르기 (평일 20:15)',
  'KT-PeterLynch-ScanSignal': '웹 야간 스캔 신호 (매일 20:00)',
};
const TASK_RESULT = { 0: '정상', 267009: '실행 중', 267011: '아직 실행 안 됨', 267014: '중간에 종료됨', 2147750687: '이미 실행 중이라 건너뜀' };

async function status() {
  const now = kst();
  const sys = await sysInfo();
  const [collector, log, subs, store] = await Promise.all([
    collectorState(now, sys), collectorLogInfo(now.date), todaySubscriptions(now.date), storage(),
  ]);
  // 오늘 수집이 이미 시작됐으면(구독 기록이 있거나 돌고 있음) 다음 수집은 다음 평일이다
  const next = await nextBuild(now, !!subs || collector.running).catch(e => ({ target: null, file: null, error: e.message }));
  const builderRunning = (builder.child && builder.exit === null) || sys.procs.some(isBuilderProc);
  const inWindow = !now.weekend && now.hm >= COLLECT_FROM && now.hm < COLLECT_UNTIL;
  const buildBlocked = !now.weekend && now.hm >= BUILD_BLOCK[0] && now.hm < BUILD_BLOCK[1];
  return {
    now: `${now.date} ${now.hm}`, weekend: now.weekend, collectWindow: [COLLECT_FROM, COLLECT_UNTIL], inWindow,
    collector, log, today: store.find(d => d.date === now.date) ?? { date: now.date, files: 0, bytes: 0 }, subs, next,
    storage: store, builder: { running: builderRunning, lastExit: builder.exit, buildBlocked, blockWindow: BUILD_BLOCK },
    tasks: sys.tasks.map(t => ({ ...t, label: TASK_LABEL[t.name] ?? t.name, resultText: TASK_RESULT[t.result] ?? `코드 0x${(t.result >>> 0).toString(16)}` }))
      .sort((a, b) => Object.keys(TASK_LABEL).indexOf(a.name) - Object.keys(TASK_LABEL).indexOf(b.name)),
    sysError: sys.error ?? null,
  };
}

// ---------- 동작 ----------
function launch(script, logName) {
  const fd = openSync(path.join(HERE, logName), 'a');
  try {
    const child = spawn(process.execPath, [script], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
    return child;
  } finally { closeSync(fd); }
}

async function startCollector() {
  const now = kst();
  if (now.weekend) return [400, { message: '주말에는 수집하지 않습니다.' }];
  if (now.hm < COLLECT_FROM || now.hm >= COLLECT_UNTIL) return [400, { message: `수집 시간(${COLLECT_FROM}~${COLLECT_UNTIL})이 아닙니다.` }];
  const sys = await sysInfo(true);
  // 프로세스 목록을 못 읽으면 예전 버전 수집기(잠금 없음)가 도는지 알 수 없다 — 둘이 뜨면 서로의 토큰을 폐기한다
  if (sys.error) return [503, { message: `시스템 조회가 실패해 수집기가 이미 도는지 확인할 수 없습니다. 잠시 뒤 다시 눌러 주세요. (${sys.error})` }];
  const st = await collectorState(now, sys);
  if (st.lockError) return [503, { message: `${st.lockError}. 잠시 뒤 다시 눌러 주세요.` }];
  if (st.running) return [409, { message: `이미 수집 중입니다(pid ${st.pid}).` }];
  if (st.starting) return [409, { message: '방금 시작했습니다. 잠시 뒤 상태가 바뀝니다.' }];
  // 명령줄을 읽을 수 없는 node 는 잠금 없이 도는 예전 버전 수집기일 수 있다
  if (st.hiddenNodes) return [503, { message: `명령줄을 확인할 수 없는 node 프로세스가 ${st.hiddenNodes}개 있습니다(관리자 권한으로 실행된 프로그램 등). 수집기가 이미 도는지 알 수 없어 시작하지 않았습니다. 작업 관리자에서 확인해 주세요.` }];
  if (st.orphanLock) {
    releaseLockSync(LOCK_FILE, st.orphanLock.pid);   // 그사이 다른 잠금으로 바뀌었으면 지우지 않는다
    await panelLog(`남은 잠금 치움 pid=${st.orphanLock.pid}(수집기 아님)`);
  }
  await appendFile(path.join(HERE, LOGS.collector), `[${now.date} ${now.hm}] 제어판에서 수집 시작\n`).catch(() => {});
  const child = launch(COLLECTOR, LOGS.collector);
  const launched = { at: Date.now(), pid: child.pid, exit: undefined, exitAt: 0 };
  lastStart = launched;
  child.on('exit', code => {
    launched.exit = code; launched.exitAt = Date.now(); sysCache.at = 0;
    panelLog(`수집기 끝 pid=${launched.pid} exit=${code}`);
  });
  sysCache.at = 0;
  await panelLog(`수집 시작 pid=${child.pid}`);
  return [200, { message: `수집을 시작했습니다(pid ${child.pid}). ${COLLECT_UNTIL}에 스스로 끝납니다.`, pid: child.pid }];
}

async function stopCollector(force) {
  const now = kst();
  const sys = await sysInfo(true);
  const st = await collectorState(now, sys);
  if (st.lockError) return [503, { message: `${st.lockError}. 잠시 뒤 다시 눌러 주세요.` }];
  if (!st.running) return [404, { message: '돌고 있는 수집기가 없습니다.' }];
  // 강제 종료는 방금 조회한 프로세스 목록에서 수집기로 확인된 pid 만 끈다
  const collectorPids = sys.error ? [] : sys.procs.filter(p => isCollectorProc(p) && pidAlive(p.pid)).map(p => p.pid);
  let targets;
  if (!st.legacy) {
    // 새 버전: 중지 파일을 보면 3초 안에 파일을 닫고 끝낸다. 30초가 지나도 남아 있으면 멈춘 것으로 보고 강제 종료를 묻는다.
    if (!st.stopRequested) {
      await writeFile(STOP_FILE, `${now.date} ${now.hm}\n`);
      await panelLog(`중지 요청 pid=${st.pid}`);
      return [200, { message: '중지 요청을 보냈습니다. 몇 초 안에 파일을 닫고 멈춥니다.' }];
    }
    if (!st.stopStuck) return [409, { message: '중지 요청을 보냈습니다. 멈출 때까지 잠시 기다려 주세요.' }];
    if (!force) return [409, { needForce: true, message: '중지 요청 뒤 30초가 지나도 멈추지 않았습니다. 한 번 더 누르면 강제로 끕니다(마지막 몇 초 데이터가 잘릴 수 있음).' }];
    targets = collectorPids.filter(pid => pid === st.pid);
  } else {
    if (!force) return [409, { needForce: true, message: '예전 버전 수집기라 정상 중지 신호를 받지 못합니다. 한 번 더 누르면 강제로 끕니다(마지막 몇 초 데이터가 잘릴 수 있음).' }];
    targets = collectorPids;
  }
  if (!targets.length) return [503, { message: '시스템 조회로 수집기 프로세스를 확인하지 못해 강제로 끄지 않았습니다. 잠시 뒤 다시 눌러 주세요.' }];
  const killed = [];
  for (const pid of targets) {
    await new Promise(r => execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true }, err => { if (!err) killed.push(pid); r(); }));
  }
  // 강제로 끈 새 버전 수집기는 잠금·중지 파일을 못 치운다
  if (!st.legacy && killed.includes(st.pid)) {
    releaseLockSync(LOCK_FILE, st.pid);
    await unlink(STOP_FILE).catch(() => {});
  }
  sysCache.at = 0;
  await panelLog(`강제 종료 pid=${killed.join(',') || '실패'}`);
  return killed.length ? [200, { message: `강제로 껐습니다(pid ${killed.join(', ')}).` }] : [500, { message: '강제 종료에 실패했습니다.' }];
}

async function buildUniverse() {
  const now = kst();
  if (!now.weekend && now.hm >= BUILD_BLOCK[0] && now.hm < BUILD_BLOCK[1])
    return [400, { message: `장중(${BUILD_BLOCK[0]}~${BUILD_BLOCK[1]})에 고른 후보는 다음 수집에 쓰이지 않습니다. ${BUILD_BLOCK[1]} 이후에 눌러 주세요. 평일 20:15에는 자동으로 고릅니다.` }];
  const sys = await sysInfo(true);
  if ((builder.child && builder.exit === null) || sys.procs.some(isBuilderProc)) return [409, { message: '후보를 고르는 중입니다(최대 8분).' }];
  const recent = (await dirFiles(UNIVERSE)).filter(f => BUILD_FILE_RE.test(f.name) && Date.now() - f.mtime < BUILD_COOLDOWN_MS);
  if (recent.length) return [429, { message: `30분 안에 고른 후보(${recent[0].name})가 있습니다. 네이버 호출을 줄이려고 30분 간격으로만 받습니다.` }];
  await appendFile(path.join(HERE, LOGS.universe), `[${now.date} ${now.hm}] 제어판에서 후보 고르기 시작\n`).catch(() => {});
  const child = launch(BUILDER, LOGS.universe);
  builder = { child, startedAt: Date.now(), exit: null };
  child.on('exit', code => { builder.exit = code; buildMemo.clear(); panelLog(`후보 고르기 끝 exit=${code}`); });
  sysCache.at = 0;
  await panelLog(`후보 고르기 시작 pid=${child.pid}`);
  return [200, { message: '후보를 고르기 시작했습니다. 보통 2~8분 걸립니다.' }];
}

// ---------- 서버 ----------
function startServer() {
  let lastReq = Date.now();
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    lastReq = Date.now();
    try {
      if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, { message: 'host 거부' });
      const url = new URL(req.url, BASE_URL);
      if (req.method === 'GET') {
        if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
        if (url.pathname === '/api/ping') return send(res, 200, { app: 'kt-panel' });
        if (url.pathname === '/api/status') return send(res, 200, await status());
        if (url.pathname === '/api/log') {
          const name = url.searchParams.get('name');
          const f = Object.hasOwn(LOGS, name ?? '') ? LOGS[name] : null;
          if (!f) return send(res, 400, { message: '로그 이름' });
          return send(res, 200, { text: await tail(path.join(HERE, f)) });
        }
        return send(res, 404, { message: '없음' });
      }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-kt-panel'] !== '1' || (origin && !ALLOWED_ORIGINS.has(origin))) return send(res, 403, { message: '요청 거부' });
        let body = '';
        for await (const c of req) { body += c; if (body.length > 10000) return send(res, 413, { message: '너무 큼' }); }
        const j = body ? JSON.parse(body) : {};
        let r;
        if (url.pathname === '/api/collector/start') r = await startCollector();
        else if (url.pathname === '/api/collector/stop') r = await stopCollector(j.force === true);
        else if (url.pathname === '/api/universe/build') r = await buildUniverse();
        else r = [404, { message: '없음' }];
        return send(res, r[0], r[1]);
      }
      return send(res, 405, { message: '메서드' });
    } catch (e) {
      return send(res, 500, { message: `제어판 오류: ${e.message}` });
    }
  });
  server.on('error', async e => {
    // 실행 파일로 띄우면 콘솔이 없으므로 시작 실패는 panel.log 에도 남긴다
    if (e.code !== 'EADDRINUSE') { console.error(e); await panelLog(`제어판 시작 오류: ${e.message}`); process.exit(1); }
    // 이미 떠 있는 제어판이면 창만 연다
    try {
      const r = await fetch(`${BASE_URL}api/ping`, { signal: AbortSignal.timeout(3000) });
      if ((await r.json()).app === 'kt-panel') { console.log(`제어판이 이미 떠 있습니다: ${BASE_URL}`); openBrowser(); return setTimeout(() => process.exit(0), 500); }
    } catch { /* 다른 프로그램 */ }
    console.error(`포트 ${PORT}를 다른 프로그램이 쓰고 있습니다. --port 로 다른 번호를 주세요.`);
    await panelLog(`포트 ${PORT}를 다른 프로그램이 쓰고 있어 제어판을 띄우지 못했습니다.`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`KT 단타 수집기 제어판: ${BASE_URL}`);
    console.log('이 창을 닫으면 제어판만 꺼지고, 수집기는 계속 돕니다. 30분 동안 화면을 안 보면 스스로 꺼집니다.');
    openBrowser();
  });
  setInterval(() => {
    if (Date.now() - lastReq > IDLE_MS && !(builder.child && builder.exit === null)) { console.log('30분 동안 요청이 없어 끕니다.'); process.exit(0); }
  }, 60000).unref();
}

// 엣지가 있으면 탭·주소창 없는 프로그램 창(--app)으로 연다. 없거나 --tab 이면 기본 브라우저 탭으로 연다.
function openBrowser() {
  if (argv.includes('--no-open')) return;
  // 창을 못 열어도 제어판은 계속 떠 있어야 하므로 spawn 의 동기 예외도 여기서 삼키고 알린다
  const fail = e => console.error(`창을 열지 못했습니다: ${e.message}`);
  const tab = () => {
    try { spawn('rundll32.exe', ['url.dll,FileProtocolHandler', BASE_URL], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', fail).unref(); }
    catch (e) { fail(e); }
  };
  const edge = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']
    .map(k => process.env[k] && path.join(process.env[k], 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(p => p && existsSync(p));
  if (!edge || argv.includes('--tab')) return tab();
  try { spawn(edge, [`--app=${BASE_URL}`, '--window-size=1180,900'], { detached: true, stdio: 'ignore' }).on('error', tab).unref(); }
  catch { tab(); }
}

// ---------- 화면 ----------
const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KT 단타 수집기</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect x='4' y='4' width='92' height='92' rx='20' fill='%232457d6'/%3E%3Cg fill='white'%3E%3Crect x='22' y='56' width='12' height='22'/%3E%3Crect x='44' y='42' width='12' height='36'/%3E%3Crect x='66' y='24' width='12' height='54'/%3E%3C/g%3E%3C/svg%3E">
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#667085;--line:#e4e7ec;--accent:#2457d6;--accent-text:#fff;
--ok:#137a3e;--ok-bg:#e7f6ec;--warn:#9a5b00;--warn-bg:#fff4e0;--bad:#b42318;--bad-bg:#fdecea;--idle:#475467;--idle-bg:#eef0f3;--up:#c8322b;--down:#2457d6}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121418;--card:#1b1e24;--text:#e6e8ec;--muted:#9aa3b2;--line:#2c313a;
--accent:#6d93f2;--accent-text:#0d1220;--ok:#5fd08c;--ok-bg:#16301f;--warn:#f0b65a;--warn-bg:#33270f;--bad:#f2817a;--bad-bg:#3a1a18;--idle:#b4bcc8;--idle-bg:#262a31;--up:#f2817a;--down:#8fb0f5}}
:root[data-theme="dark"]{--bg:#121418;--card:#1b1e24;--text:#e6e8ec;--muted:#9aa3b2;--line:#2c313a;
--accent:#6d93f2;--accent-text:#0d1220;--ok:#5fd08c;--ok-bg:#16301f;--warn:#f0b65a;--warn-bg:#33270f;--bad:#f2817a;--bad-bg:#3a1a18;--idle:#b4bcc8;--idle-bg:#262a31;--up:#f2817a;--down:#8fb0f5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin:4px 0 14px}
h1{font-size:20px;margin:0}
h2{font-size:16px;margin:0 0 10px}
.muted{color:var(--muted)} .small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:700;font-size:14px}
.b-ok{color:var(--ok);background:var(--ok-bg)} .b-warn{color:var(--warn);background:var(--warn-bg)} .b-bad{color:var(--bad);background:var(--bad-bg)} .b-idle{color:var(--idle);background:var(--idle-bg)}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.num{border:1px solid var(--line);border-radius:8px;padding:10px}
.num b{display:block;font-size:20px}
button{font:inherit;border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:600}
button.sec{background:transparent;color:var(--accent)}
button.danger{border-color:var(--bad);background:var(--bad);color:#fff}
button:disabled{opacity:.45;cursor:not-allowed}
.msg{margin-top:10px;min-height:1.5em}
.tbl{width:100%;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600}
td.r,th.r{text-align:right}
.up{color:var(--up)} .down{color:var(--down)}
details summary{cursor:pointer;color:var(--accent);margin-top:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.tabs button{padding:5px 12px;font-weight:500}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:360px;overflow:auto;font:12.5px/1.45 Consolas,"D2Coding",monospace;white-space:pre-wrap;word-break:break-all;margin:0}
footer{font-size:13px;color:var(--muted);margin:6px 2px 30px}
@media (max-width:560px){.wrap{padding:12px 16px} .nums{grid-template-columns:1fr 1fr}}
</style></head>
<body><div class="wrap">
<header><h1>KT 단타 수집기</h1><span class="muted small" id="clock">불러오는 중</span></header>

<section class="card">
  <div class="row"><span class="badge b-idle" id="cBadge">확인 중</span><span id="cDetail" class="muted"></span></div>
  <div class="nums">
    <div class="num"><span class="muted small">체결 수신</span><b id="nTrade">-</b></div>
    <div class="num"><span class="muted small">호가 저장</span><b id="nBook">-</b></div>
    <div class="num"><span class="muted small">마지막 수신</span><b id="nLast">-</b></div>
    <div class="num"><span class="muted small">오늘 저장 용량</span><b id="nSize">-</b></div>
  </div>
  <div class="row"><button id="btnStart" disabled>수집 시작</button><button id="btnStop" class="sec" disabled>수집 중지</button></div>
  <div class="msg small" id="cMsg"></div>
</section>

<section class="card">
  <h2>자동 실행</h2>
  <div class="tbl"><table><thead><tr><th>작업</th><th>다음 실행</th><th>지난 실행</th><th>결과</th></tr></thead><tbody id="tasks"></tbody></table></div>
  <div class="small muted" id="sysErr"></div>
</section>

<section class="card">
  <h2>오늘 수집 중인 종목</h2>
  <div class="small muted" id="subsInfo"></div>
  <div class="tbl"><table><thead><tr><th>종목</th><th>코드</th><th>규모</th><th class="r">호가 1틱</th></tr></thead><tbody id="subsPicks"></tbody></table></div>
  <details><summary id="coreSum">거래대금 상위 코어 종목</summary><div class="chips" id="coreList"></div></details>
</section>

<section class="card">
  <h2>다음 수집 후보</h2>
  <div class="small muted" id="nextInfo"></div>
  <div class="tbl"><table><thead><tr><th>종목</th><th>시장</th><th class="r">가격</th><th class="r">등락</th><th class="r">거래대금(억)</th><th>규모</th><th>테마</th></tr></thead><tbody id="nextPicks"></tbody></table></div>
  <div class="row" style="margin-top:12px"><button id="btnBuild" class="sec" disabled>지금 후보 다시 고르기</button><span class="small muted" id="buildHint"></span></div>
  <div class="msg small" id="bMsg"></div>
</section>

<section class="card">
  <h2>저장된 데이터</h2>
  <div class="tbl"><table><thead><tr><th>날짜</th><th class="r">파일</th><th class="r">용량</th></tr></thead><tbody id="store"></tbody></table></div>
</section>

<section class="card">
  <h2>기록</h2>
  <div class="tabs" id="logTabs">
    <button data-log="collector">수집기</button><button data-log="universe" class="sec">후보 고르기</button>
    <button data-log="morning" class="sec">아침 작업</button><button data-log="evening" class="sec">저녁 작업</button><button data-log="panel" class="sec">제어판</button>
  </div>
  <pre id="logText">불러오는 중</pre>
</section>

<footer>이 화면은 이 PC에서만 열립니다(127.0.0.1). 창이나 탭을 닫아도 수집은 계속됩니다. 수집기는 시세만 받고 주문은 하지 않습니다.
PC가 꺼지거나 잠자기에 들어가면 수집이 멈추니, 평일 낮에는 전원을 연결해 두세요.</footer>
</div>
<script>
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => n == null ? '-' : Number(n).toLocaleString('ko-KR');
const mb = b => b >= 1e9 ? (b/1e9).toFixed(2) + ' GB' : (b/1e6).toFixed(1) + ' MB';
const post = async (u, body) => {
  try {
    const r = await fetch(u, { method: 'POST', headers: { 'X-KT-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, ...(await r.json().catch(() => ({ message: '응답 오류(' + r.status + ')' }))) };
  } catch { return { status: 0, message: '제어판에 연결할 수 없습니다 — 바탕화면이나 시작 메뉴의 "KT 단타 수집기"로 다시 여세요' }; }
};
const hhmm = ms => new Date(ms + 9 * 3600e3).toISOString().slice(11, 16);
let S = null, logName = 'collector', stopArm = 0, forceArm = false;

function render(s) {
  S = s;
  $('clock').textContent = '지금 ' + s.now + ' (한국 시각) · 10초마다 갱신';
  const c = s.collector, st = s.log.stats;
  let badge = 'b-idle', text = '쉬는 중', detail = '';
  if (c.running) {
    const silent = st && st.lastRecvSec > 120;
    badge = silent || c.stopStuck ? 'b-warn' : 'b-ok'; text = c.stopRequested ? '멈추는 중' : '수집 중';
    detail = (c.startedAtKST ? c.startedAtKST.slice(11) + ' 시작' : '') + (c.pid ? ' · pid ' + c.pid : '') + ' · ' + s.collectWindow[1] + '에 자동 종료'
      + (c.legacy ? ' · 예전 버전(중지 시 강제 종료)' : '') + (c.instances > 1 ? ' · 경고: ' + c.instances + '개가 동시에 돌고 있음' : '') + (silent ? ' · 2분 넘게 수신 없음' : '')
      + (c.stopStuck ? ' · 중지 요청 뒤 30초가 지나도 멈추지 않음 — [수집 중지]를 다시 누르면 강제로 끕니다' : '');
  } else if (c.starting) { badge = 'b-warn'; text = '시작 중'; }
  else if (s.inWindow) { badge = 'b-bad'; text = '멈춤'; detail = '지금은 수집 시간입니다. [수집 시작]을 누르면 ' + s.collectWindow[1] + '까지 모읍니다.'; }
  else { const m = s.tasks.find(t => t.name === 'KT-PeterLynch-Morning'); detail = (s.weekend ? '주말' : '수집 시간 밖') + (m && m.next ? ' · 다음 자동 수집 ' + m.next : ''); }
  const notes = [];
  if (!c.running && c.lastLaunch && c.lastLaunch.exit != null)
    notes.push('제어판에서 시작한 수집기(pid ' + c.lastLaunch.pid + ')가 ' + hhmm(c.lastLaunch.exitAt) + '에 끝났습니다(종료 코드 ' + c.lastLaunch.exit + ') — 이유는 아래 수집기 로그를 보세요');
  if (c.orphanLock) notes.push('남은 잠금(pid ' + c.orphanLock.pid + ')이 있지만 그 pid 는 수집기가 아닙니다 — [수집 시작]을 누르면 치우고 시작합니다');
  if (c.lockError) notes.push(c.lockError);
  if (!c.running && c.hiddenNodes) notes.push('명령줄을 확인할 수 없는 node 프로세스가 ' + c.hiddenNodes + '개 있어 제어판에서는 시작하지 않습니다(관리자 권한 프로그램 등)');
  $('cBadge').className = 'badge ' + badge; $('cBadge').textContent = text; $('cDetail').textContent = detail + (notes.length ? ' · ' + notes.join(' · ') : '');
  $('nTrade').textContent = st ? fmt(st.trade) : '-';
  $('nBook').textContent = st ? fmt(st.book) : '-';
  $('nLast').textContent = st && c.running ? st.lastRecvSec + '초 전 (' + st.at + ' 기록)' : (st ? st.at + ' 마지막 기록' : '-');
  $('nSize').textContent = s.today.bytes ? mb(s.today.bytes) : '-';
  $('btnStart').disabled = c.running || c.starting || !s.inWindow;
  $('btnStop').disabled = !c.running || (c.stopRequested && !c.stopStuck);

  $('tasks').innerHTML = s.tasks.map(t => '<tr><td>' + esc(t.label) + '</td><td>' + esc(t.next || '-') + '</td><td>' + esc(t.last || '-')
    + '</td><td>' + ([0, 267009, 267011].includes(t.result) ? esc(t.resultText) : '<span class="up">' + esc(t.resultText) + '</span>') + '</td></tr>').join('')
    || '<tr><td colspan="4" class="muted">작업을 찾지 못했습니다</td></tr>';
  $('sysErr').textContent = s.sysError || '';

  const u = s.subs;
  if (!u) { $('subsInfo').textContent = '오늘은 아직 수집 기록이 없습니다.'; $('subsPicks').innerHTML = ''; $('coreList').innerHTML = ''; $('coreSum').textContent = '거래대금 상위 코어 종목'; }
  else {
    $('subsInfo').textContent = u.startedAtKST.slice(11) + ' 시작 · 체결 ' + u.tradeCount + '종목 · 호가 ' + u.bookCount + '종목'
      + (u.picksFile ? ' · 후보 출처 ' + u.picksFile + ' (' + u.picksBuiltAtKST + ' 고름)' : '') + (u.picksReason ? ' · ' + u.picksReason : '')
      + (u.coreStaleDropped.length ? ' · 묵은 종목 제외 ' + u.coreStaleDropped.join(', ') : '');
    $('subsPicks').innerHTML = u.picks.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.code) + '</td><td>' + esc(p.bucket)
      + '</td><td class="r">' + (p.tickPct != null ? p.tickPct.toFixed(2) + '%' : '-') + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">테마 후보 없음 — 코어만 수집</td></tr>';
    $('coreSum').textContent = '거래대금 상위 코어 종목 ' + u.core.length + '개 보기';
    $('coreList').innerHTML = u.core.map(x => '<span class="chip">' + esc(x.name || x.code) + '</span>').join('');
  }

  const n = s.next;
  $('nextInfo').textContent = !n.target ? '다음 후보를 확인하지 못했습니다' + (n.error ? ' (' + n.error + ')' : '')
    : n.target + ' 수집에 쓸 후보 (' + n.window[0] + ' ~ ' + n.window[1] + ' 사이에 고른 것) · '
    + (n.file ? (n.builtAtKST || n.file) + ' 고름' + (n.counts ? ' · 통과 ' + fmt(n.counts.passed) + ' / 선택 ' + fmt(n.counts.picked) : '') : '아직 없음 — 평일 20:15에 자동으로 고릅니다')
    + (n.error && n.target ? ' · ' + n.error : '') + (n.skipped && n.skipped.length ? ' · 건너뛴 빌드: ' + n.skipped.join(', ') : '');
  $('nextPicks').innerHTML = n.file ? (n.picks || []).map(p => '<tr><td>' + esc(p.name) + ' <span class="muted small">' + esc(p.code) + '</span></td><td>' + esc(p.market)
    + '</td><td class="r">' + fmt(p.price) + '</td><td class="r ' + (p.changeRate > 0 ? 'up' : p.changeRate < 0 ? 'down' : '') + '">' + (p.changeRate != null ? p.changeRate.toFixed(2) + '%' : '-')
    + '</td><td class="r">' + (p.tradeValue != null ? fmt(Math.round(p.tradeValue / 1e8)) : '-') + '</td><td>' + esc(p.bucket) + '</td><td>' + esc((p.themes || []).slice(0, 3).join(', ')) + '</td></tr>').join('')
    || '<tr><td colspan="7" class="muted">조건을 통과한 종목 없음</td></tr>' : '<tr><td colspan="7" class="muted">아직 고르지 않았습니다</td></tr>';
  const b = s.builder;
  $('btnBuild').disabled = b.running || b.buildBlocked;
  $('buildHint').textContent = b.running ? '고르는 중(최대 8분)' : b.buildBlocked ? '장중(' + b.blockWindow[0] + '~' + b.blockWindow[1] + ')에는 고르지 않습니다' : '';

  $('store').innerHTML = s.storage.map(d => '<tr><td>' + esc(d.date) + '</td><td class="r">' + d.files + '</td><td class="r">' + mb(d.bytes) + '</td></tr>').join('')
    || '<tr><td colspan="3" class="muted">없음</td></tr>';
}

async function refresh() {
  let r, j;
  try { r = await fetch('/api/status'); j = await r.json().catch(() => null); }
  catch { $('clock').textContent = '제어판에 연결할 수 없습니다 — 바탕화면이나 시작 메뉴의 "KT 단타 수집기"로 다시 여세요'; return; }
  if (!r.ok || !j) { $('clock').textContent = '상태를 읽지 못했습니다(' + r.status + (j && j.message ? ', ' + j.message : '') + ') — 10초 뒤 다시 시도합니다'; return; }
  try { render(j); }
  catch (e) { $('clock').textContent = '화면을 그리다 오류가 났습니다: ' + e.message; console.error(e); }
}
async function refreshLog() {
  try {
    const r = await fetch('/api/log?name=' + logName); const j = await r.json();
    const pre = $('logText'), atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = j.text || '(비어 있음)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch {}
}

$('btnStart').onclick = async () => {
  $('btnStart').disabled = true; $('cMsg').textContent = '시작하는 중...';
  const r = await post('/api/collector/start'); $('cMsg').textContent = r.message; setTimeout(refresh, 1500);
};
// 중지는 두 번 눌러야 한다(confirm 창 대신). 예전 버전 수집기는 서버가 강제 종료 확인을 한 번 더 요구한다.
let armTimer = 0;
const armStop = (label, ms) => {
  stopArm = Date.now() + ms; $('btnStop').textContent = label;
  clearTimeout(armTimer); armTimer = setTimeout(() => { stopArm = 0; forceArm = false; $('btnStop').textContent = '수집 중지'; }, ms);
};
$('btnStop').onclick = async () => {
  if (Date.now() > stopArm) return armStop('한 번 더 누르면 중지', 5000);
  clearTimeout(armTimer); stopArm = 0; $('btnStop').textContent = '수집 중지'; $('btnStop').disabled = true;
  const r = await post('/api/collector/stop', { force: forceArm });
  $('btnStop').disabled = false;
  if (r.needForce) { forceArm = true; $('cMsg').textContent = r.message; return armStop('한 번 더 누르면 강제 종료', 10000); }
  forceArm = false; $('cMsg').textContent = r.message; setTimeout(refresh, 1500);
};
$('btnBuild').onclick = async () => {
  $('btnBuild').disabled = true; $('bMsg').textContent = '요청하는 중...';
  const r = await post('/api/universe/build'); $('bMsg').textContent = r.message; setTimeout(refresh, 1500);
};
for (const b of document.querySelectorAll('#logTabs button')) b.onclick = () => {
  logName = b.dataset.log;
  for (const x of document.querySelectorAll('#logTabs button')) x.className = x === b ? '' : 'sec';
  refreshLog();
};
refresh(); refreshLog();
setInterval(refresh, 10000); setInterval(refreshLog, 15000);
</script></body></html>`;
