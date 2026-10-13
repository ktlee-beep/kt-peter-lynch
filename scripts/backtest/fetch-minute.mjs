// 단타 백테스트용 1분봉 수집기 (토스증권 Open API, 읽기 전용 시세 조회만 사용).
//
// 2026-10-13 실호출로 확인한 사실 (삼성전자 005930 기준, 다른 종목은 미확인):
//   GET /api/v1/candles?symbol=&interval=1m|1d&count=1..200&before=<ISO8601>
//   응답 result = { candles: [{timestamp, openPrice, highPrice, lowPrice, closePrice, volume, currency}], nextBefore }
//   최신순 정렬, 문자열 숫자. before 이전 봉을 count개 반환. 1분봉은 2023-06까지 응답, 2022-06에는 0건.
//   대문자 A 접두 심볼(A005930)도 동일 응답. 호출 한도 문서값은 MARKET_DATA_CHART 초당 5~20회로 문서마다 달라
//   [확인 필요] — 보수적으로 초당 4회로 제한하고 429이면 백오프한다.
//
// 사용:
//   node scripts/backtest/fetch-minute.mjs --codes 005930,000660 --days 20
//   node scripts/backtest/fetch-minute.mjs --count 30 --days 60     # 캐시 종목 중 균등 30개
//
// 캐시: scripts/backtest/cache-min/<code>.json = { code, bars: [[ts, o, h, l, c, v], ...] } 오름차순.
// 이미 받은 구간은 합쳐서 중복 제거한다. 인증키는 중앙 저장소(.secrets/api-keys.env)에서만 읽고 출력하지 않는다.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'cache-min');
const DAILY_DIR = path.join(HERE, 'cache');
const ENV_PATH = 'C:/Users/ThinkBook/.secrets/api-keys.env';
const BASE = 'https://openapi.tossinvest.com';
const MIN_GAP_MS = 250;                 // 초당 4회

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS  = parseInt(argOf('days', '20'), 10);
const COUNT = parseInt(argOf('count', '10'), 10);
const CODES = argOf('codes', null);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadKeys() {
  const txt = await readFile(ENV_PATH, 'utf8');
  const get = k => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^['"]|['"]$/g, '');
  const id = get('TOSS_CLIENT_ID'), secret = get('TOSS_CLIENT_SECRET');
  if (!id || !secret) throw new Error('TOSS_CLIENT_ID/SECRET 없음');
  return { id, secret };
}

let token = null, tokenAt = 0, lastCall = 0;
async function getToken(keys) {
  if (token && Date.now() - tokenAt < 3600_000) return token;
  const r = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: keys.id, client_secret: keys.secret }),
  });
  if (!r.ok) throw new Error(`토큰 발급 실패 HTTP ${r.status}`);
  token = (await r.json()).access_token; tokenAt = Date.now();
  return token;
}

async function candlePage(keys, symbol, before) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const q = new URLSearchParams({ symbol, interval: '1m', count: '200' });
    if (before) q.set('before', before);
    const r = await fetch(`${BASE}/api/v1/candles?${q}`, { headers: { Authorization: `Bearer ${await getToken(keys)}` } });
    if (r.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
    if (r.status === 401) { token = null; continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    return (await r.json()).result;
  }
  throw new Error('재시도 초과');
}

async function fetchSymbol(keys, code, days) {
  const cutoff = Date.now() - days * 86400_000;
  const got = new Map();
  let before = null;
  for (let page = 0; page < 2000; page++) {
    const res = await candlePage(keys, code, before);
    const cs = res?.candles ?? [];
    if (!cs.length) break;
    for (const c of cs) got.set(c.timestamp, [c.timestamp, +c.openPrice, +c.highPrice, +c.lowPrice, +c.closePrice, +c.volume]);
    const oldest = cs[cs.length - 1].timestamp;
    if (new Date(oldest).getTime() < cutoff) break;
    before = res.nextBefore ?? oldest;
    if (!before) break;
  }
  return got;
}

async function pickCodes() {
  if (CODES) return CODES.split(',').map(s => s.trim());
  const all = (await readdir(DAILY_DIR)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  const step = all.length / COUNT;
  return Array.from({ length: Math.min(COUNT, all.length) }, (_, i) => all[Math.floor(i * step)]);
}

await mkdir(OUT_DIR, { recursive: true });
const keys = await loadKeys();
const codes = await pickCodes();
let done = 0;
for (const code of codes) {
  const file = path.join(OUT_DIR, `${code}.json`);
  let prior = [];
  try { prior = JSON.parse(await readFile(file, 'utf8')).bars; } catch { /* 신규 */ }
  const merged = new Map(prior.map(b => [b[0], b]));
  try {
    for (const [k, v] of await fetchSymbol(keys, code, DAYS)) merged.set(k, v);
  } catch (e) {
    console.log(`${code} 실패: ${e.message}`);
    continue;
  }
  const bars = [...merged.values()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  await writeFile(file, JSON.stringify({ code, bars }));
  done++;
  console.log(`${code} ${bars.length}봉 (${bars[0]?.[0]} ~ ${bars.at(-1)?.[0]})`);
}
console.log(`완료 ${done}/${codes.length}종목`);
