// 실시간 매매 화면 서버 — node scripts/pc/trader/server.mjs [--port 4790] [--replay 2026-10-16 --from 09:00 --speed 5] [--live] [--no-open]
// 이 PC 안(127.0.0.1)에서만 열린다. 주문은 전부 모의(종이) 주문이다. 실주문은 사용자 승인 전까지 코드에 없다.
// 브라우저에는 SSE(/events)로 0.2초마다 시세·호가·새 체결·봉을, 1초마다 종목 목록·잔고·상태를 보낸다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Engine, kstToday, defaultTicksDir } from './engine.mjs';
import { OrderError } from './paper-broker.mjs';
import { Market } from './market.mjs';
import { Ledger } from './ledger.mjs';
import { summary as learnSummary } from './learn-book.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(argOf('port', '4790'));
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}/`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const IDLE_MS = 30 * 60 * 1000;
const PAGE_FILE = path.join(HERE, 'trade.html');

// ---------- 종목 이름 ----------
const names = new Map();
try {
  const { KRX_STOCKS } = await import(pathToFileURL(path.join(ROOT, 'krx_stocks.js')).href);
  for (const s of KRX_STOCKS ?? []) names.set(s.code, s.name);
} catch (e) { console.log(`종목 이름 목록을 못 읽음(코드로 표시): ${e.message}`); }
try {
  const dir = path.join(ROOT, 'scripts', 'backtest', 'universe');
  const last = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(f)).sort().at(-1);
  if (last) for (const p of JSON.parse(fs.readFileSync(path.join(dir, last), 'utf8')).picks ?? []) if (p.code && p.name) names.set(p.code, p.name);
} catch { /* 후보 파일이 없어도 된다 */ }
const nm = code => names.get(code) ?? code;

// ---------- 엔진 ----------
const engine = new Engine({ ticksDir: defaultTicksDir(ROOT), feedUrl: argOf('feed', 'http://127.0.0.1:4791/feed') });
const notes = [];
engine.on('note', m => { notes.push({ at: Date.now(), msg: m }); if (notes.length > 50) notes.shift(); console.log(m); });
// 매매 장부 — 세션마다 scripts/pc/trader/ledger/<id>.json (git 제외)
const ledger = new Ledger(argOf('ledger', path.join(HERE, 'ledger')), { name: nm });
engine.on('session', (s, broker) => ledger.begin(s, broker));
process.on('exit', () => ledger.flush(true));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => process.exit(0));

function kstNow() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { day: d.getUTCDay(), hm: d.toISOString().slice(11, 16) };
}
const liveStart = opts => engine.startLive(opts).catch(e => engine.emit('note', `실시간 시작 오류: ${e.message}`));
function startDefault() {
  if (argv.includes('--live')) return liveStart();
  const date = argOf('replay', null);
  const k = kstNow();
  if (!date && k.day >= 1 && k.day <= 5 && k.hm >= '08:50' && k.hm < '20:05') return liveStart();
  const dates = engine.dates();
  const d = date ?? dates.at(-1);
  if (!d) { console.log('재생할 기록이 없습니다(scripts/backtest/ticks). 실시간으로 시작합니다.'); return liveStart(); }
  engine.startReplay({ date: d, from: argOf('from', '09:00'), speed: Number(argOf('speed', '1')) });
}

// ---------- 브라우저로 보내는 내용 ----------
const book = s => ({ bids: s.bids, asks: s.asks, bidSum: s.bidSum, askSum: s.askSum, at: s.bookAt });
const sum = s => ({ ...engine.market.summary(s), name: nm(s.code) });
function initFor(code) {
  const s = engine.market.sym.get(code);
  if (!s) return { code, name: nm(code), gen: engine.gen, empty: true };
  return { code, name: nm(code), gen: engine.gen, sec: s.sec.slice(-7200), min: s.min, trades: s.trades.slice(-100), tradeSeq: s.tradeSeq, book: book(s), sum: sum(s) };
}
function list() {
  const rows = [];
  for (const s of engine.market.sym.values()) if (s.last) rows.push(s);
  rows.sort((a, b) => b.value - a.value);
  return rows.slice(0, 250).map(s => ({ code: s.code, name: nm(s.code), last: s.last, chgOpen: s.open ? Math.round((s.last - s.open) / s.open * 10000) / 100 : 0,
    value: s.value, strength: Market.strength(s), book: s.bids.length > 0, held: engine.broker.pos.get(s.code)?.qty ?? 0 }));
}
function acct() {
  const a = engine.broker.snapshot();
  for (const k of ['positions', 'open', 'done', 'fills', 'trips']) for (const x of a[k]) x.name = nm(x.code);
  a.risk = engine.risk.usage(engine.broker);
  return a;
}
function auto() {
  const st = engine.strategy;
  const stt = st.stats();
  return { ...stt, total: stt.rounds, log: st.log.slice(-120).reverse().map(l => ({ ...l, name: nm(l.code) })),
    rounds: st.rounds.slice(-100).reverse().map(r => ({ ...r, name: nm(r.code) })) };
}
function status() { return { ...engine.status(), notes: notes.slice(-5), port: PORT, ledgerId: ledger.cur?.id ?? null }; }

const clients = new Set();
function sse(res, ev, data) { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 끊긴 창 */ } }
function sendInit(c) { const i = initFor(c.code); c.seq = i.tradeSeq ?? 0; c.gen = engine.gen; c.bookAt = -1; sse(c.res, 'init', i); }

setInterval(() => {
  for (const c of clients) {
    if (c.res.writableLength > 4 << 20) { c.res.destroy(); clients.delete(c); continue; }
    if (c.gen !== engine.gen) { sendInit(c); continue; }
    const s = engine.market.sym.get(c.code);
    if (!s) { sse(c.res, 'tick', { code: c.code, now: engine.now() }); continue; }
    if (s.tradeSeq === c.seq && s.bookAt === c.bookAt) { sse(c.res, 'tick', { code: c.code, now: engine.now() }); continue; }
    const n = Math.min(s.tradeSeq - c.seq, s.trades.length);
    const out = { code: c.code, now: engine.now(), sum: sum(s), book: book(s), trades: n > 0 ? s.trades.slice(-n) : [],
      sec: s.sec.slice(-2), min: s.min.slice(-2) };
    c.seq = s.tradeSeq; c.bookAt = s.bookAt;
    sse(c.res, 'tick', out);
  }
}, 200).unref();
setInterval(() => {
  if (!clients.size) return;
  const l = list(), a = acct(), st = status(), au = auto();
  for (const c of clients) { sse(c.res, 'list', l); sse(c.res, 'acct', a); sse(c.res, 'status', st); sse(c.res, 'auto', au); }
}, 1000).unref();

// ---------- 서버 ----------
let lastReq = Date.now();
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
const code6 = v => (/^\d{6}$/.test(String(v ?? '')) ? String(v) : null);

async function post(p, j) {
  switch (p) {
    case '/api/order': {
      const o = engine.order({ code: code6(j.code), side: j.side, type: j.type, price: j.price == null ? null : Number(j.price), qty: Number(j.qty) });
      const verb = o.side === 'buy' ? '매수' : '매도';
      const msg = o.status === 'filled' ? `${verb} 체결 ${o.filled}주 평균 ${Math.round(o.avgFill).toLocaleString()}원`
        : o.status === 'open' ? `${verb} 주문 접수${o.filled ? `(${o.filled}주 즉시 체결)` : ''} — 대기열 앞 ${o.queue == null || !Number.isFinite(o.queue) ? '알 수 없음' : o.queue.toLocaleString() + '주'}`
        : `${verb} 주문 ${o.status}`;
      return [200, { message: msg, id: o.id, status: o.status }];
    }
    case '/api/cancel': engine.cancel(j.id); return [200, { message: '취소했습니다' }];
    case '/api/cancel-all': return [200, { message: `미체결 ${engine.cancelAll()}건 취소` }];
    case '/api/halt': engine.halt('수동 전체 정지'); return [200, { message: '전체 정지 — 미체결 취소, 자동매매 꺼짐. 보유분은 그대로입니다' }];
    case '/api/resume': engine.resume(); return [200, { message: '재개했습니다(자동매매는 꺼진 상태)' }];
    case '/api/flatten': {
      const r = engine.flatten(code6(j.code));
      if (!r.length) return [200, { message: '팔 보유 종목이 없습니다' }];
      const bad = r.filter(x => !x.ok);
      return [200, { message: `${r.length - bad.length}종목 시장가 청산${bad.length ? `, ${bad.length}종목 실패: ${bad.map(x => `${nm(x.code)} ${x.message}`).join(' / ')}` : ''}` }];
    }
    case '/api/replay': {
      const speed = Number(j.speed ?? 1);
      if (![1, 5, 20, 60, 300].includes(speed)) return [400, { message: '배속은 1·5·20·60·300 중 하나입니다' }];
      const r = engine.startReplay({ date: String(j.date ?? ''), from: String(j.from ?? '09:00'), speed, auto: !!j.auto });
      return [200, { message: `${r.date} ${r.from}부터 ${r.speed}배속 재생(모의 장부 새로 시작)` }];
    }
    case '/api/replay/pause':
      if (!engine.replay) return [400, { message: '재생 중이 아닙니다' }];
      if (j.paused) engine.replay.pause(); else engine.replay.play();
      return [200, { message: j.paused ? '일시정지' : '재생' }];
    case '/api/replay/speed': {
      const speed = Number(j.speed);
      if (!engine.replay) return [400, { message: '재생 중이 아닙니다' }];
      if (![1, 5, 20, 60, 300].includes(speed)) return [400, { message: '배속은 1·5·20·60·300 중 하나입니다' }];
      engine.replay.setSpeed(speed); return [200, { message: `${speed}배속` }];
    }
    case '/api/live': liveStart({ auto: !!j.auto }); return [200, { message: '실시간 연결을 시작합니다(오늘 기록을 먼저 읽습니다)' }];
    case '/api/auto': engine.setAuto(!!j.on); return [200, { message: j.on ? '자동매매 켬(모의 주문)' : '자동매매 끔(진행 중인 판은 마저 정리)' }];
    default: return [404, { message: '없음' }];
  }
}

const server = http.createServer(async (req, res) => {
  lastReq = Date.now();
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, { message: 'host 거부' });
    const url = new URL(req.url, BASE_URL);
    if (req.method === 'GET') {
      if (url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE_FILE, 'utf8'), 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP });
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/api/ping') return send(res, 200, { app: 'kt-trader' });
      if (url.pathname === '/api/dates') return send(res, 200, { dates: engine.dates(), today: kstToday() });
      if (url.pathname === '/api/ledger') return send(res, 200, { sessions: ledger.list(), current: ledger.cur?.id ?? null });
      if (url.pathname === '/api/learn') return send(res, 200, learnSummary());
      if (url.pathname === '/api/trips.csv') {
        const all = url.searchParams.get('all') === '1', id = url.searchParams.get('id') ?? ledger.cur?.id;
        if (!all && !Ledger.validId(id)) return send(res, 400, { message: '세션 id 형식' });
        return send(res, 200, ledger.csv({ id, all }), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="kt-trips-${all ? 'all' : id}.csv"` });
      }
      if (url.pathname === '/events') {
        const code = code6(url.searchParams.get('code')) ?? list()[0]?.code ?? '005930';
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const c = { res, code, seq: 0, gen: -1, bookAt: -1 };
        clients.add(c);
        sendInit(c);
        sse(res, 'list', list()); sse(res, 'acct', acct()); sse(res, 'status', status()); sse(res, 'auto', auto());
        const drop = () => clients.delete(c);
        req.on('close', drop); res.on('error', drop);
        return;
      }
      return send(res, 404, { message: '없음' });
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (req.headers['x-kt-trader'] !== '1' || (origin && !ALLOWED_ORIGINS.has(origin))) return send(res, 403, { message: '요청 거부' });
      let body = '';
      for await (const ch of req) { body += ch; if (body.length > 10000) return send(res, 413, { message: '너무 큼' }); }
      let j;
      try { j = body ? JSON.parse(body) : {}; } catch { return send(res, 400, { message: 'JSON 형식이 아닙니다' }); }
      if (typeof j !== 'object' || j === null || Array.isArray(j)) return send(res, 400, { message: '요청 형식' });
      const r = await post(url.pathname, j);
      return send(res, r[0], r[1]);
    }
    return send(res, 405, { message: '메서드' });
  } catch (e) {
    if (e instanceof OrderError) return send(res, 400, { message: e.message });
    if (res.headersSent) { try { res.end(); } catch {} return; }
    return send(res, e.message?.startsWith('기록이 없는') || e.message?.startsWith('시작 시각') || e.message?.startsWith('전체 정지') ? 400 : 500, { message: e.message });
  }
});
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') { console.error(e); process.exit(1); }
  try {
    const r = await fetch(`${BASE_URL}api/ping`, { signal: AbortSignal.timeout(3000) });
    if ((await r.json()).app === 'kt-trader') { console.log(`매매 화면이 이미 떠 있습니다: ${BASE_URL}`); openBrowser(); return setTimeout(() => process.exit(0), 500); }
  } catch { /* 다른 프로그램 */ }
  console.error(`포트 ${PORT}를 다른 프로그램이 쓰고 있습니다. --port 로 다른 번호를 주세요.`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`KT 매매 화면(모의 주문): ${BASE_URL}`);
  startDefault();
  openBrowser();
});
// 창이 하나도 없고 30분 동안 요청이 없으면 끈다. 실시간 자동매매를 켜 둔 동안은 끄지 않는다.
setInterval(() => {
  if (clients.size || Date.now() - lastReq < IDLE_MS) return;
  if (engine.mode === 'live' && engine.strategy.enabled) return;
  console.log('30분 동안 화면이 없어 끕니다.'); process.exit(0);
}, 60000).unref();

function openBrowser() {
  if (argv.includes('--no-open')) return;
  const fail = e => console.error(`창을 열지 못했습니다: ${e.message}`);
  const tab = () => {
    try { spawn('rundll32.exe', ['url.dll,FileProtocolHandler', BASE_URL], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', fail).unref(); }
    catch (e) { fail(e); }
  };
  const edge = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']
    .map(k => process.env[k] && path.join(process.env[k], 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(p => p && fs.existsSync(p));
  if (!edge || argv.includes('--tab')) return tab();
  try { spawn(edge, [`--app=${BASE_URL}`, '--window-size=1560,960'], { detached: true, stdio: 'ignore' }).on('error', tab).unref(); }
  catch { tab(); }
}
