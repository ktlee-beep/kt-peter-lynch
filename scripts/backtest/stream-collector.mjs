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
//   종목 선정: (1) 코어 = 일봉 캐시를 직전 20일 평균 거래대금으로 정렬한 상위 --core 개,
//             (2) 소형 슬롯 = universe-builder 최신 산출물(universe/YYYY-MM-DD_HHmm.json)의 picks 전부.
//   체결 = 코어 ∪ picks (중복 제거). 호가 = 남은 용량(200 - 체결 수)을 picks 와 코어에 반씩 (한쪽이 모자라면 다른 쪽이 채움).
//   연결 A = 체결 앞 100건, 연결 B = 체결 나머지 + 호가 (계정당 2연결 x 연결당 100건 = 200건 한도).
//   빌더 산출물이 없거나 읽기 실패면 코어만으로 수집한다(수집을 멈추지 않는다). 최신 산출물이 오늘 빌드가
//   아니면(빌더 실패 등) 어제 테마 목록을 섞지 않고 코어만 쓴다. --universe 로 직접 준 파일은 날짜가 달라도 쓴다.
//   실제 구독 목록과 근거는 ticks/<날짜>/subscriptions-<HHmm>.json 에 남긴다.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGzip, constants as zc } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAILY_DIR = path.join(HERE, 'cache');
const UNIVERSE_DIR = path.join(HERE, 'universe');
const OUT_ROOT = path.join(HERE, 'ticks');
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
async function pickUniverse() {
  const files = (await readdir(DAILY_DIR)).filter(f => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(path.join(DAILY_DIR, f), 'utf8'));
      const it = j.items.slice(-20);
      if (it.length < 10) continue;
      rows.push([j.code, it.reduce((s, x) => s + x.c * x.v, 0) / it.length]);
    } catch { /* 손상 캐시 건너뜀 */ }
  }
  rows.sort((a, b) => b[1] - a[1]);
  return rows.map(r => r[0]);
}

// universe-builder 최신 산출물의 picks (거래대금 내림차순). 구형 산출물(YYYY-MM-DD.json)은 형식이 달라 건너뛴다.
// 자동 선택일 때 오늘(today, KST) 빌드가 아니면 picks 를 쓰지 않는다.
async function loadPicks(today) {
  if (NO_PICKS) return { file: null, picks: [], reason: '--nopicks' };
  try {
    const file = UNIVERSE_FILE ?? path.join(UNIVERSE_DIR,
      (await readdir(UNIVERSE_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(f)).sort().at(-1) ?? '');
    if (!file.endsWith('.json')) return { file: null, picks: [], reason: '빌더 산출물 없음' };
    if (!UNIVERSE_FILE && !path.basename(file).startsWith(today)) {
      return { file, picks: [], reason: `오늘(${today}) 빌드 아님 — ${path.basename(file)} 무시, 코어만` };
    }
    const j = JSON.parse(await readFile(file, 'utf8'));
    const picks = (j.picks ?? []).filter(p => p?.code).sort((a, b) => (b.tradeValue ?? 0) - (a.tradeValue ?? 0));
    return { file, builtAtKST: j.builtAtKST ?? null, picks, reason: picks.length ? null : 'picks 비어 있음' };
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

// ---------- 연결 ----------
const stats = { trade: 0, book: 0, bookSkipped: 0, errors: 0, lastMsg: Date.now() };
const lastBook = new Map();
const num = x => +x;

function handle(frame) {
  if (frame.type === 'message') {
    stats.lastMsg = Date.now();
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
  const open = async () => {
    if (stopping) return;
    let used;
    try {
      if (!token) await ensureToken();
      used = token;
      ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${used}` } });
    } catch (e) { console.log(`${label} 연결 준비 실패: ${e.message}`); setTimeout(open, backoff = Math.min(backoff * 2, 30000)); return; }
    let openedAt = 0;
    ws.onopen = () => { openedAt = Date.now(); ws.send(JSON.stringify(declaration)); console.log(`${label} 연결됨`); ping = setInterval(() => ws.readyState === 1 && ws.send('PING'), 50000); };
    ws.onmessage = e => { try { handle(JSON.parse(String(e.data))); } catch (err) { stats.errors++; } };
    ws.onerror = () => { /* onclose에서 처리 */ };
    ws.onclose = e => {
      clearInterval(ping);
      if (stopping) return;
      // 핸드셰이크 실패 = 토큰 폐기 가능성, 다음 시도에서 재발급. 그 사이 다른 연결이 이미 새로 받았으면 그대로 쓴다.
      if (!openedAt && token === used) token = null;
      // 붙자마자 끊기는 상황(선언 거부 등)이 1초 간격 재접속으로 하루 종일 돌지 않도록, 오래 붙어 있던 연결만 대기를 되돌린다.
      if (openedAt && Date.now() - openedAt >= STABLE_MS) backoff = 1000;
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
const core = (await pickUniverse()).slice(0, N_CORE);
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
if (pk.file && pk.picks.length) console.log(`picks 출처: ${path.basename(pk.file)} (빌드 ${pk.builtAtKST})${UNIVERSE_FILE && !path.basename(pk.file).startsWith(start.date) ? ' — 경고: 오늘 빌드 아님(직접 지정)' : ''}`);

const subsRecord = {
  startedAtKST: `${start.date} ${start.hm}`, from: FROM, until: UNTIL, params: { core: N_CORE, nopicks: NO_PICKS, anyday: ANY_DAY },
  picksFile: pk.file ? path.basename(pk.file) : null, picksBuiltAtKST: pk.builtAtKST ?? null, picksReason: pk.reason,
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

const timer = setInterval(async () => {
  const { date, hm } = kstParts();
  if (date !== sinkDate || sinkBroken) {
    try { await openSinks(date); } catch (e) { stats.errors++; console.log(`저장 파일 다시 열기 실패: ${e.message}`); }
  }
  console.log(`[${date} ${hm}] trade=${stats.trade} book=${stats.book} (표집 제외 ${stats.bookSkipped}) err=${stats.errors} 마지막수신 ${Math.round((Date.now() - stats.lastMsg) / 1000)}초 전`);
  if (hm >= UNTIL) shutdown();
}, 60000);

function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  console.log('종료 시각 도달, 정리');
  conns.forEach(c => c.close());
  for (const s of sinks.values()) s.gz.end();
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
