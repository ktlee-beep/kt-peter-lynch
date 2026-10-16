// 단타 검증용 초단위 체결·호가 수집기 (토스증권 웹소켓, 읽기 전용 시세 구독만 사용. 주문 채널 구독 없음).
//
// 확인된 사실 (2026-10-13 실접속):
//   wss://openapi-ws.tossinvest.com/ws/v1, 헤더 Authorization: Bearer <token>. 계정당 동시연결 2, 연결당 구독 100(채널x종목),
//   선언 5회/초, 수신 180초 무응답 시 종료 -> "PING" 문자열을 60초 간격 송신. 시세 채널은 LOSSY(유실 가능, sequence 없음).
//   trade:kr  data = {price, volume, timestamp(ms ISO), currency}   국내는 KRX+NXT 통합 시세
//   orderbook:kr data = {timestamp, currency, asks[10]{price,volume}, bids[10]{price,volume}}  (삼성전자 기준 초당 약 50건)
//
// 저장: scripts/backtest/ticks/<YYYY-MM-DD>/trade-<HHmmss>.ndjson.gz, book-<HHmmss>.ndjson.gz (파일을 열 때마다 새 파일 —
//   재시작·날짜 변경·저장 오류 뒤 다시 열기). 5초마다 SYNC_FLUSH 하므로 강제 종료된 파일도 끝이 잘린 채로 그 직전까지는
//   읽힌다(끝을 허용하는 리더 필요: zlib 의 finishFlush Z_SYNC_FLUSH).
//   trade 행: [수신ms, 코드, 가격, 수량, 체결ms]
//   book  행: [수신ms, 코드, 호가ms, [매수1가,매수1량,매수2가,..3단계], [매도1가,..3단계], 매수10단계합, 매도10단계합]
//   호가는 종목당 250ms 이내 중복은 버린다(초당 4회 표집). 체결은 전량 저장.
//
// 사용: node scripts/backtest/stream-collector.mjs [--from 07:00] [--until 20:05] [--core 100] [--universe <파일>] [--nopicks] [--anyday] [--dry]
//   --dry: 구독 배분만 출력하고 접속하지 않는다(토큰 발급 없음 — 다른 수집기가 돌 때도 안전).
//   수집 창: 평일 --from ~ --until(KST) 밖에서 시작하면 접속 없이 바로 끝낸다. 작업 스케줄러가 놓친 실행을
//   밤·주말에 뒤늦게 띄워도 빈 접속과 토큰 재발급(같은 키를 쓰는 다른 프로세스의 토큰 폐기)을 만들지 않으려는 것.
//   --anyday 는 주말 검사만 끈다(공휴일은 모른다).
//   종목 선정: (1) 코어 = 일봉 캐시를 직전 20일 평균 거래대금으로 정렬한 상위 --core 개. 마지막 봉이 캐시 전체의
//                 최신 봉보다 STALE_DAYS 넘게 뒤처진 종목(상장폐지·장기 거래정지)은 뺀다.
//             (2) 소형 슬롯 = universe-builder 의 저녁 빌드(universe/YYYY-MM-DD_HHmm.json)의 picks 전부.
//   체결 = 코어 ∪ picks (중복 제거). 호가 = 남은 용량(200 - 체결 수)을 picks 와 코어에 반씩 (한쪽이 모자라면 다른 쪽이 채움).
//   연결 A = 체결 앞 100건, 연결 B = 체결 나머지 + 호가 (계정당 2연결 x 연결당 100건 = 200건 한도).
//   빌더 산출물이 없거나 읽기 실패면 코어만으로 수집한다(수집을 멈추지 않는다). 자동 선택은 [직전 평일 15:40, 오늘 07:00)
//   에 만든 빌드 중 최신 것만 쓴다(아래 loadPicks). 그 창에 빌드가 없으면(저녁 작업 실패 등) 묵은 테마 목록을 섞지 않고
//   코어만 쓴다. --universe 로 직접 준 파일은 창 밖이어도 쓴다(경고만 남김).
//   실제 구독 목록과 근거는 ticks/<날짜>/subscriptions-<HHmm>.json 에 남긴다.
//
// 실행 제어: 시작할 때 scripts/pc/collector.lock 을 잡는다(이미 살아 있는 수집기가 있으면 접속 없이 종료).
//   scripts/pc/collector.stop 파일이 생기면 3초 안에 파일을 닫고 끝낸다(제어판 중지 버튼). 둘 다 gitignored.
import { readFile, readdir, mkdir, writeFile, unlink, appendFile } from 'node:fs/promises';
import { createWriteStream, existsSync, unlinkSync } from 'node:fs';
import { createGzip, constants as zc } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindow, inBuildWindow, BUILD_FILE_RE } from './build-window.mjs';
import { takeLock, releaseLockSync, lockOwner, lockBody } from './run-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAILY_DIR = path.join(HERE, 'cache');
const UNIVERSE_DIR = path.join(HERE, 'universe');
const OUT_ROOT = path.join(HERE, 'ticks');
// 실행 제어 파일(gitignored). 잠금 = 동시 실행 방지, 중지 = 제어판(scripts/pc/panel.mjs)의 정상 종료 요청.
const RUN_DIR = path.join(HERE, '..', 'pc');
const LOCK_FILE = path.join(RUN_DIR, 'collector.lock');
const STOP_FILE = path.join(RUN_DIR, 'collector.stop');
const ENV_PATH = 'C:/Users/ThinkBook/.secrets/api-keys.env';
const BASE = 'https://openapi.tossinvest.com';
const WS_URL = 'wss://openapi-ws.tossinvest.com/ws/v1';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`--${n} 뒤에 값이 없습니다`);
  return v;
};
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;   // 시각은 문자열로 비교하므로 두 자리 고정이어야 한다(9:30 은 거부)
const FROM = argOf('from', '07:00');
const UNTIL = argOf('until', '20:05');
if (!HM_RE.test(FROM) || !HM_RE.test(UNTIL) || FROM >= UNTIL) throw new Error(`--from/--until 은 HH:MM, from < until (받은 값 ${FROM}, ${UNTIL})`);
const N_CORE = Number(argOf('core', '100'));
if (!Number.isInteger(N_CORE) || N_CORE < 1) throw new Error(`--core 는 1 이상 정수 (받은 값 ${N_CORE})`);
const UNIVERSE_FILE = argOf('universe', null);
const NO_PICKS = argv.includes('--nopicks');
const ANY_DAY = argv.includes('--anyday');
const PER_CONN = 100, CAPACITY = 2 * PER_CONN;
const BOOK_MIN_GAP_MS = 250;
const STABLE_MS = 60000;   // 이만큼 붙어 있던 연결이 끊겨야 재접속 대기를 1초로 되돌린다

const kstParts = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, hms: `${p.hour}${p.minute}${p.second}`,
    weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
};

// ---------- 인증 ----------
async function loadKeys() {
  const txt = await readFile(ENV_PATH, 'utf8');
  const get = k => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^['"]|['"]$/g, '');
  const id = get('TOSS_CLIENT_ID'), secret = get('TOSS_CLIENT_SECRET');
  if (!id || !secret) throw new Error('TOSS_CLIENT_ID/SECRET 없음');
  return { id, secret };
}
let keys = null, token = null, tokenInFlight = null;
// 토큰 재발급은 이전 토큰을 폐기시키므로(2026-10-13 확인) 두 연결이 같은 토큰을 공유하고, 접속 실패 때만 갱신한다.
// 두 연결이 동시에 토큰 없음을 보면 발급 요청을 하나로 합친다 — 두 번 발급하면 먼저 받은 쪽 토큰이 바로 폐기된다.
async function ensureToken() {
  tokenInFlight ??= (async () => {
    const r = await fetch(`${BASE}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: keys.id, client_secret: keys.secret }),
    });
    if (!r.ok) throw new Error(`토큰 발급 실패 HTTP ${r.status}`);
    token = (await r.json()).access_token;
    // 발급 횟수가 곧 토큰 폐기 횟수다 — 로그로 셀 수 있게 남긴다(토큰 값은 남기지 않는다).
    console.log(`[${kstParts().hm}] 토큰 발급`);
  })().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

// ---------- 종목 선정 ----------
// 캐시 안 최신 봉보다 이만큼(달력일) 넘게 뒤처진 종목은 코어에서 뺀다. 2026-10-14 에 464680(마지막 봉 06-08)·
// 466910(05-18)이 토스에서 stock-not-found 로 거부돼 구독 2건이 비었다. 오늘 날짜가 아니라 캐시 최신 봉과 비교하는 건
// 캐시 자체가 묵어도(갱신 주기와 무관하게) 전 종목이 빠지지 않게 하려는 것. 연휴는 전 종목이 같이 밀리므로 영향 없다.
const STALE_DAYS = 10;
const ymdMs = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
async function pickUniverse() {
  const files = (await readdir(DAILY_DIR)).filter(f => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(path.join(DAILY_DIR, f), 'utf8'));
      const it = j.items.slice(-20);
      if (it.length < 10 || !/^\d{8}$/.test(it.at(-1).d ?? '')) continue;
      rows.push([j.code, it.reduce((s, x) => s + x.c * x.v, 0) / it.length, it.at(-1).d]);
    } catch { /* 손상 캐시 건너뜀 */ }
  }
  const newest = rows.reduce((m, r) => (r[2] > m ? r[2] : m), '');
  const isStale = r => ymdMs(newest) - ymdMs(r[2]) > STALE_DAYS * 86400e3;
  const live = rows.filter(r => !isStale(r)).sort((a, b) => b[1] - a[1]);
  return { codes: live.map(r => r[0]), newest, stale: rows.filter(isStale).map(r => `${r[0]}(${r[2]})`) };
}

// universe-builder 저녁 빌드의 picks (거래대금 내림차순). 구형 산출물(YYYY-MM-DD.json)은 형식이 달라 건너뛴다.
// 자동 선택 창은 build-window.mjs. 창 안에서 최신 빌드부터 보되 후보가 빈 빌드(장 시작 전에 고른 것 등)는 건너뛴다 —
// 빈 빌드 하나가 전날 저녁의 정상 빌드를 밀어내면 그날은 코어만 수집하게 된다.
async function loadPicks(today) {
  if (NO_PICKS) return { file: null, picks: [], reason: '--nopicks' };
  const read = async file => {
    const j = JSON.parse(await readFile(file, 'utf8'));
    const picks = (j.picks ?? []).filter(p => p?.code).sort((a, b) => (b.tradeValue ?? 0) - (a.tradeValue ?? 0));
    return { file, builtAtKST: j.builtAtKST ?? null, picks };
  };
  try {
    if (UNIVERSE_FILE) {
      const r = await read(UNIVERSE_FILE);
      return { ...r, reason: r.picks.length ? null : 'picks 비어 있음' };
    }
    const names = (await readdir(UNIVERSE_DIR)).filter(f => BUILD_FILE_RE.test(f)).sort();
    if (!names.length) return { file: null, picks: [], reason: '빌더 산출물 없음' };
    const ok = names.filter(f => inBuildWindow(f, today));
    if (!ok.length) {
      const [lo, hi] = buildWindow(today);
      return { file: null, picks: [], reason: `저녁 빌드 없음(${lo}~${hi} 사이 파일 없음, 최신 ${names.at(-1)}) — 코어만` };
    }
    const skipped = [];
    for (const name of ok.reverse()) {
      try {
        const r = await read(path.join(UNIVERSE_DIR, name));
        if (r.picks.length) return { ...r, reason: skipped.length ? `빈·깨진 빌드 건너뜀: ${skipped.join(', ')}` : null };
        skipped.push(`${name}(picks 0)`);
      } catch (e) { skipped.push(`${name}(읽기 실패: ${e.message})`); }
    }
    return { file: null, picks: [], reason: `창 안 빌드 ${ok.length}개 모두 후보 없음: ${skipped.join(', ')} — 코어만` };
  } catch (e) {
    return { file: null, picks: [], reason: `빌더 산출물 읽기 실패: ${e.message}` };
  }
}

// 체결·호가 구독 배분. 체결이 주 데이터(거래량·체결건수 가설, 진입 체결 모사)이고 호가는 스프레드 추정용 표본이다.
function allocate(core, picks) {
  const pickCodes = picks.map(p => p.code);
  const pickSet = new Set(pickCodes);
  const coreOnly = core.filter(c => !pickSet.has(c));
  const trade = [...pickCodes, ...coreOnly].slice(0, CAPACITY);
  let room = CAPACITY - trade.length;
  const book = [];
  let i = 0, j = 0;
  while (room > 0 && (i < pickCodes.length || j < coreOnly.length)) {
    const takePick = i < pickCodes.length && (book.length % 2 === 0 || j >= coreOnly.length);
    book.push(takePick ? pickCodes[i++] : coreOnly[j++]);
    room--;
  }
  return { trade, book };
}

// ---------- 저장 ----------
const sinks = new Map();
let sinkDate = null, sinkBroken = false;
// 디스크 쓰기 오류는 리스너가 없으면 프로세스를 죽인다. 기록만 하고 다음 분 점검에서 파일을 다시 연다.
// 파일은 열 때마다 새 이름(<종류>-<HHmmss>)으로 만든다. 강제 종료로 끝이 잘린 gzip 뒤에 새 멤버를 이어 붙이면
// gunzip 이 잘린 지점에서 "invalid block type"으로 멈춰 그 파일 전체를 못 읽는다(2026-10-13 재현).
async function openSinks(date) {
  for (const s of sinks.values()) s.gz.end();
  sinks.clear();
  const dir = path.join(OUT_ROOT, date);
  await mkdir(dir, { recursive: true });
  const stamp = kstParts().hms;
  for (const name of ['trade', 'book']) {
    const gz = createGzip({ level: 6 });
    const file = createWriteStream(path.join(dir, `${name}-${stamp}.ndjson.gz`), { flags: 'a' });
    const onErr = e => { stats.errors++; sinkBroken = true; console.log(`${name} 저장 오류: ${e.message}`); };
    gz.on('error', onErr);
    file.on('error', onErr);
    gz.pipe(file);
    sinks.set(name, { gz });
  }
  sinkDate = date;
  sinkBroken = false;
}
const write = (name, row) => sinks.get(name).gz.write(JSON.stringify(row) + '\n');
setInterval(() => { for (const s of sinks.values()) s.gz.flush(zc.Z_SYNC_FLUSH); }, 5000);   // 비정상 종료 시 손실 상한 약 5초

// ---------- 공백 기록 ----------
// 정규장(KRX 연속매매 09:00~15:20 KST)과 GAP_MS 넘게 겹치는 연결별 무수신 구간을 로그 [공백] 줄과
// ticks/<날짜>/gaps.ndjson 에 남긴다. 2026-10-15 덮개를 닫아(시스템 로그 Kernel-Power 506 사유 Lid) 09:21~13:54 에
// 아무것도 받지 못했는데 상태 줄은 err=0 이어서 그날 파일 크기를 보고서야 알았다. 덮개·전원 단추 절전은 프로그램이
// 막을 수 없으므로(SetThreadExecutionState 문서) 막는 대신 빠진 구간을 기록한다. 장 전후(NXT)는 체결이 드물어 재지 않는다.
const GAP_MS = 60000, SESSION_MIN = [9 * 60, 15 * 60 + 20], KST_MS = 9 * 3600e3, DAY_MS = 86400e3;
const kstHm = ms => new Date(ms + KST_MS).toISOString().slice(11, 16);
const kstDay = ms => new Date(ms + KST_MS).toISOString().slice(0, 10);
const dayStart = ms => Math.floor((ms + KST_MS) / DAY_MS) * DAY_MS - KST_MS;   // 그날 KST 자정(ms)
const inSession = ms => { const m = Math.floor(((ms + KST_MS) % DAY_MS) / 60e3); return m >= SESSION_MIN[0] && m < SESSION_MIN[1]; };
const lastBy = new Map();      // 연결 이름 -> 마지막 수신 시각
const gapWhy = new Map();      // 연결 이름 -> 지금 이어지는 무수신 동안 생긴 일(연결 실패·끊김·PC 멈춤)
const gapSum = { n: 0, maxSec: 0 };
let timerAt = Date.now();      // 분 점검이 마지막으로 돈 시각. 90초 넘게 밀렸으면 그동안 PC 가 멈춰 있었다.
let sessionDay0 = 0;           // 정규장 중 수신이 있었던 마지막 날의 KST 자정. 그날 첫 수신 전의 무수신은 휴장·늦은 개장일 수 있다.
const noteGap = (label, why) => { if (!gapWhy.has(label)) gapWhy.set(label, new Set()); gapWhy.get(label).add(why); };
// [from, to] 가 평일 정규장과 겹치는 시간(ms). 덮개를 닫은 채 날을 넘길 수 있어 날마다 더한다.
function sessionOverlap(from, to) {
  let ms = 0;
  for (let d0 = dayStart(from); d0 < to; d0 += DAY_MS) {
    const wd = new Date(d0 + KST_MS).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    ms += Math.max(0, Math.min(to, d0 + SESSION_MIN[1] * 60e3) - Math.max(from, d0 + SESSION_MIN[0] * 60e3));
  }
  return ms;
}
function closeGap(label, from, to, tail = '') {
  const why = gapWhy.get(label) ?? new Set();
  gapWhy.delete(label);
  if (to - timerAt > 90000) why.add('PC 멈춤(덮개 닫힘·절전 등)');
  const overlap = sessionOverlap(from, to);
  if (overlap < GAP_MS) return;
  // 연결도 멀쩡했고 그날 정규장 수신이 아직 한 건도 없었다면 끊김이 아니라 장이 안 열린 것일 수 있다.
  const quiet = sessionDay0 !== dayStart(to) ?'정규장 수신 0건(휴장일·늦은 개장이 아니면 구독 이상)' : '수신 없음(연결은 유지)';
  const sec = Math.round((to - from) / 1000), sessionSec = Math.round(overlap / 1000), reason = ([...why].join(', ') || quiet) + tail;
  gapSum.n++; gapSum.maxSec = Math.max(gapSum.maxSec, sessionSec);
  console.log(`[공백] ${label} ${kstHm(from)}~${kstHm(to)} 장중 ${Math.round(sessionSec / 60)}분(전체 ${sec}초) — ${reason}`);
  // 부가 기록이다 — 저장에 실패해도 수집은 계속한다. 날짜 폴더는 from 기준.
  appendFile(path.join(OUT_ROOT, kstDay(from), 'gaps.ndjson'), JSON.stringify({ conn: label, from, to, sec, sessionSec, reason }) + '\n')
    .catch(e => { stats.errors++; console.log(`공백 기록 저장 실패: ${e.message}`); });
}

// ---------- 연결 ----------
const stats = { trade: 0, book: 0, bookSkipped: 0, errors: 0, lastMsg: Date.now() };
const lastBook = new Map();
const num = x => +x;

function handle(frame, label) {
  if (frame.type === 'message') {
    stats.lastMsg = Date.now();
    const prev = lastBy.get(label) ?? stats.lastMsg;
    lastBy.set(label, stats.lastMsg);
    if (stats.lastMsg - prev >= GAP_MS) closeGap(label, prev, stats.lastMsg);
    else if (gapWhy.has(label)) gapWhy.delete(label);
    // 메시지마다 도는 줄이라 산술만 쓴다. 그날 정규장 첫 수신 뒤에는 첫 비교에서 바로 빠진다.
    if (stats.lastMsg - sessionDay0 >= DAY_MS && inSession(stats.lastMsg)) sessionDay0 = dayStart(stats.lastMsg);
    const [ch, , code] = frame.topic.split(':');
    const d = frame.data, recv = Date.now();
    if (ch === 'trade') { write('trade', [recv, code, num(d.price), num(d.volume), Date.parse(d.timestamp)]); stats.trade++; }
    else if (ch === 'orderbook') {
      if (recv - (lastBook.get(code) ?? 0) < BOOK_MIN_GAP_MS) { stats.bookSkipped++; return; }
      lastBook.set(code, recv);
      const lv = a => a.slice(0, 3).flatMap(x => [num(x.price), num(x.volume)]);
      const sum = a => a.reduce((s, x) => s + num(x.volume), 0);
      write('book', [recv, code, Date.parse(d.timestamp), lv(d.bids), lv(d.asks), sum(d.bids), sum(d.asks)]);
      stats.book++;
    }
  } else if (frame.type === 'error') { stats.errors++; console.log('error 프레임:', JSON.stringify(frame.error)); }
  else if (frame.type === 'subscriptions') {
    const sub = Array.isArray(frame.subscribed) ? frame.subscribed : null, rej = Array.isArray(frame.rejected) ? frame.rejected : null;
    if (!sub || !rej) { console.log('구독 응답 형식 예상과 다름:', JSON.stringify(frame).slice(0, 500)); return; }
    console.log(`구독 확정 ${sub.length}건, 거부 ${rej.length}건`, rej.length ? JSON.stringify(rej.slice(0, 30)) : '');
  }
}

let stopping = false;
function connect(label, declaration) {
  let backoff = 1000, ws = null, ping = null;
  // 첫 수신 전부터 재야 시작부터 붙지 못한 구간(2026-10-15 08:50~ 토큰 403)도 공백으로 잡힌다.
  lastBy.set(label, Date.now());
  const open = async () => {
    if (stopping) return;
    let used;
    try {
      if (!token) await ensureToken();
      used = token;
      ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${used}` } });
    } catch (e) {
      // 연결을 못 여는 것도 오류로 센다 — 2026-10-15 토큰 403 이 30분 반복되는 동안 상태 줄은 err=0 이었다.
      stats.errors++; noteGap(label, `연결 준비 실패(${e.message})`);
      console.log(`${label} 연결 준비 실패: ${e.message}`); setTimeout(open, backoff = Math.min(backoff * 2, 30000)); return;
    }
    let openedAt = 0;
    ws.onopen = () => { openedAt = Date.now(); ws.send(JSON.stringify(declaration)); console.log(`${label} 연결됨`); ping = setInterval(() => ws.readyState === 1 && ws.send('PING'), 50000); };
    ws.onmessage = e => { try { handle(JSON.parse(String(e.data)), label); } catch (err) { stats.errors++; } };
    ws.onerror = () => { /* onclose에서 처리 */ };
    ws.onclose = e => {
      clearInterval(ping);
      if (stopping) return;
      // 핸드셰이크 실패 = 토큰 폐기 가능성, 다음 시도에서 재발급. 그 사이 다른 연결이 이미 새로 받았으면 그대로 쓴다.
      if (!openedAt && token === used) token = null;
      // 붙자마자 끊기는 상황(선언 거부 등)이 1초 간격 재접속으로 하루 종일 돌지 않도록, 오래 붙어 있던 연결만 대기를 되돌린다.
      if (openedAt && Date.now() - openedAt >= STABLE_MS) backoff = 1000;
      if (!openedAt) stats.errors++;   // 접속 거부(토큰 폐기 등)도 err 로 센다 — 연결 준비 실패와 같은 취급
      noteGap(label, openedAt ? `연결 끊김(code ${e.code})` : `접속 거부(code ${e.code})`);
      console.log(`${label} 종료 code=${e.code}, ${backoff}ms 후 재연결`);
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  };
  open();
  return { close: () => { try { ws?.close(); } catch { /* 무시 */ } } };
}

// ---------- 실행 ----------
const start = kstParts();
const uni = await pickUniverse();
const core = uni.codes.slice(0, N_CORE);
if (uni.stale.length) console.log(`코어 제외(마지막 봉이 캐시 최신 ${uni.newest}보다 ${STALE_DAYS}일 넘게 묵음): ${uni.stale.join(', ')}`);
// 캐시가 깨져 종목이 모자란 경우를 잡는다. --core 를 20 미만으로 준 시험 실행은 그 개수를 기준으로 본다.
if (core.length < Math.min(20, N_CORE)) throw new Error(`코어 종목 선정 실패(${core.length}개 / 요청 ${N_CORE})`);
const pk = await loadPicks(start.date);
const { trade, book: bookCodes } = allocate(core, pk.picks);
const A = trade.slice(0, PER_CONN);
const rest = trade.slice(PER_CONN);
const declB = [{ type: 'trade:kr', codes: rest }, { type: 'orderbook:kr', codes: bookCodes }].filter(x => x.codes.length);
if (rest.length + bookCodes.length > PER_CONN) throw new Error(`연결 B 구독 ${rest.length + bookCodes.length}건 > ${PER_CONN}`);
const pickSet = new Set(pk.picks.map(p => p.code));
const bookPicks = bookCodes.filter(c => pickSet.has(c)).length;
console.log(`코어 ${core.length} + picks ${pk.picks.length}${pk.reason ? ` (${pk.reason})` : ''} → 체결 ${trade.length}(고유 ${new Set(trade).size})`
  + ` / 호가 ${bookCodes.length}(picks ${bookPicks}, 코어 ${bookCodes.length - bookPicks})`
  + ` / A: 체결 ${A.length} / B: 체결 ${rest.length} + 호가 ${bookCodes.length} / 종료 ${UNTIL} KST`);
if (pk.file && pk.picks.length) console.log(`picks 출처: ${path.basename(pk.file)} (빌드 ${pk.builtAtKST})${UNIVERSE_FILE && !inBuildWindow(path.basename(pk.file), start.date) ? ' — 경고: 저녁 빌드 창 밖(직접 지정)' : ''}`);

const subsRecord = {
  startedAtKST: `${start.date} ${start.hm}`, from: FROM, until: UNTIL, params: { core: N_CORE, nopicks: NO_PICKS, anyday: ANY_DAY },
  picksFile: pk.file ? path.basename(pk.file) : null, picksBuiltAtKST: pk.builtAtKST ?? null, picksReason: pk.reason,
  coreCacheNewest: uni.newest, coreStaleDropped: uni.stale,
  core, picks: pk.picks.map(p => ({ code: p.code, name: p.name, bucket: p.bucket, tradeValue: p.tradeValue, tickPct: p.tickPct })),
  trade, book: bookCodes, connA: A, connB: { trade: rest, book: bookCodes },
};
if (argv.includes('--dry')) {
  console.log(JSON.stringify({ ...subsRecord, core: core.length, picks: pk.picks.length }, null, 1).slice(0, 1500));
  process.exit(0);
}

// 수집 창 밖이면 토큰 발급·접속 전에 끝낸다(위 사용법 주석).
if (start.weekend && !ANY_DAY) { console.log(`[${start.date} ${start.hm}] 주말 — 수집하지 않고 종료 (--anyday 로 무시 가능)`); process.exit(0); }
if (start.hm < FROM || start.hm >= UNTIL) { console.log(`[${start.date} ${start.hm}] 수집 창(${FROM}~${UNTIL} KST) 밖 — 접속하지 않고 종료`); process.exit(0); }

// 동시 실행 방지(run-lock.mjs). 토큰 발급 전에 잡는다.
const lock = await takeLock(LOCK_FILE, { date: start.date, startedAtKST: `${start.date} ${start.hm}` });
for (const h of lock.removed) console.log(`묵은 잠금 제거(pid ${h.pid ?? '?'}, ${h.startedAtKST})`);
if (!lock.ok) {
  console.log(`[${start.date} ${start.hm}] ${lock.lost ? '다른 수집기와 동시에 시작해 물러남' : '이미 실행 중'}(pid ${lock.held.pid}, 시작 ${lock.held.startedAtKST}) — 접속하지 않고 종료`);
  process.exit(0);
}
process.on('exit', () => releaseLockSync(LOCK_FILE));
// 남아 있던 중지 요청은 지난 실행 몫이다
await unlink(STOP_FILE).catch(() => {});

keys = await loadKeys();
await openSinks(start.date);
// 구독 기록은 부가 기록이다 — 저장에 실패해도 수집은 시작한다.
try {
  await writeFile(path.join(OUT_ROOT, start.date, `subscriptions-${start.hm.replace(':', '')}.json`), JSON.stringify(subsRecord, null, 1));
} catch (e) { console.log(`구독 기록 저장 실패(수집은 계속): ${e.message}`); }
const conns = [
  connect('연결A', [{ id: 'A' }, { type: 'trade:kr', codes: A }]),
  connect('연결B', [{ id: 'B' }, ...declB]),
];

timerAt = Date.now();
const timer = setInterval(async () => {
  const { date, hm } = kstParts();
  // 60초 점검이 90초 넘게 밀렸으면 그동안 PC 가 멈춰 있었다(덮개 닫힘·절전). 그 사이 모든 연결이 못 받았다.
  const now = Date.now();
  if (now - timerAt > 90000) {
    console.log(`[멈춤] ${kstHm(timerAt)}~${kstHm(now)} ${Math.round((now - timerAt) / 60000)}분 동안 PC가 멈춰 있었음(덮개 닫힘·절전 등) — 그동안 수집도 멈춤`);
    // 깨어난 뒤 이미 받아서 공백을 마감한 연결에는 달지 않는다(묵은 사유가 다음 공백에 섞이지 않게).
    for (const [l, t] of lastBy) if (t <= timerAt) noteGap(l, 'PC 멈춤(덮개 닫힘·절전 등)');
  }
  timerAt = now;
  // 다른 연결이 받고 있으면 마지막수신은 0초라 한 연결만 끊긴 것이 안 보인다 — 장중 진행 중인 무수신을 따로 적는다.
  const live = inSession(now) ? [...lastBy].filter(([, t]) => now - t >= GAP_MS).map(([l, t]) => `${l} ${Math.round((now - t) / 60000)}분`) : [];
  if (date !== sinkDate || sinkBroken) {
    try { await openSinks(date); } catch (e) { stats.errors++; console.log(`저장 파일 다시 열기 실패: ${e.message}`); }
  }
  // 끝의 공백 표시는 제어판 STATS_RE(끝 고정 없음) 뒤에 붙는다 — 공백이 없으면 예전 형식 그대로다.
  console.log(`[${date} ${hm}] trade=${stats.trade} book=${stats.book} (표집 제외 ${stats.bookSkipped}) err=${stats.errors} 마지막수신 ${Math.round((Date.now() - stats.lastMsg) / 1000)}초 전`
    + (gapSum.n ? ` · 공백 ${gapSum.n}회(장중 최대 ${Math.round(gapSum.maxSec / 60)}분)` : '')
    + (live.length ? ` · 무수신 진행 중 ${live.join(', ')}` : ''));
  if (hm >= UNTIL) return shutdown('종료 시각 도달');
  // 잠금을 다른 수집기가 가져갔으면 물러난다(둘이 뜨면 서로의 토큰을 폐기한다). 누가 지웠으면 다시 잡는다.
  const owner = await lockOwner(LOCK_FILE);
  if (owner === 'other') shutdown('잠금을 다른 수집기가 가져가 물러남');
  else if (owner === 'missing' && !stopping) {
    await writeFile(LOCK_FILE, lockBody({ date: start.date, startedAtKST: `${start.date} ${start.hm}` }), { flag: 'wx' })
      .then(() => console.log('잠금이 없어져 다시 잡음'), () => {});
  }
}, 60000);
// 제어판(scripts/pc/panel.mjs)의 중지 버튼은 STOP_FILE 을 만든다. 프로세스를 죽이지 않고 파일을 닫고 끝내려는 것.
const stopWatch = setInterval(() => {
  if (!existsSync(STOP_FILE)) return;
  try { unlinkSync(STOP_FILE); } catch { /* 무시 */ }
  shutdown('중지 요청(제어판)');
}, 3000);

function shutdown(reason) {
  if (stopping) return;
  stopping = true; clearInterval(timer); clearInterval(stopWatch);
  // 끝날 때까지 이어진 무수신(정규장 중 끊긴 채 종료)도 남긴다.
  const now = Date.now();
  for (const [l, t] of lastBy) if (now - t >= GAP_MS) closeGap(l, t, now, ' — 종료 시점까지 이어짐');
  console.log(`[${kstParts().date} ${kstParts().hm}] ${reason}, 정리 — trade=${stats.trade} book=${stats.book} err=${stats.errors}`
    + (gapSum.n ? ` 공백 ${gapSum.n}회(장중 최대 ${Math.round(gapSum.maxSec / 60)}분)` : ''));
  conns.forEach(c => c.close());
  for (const s of sinks.values()) s.gz.end();
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
