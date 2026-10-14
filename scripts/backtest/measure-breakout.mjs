// 단타 "순간 진입" 규칙의 분봉 측정.
//
// 질문: 고정 시각 진입(measure-intraday.mjs, intraday-v2-p0.json)은 모든 칸이 비용 전부터 손실이었다.
//       그러면 "당일 고점을 거래량 급증과 함께 돌파하는 순간" 같은 사건에 맞춰 들어가면 비용 후에도 남는가.
//
// 데이터·체결 규칙은 measure-intraday.mjs와 같다(cache-min 1분봉, 라벨 09:01~15:30 정규장, 2023 호가단위).
//
// 사전 고정 규칙 (2026-10-14 측정 전에 고정. 결과를 보고 바꾸지 않는다. 한국 임계값은 전부 [가정]).
//   신호   : 라벨 09:06~14:30 봉의 종가로 판정한다(앞 5개 봉은 시가 범위가 생기는 구간이라 건너뛴다).
//            신호 봉 다음 봉 시가에 1틱 불리하게 매수. 같은 종목·같은 날 포지션이 없을 때만 들어가고,
//            청산된 봉 다음부터 다시 신호를 찾는다(재진입 허용).
//   진입 규칙:
//     B1 고점돌파         : 종가 > 당일 그 이전 모든 봉의 고가
//     B2 고점돌파+급증    : B1 이고 5분 급증 >= 3  <== 주 판정 규칙
//                           5분 급증 = 최근 5분 거래량 / 직전 20거래일 같은 5분 거래량 평균 (measure-intraday V1과 같은 정의)
//     B3 B2+당일RVOL>=2   : B2 이고 당일 누적 RVOL >= 2
//     O1 시가범위돌파      : 09:59 이전, 종가 > 09:01~09:05 고가이고 09:05까지 RVOL >= 2. 하루 첫 돌파 1회만
//                           (Zarattini·Barbon·Aziz 2024의 5분 시가범위 돌파를 한국 분봉에 옮긴 것 [가정])
//     P1 눌림후재돌파      : 종가 > 당일 고점, 그 고점은 10봉 이상 전에 생겼고 그 뒤 고점 대비 1.5% 이상 밀린 적이 있으며
//                           5분 급증 >= 2 (마틴 룩의 "눌림 후 돌파 매수"를 분봉에 옮긴 것 [가정])
//   청산 규칙:
//     X1 +2/-1            : 목표 +2%, 손절 -1% (고정 시각 측정과 같은 칸 — 비교용)
//     X2 VWAP이탈         : 봉 종가가 당일 VWAP 아래면 다음 봉 시가에 1틱 불리하게 매도. 안전 손절 -1.5%  <== 주 판정 청산
//     X3 VWAP이탈+익절3   : X2 에 목표 +3% 추가
//     공통: 손절·목표 체결은 measure-intraday와 같다(손절 우선, 목표는 목표가+1틱 이상 닿아야 체결). 15:20 봉 종가 1틱 불리 강제 청산.
//     VWAP = 당일 누적 (고+저+종)/3 x 거래량 / 누적 거래량 (분봉 근사).
//   v2 추가 (2026-10-14 23:5x, v1 결과를 본 뒤 추가 — 탐색 칸이다. v1 주 판정 B2xX2는 그대로 둔다):
//     v1에서 돌파 진입이 같은 분 무작위 매수보다 나빴다(초과 -0.1~-0.3%). 반대 방향인 "밀린 뒤 반등"을 잰다.
//     M1 VWAP-2%반등      : 직전 봉 종가 <= 직전 봉 VWAP x 0.98 이고 이번 봉 종가 > 직전 봉 고가
//     M2 M1+5분급증>=2    : M1 이고 5분 급증 >= 2
//     X4 VWAP회귀          : 목표 = 신호 봉 VWAP(진입가 +1%보다 낮으면 +1%), 안전 손절 -1.5%  <== v2 주 판정 M1 x X4
//     채택 기준은 v1과 같은 네 가지.
//   대조군: 같은 날 같은 분에 다른 모든 자격 종목을 조건 없이 같은 청산 규칙으로 샀을 때의 평균(자기 자신 제외).
//           초과 = 신호 거래 수익 - 대조군 평균. 시장 요인·시각 요인을 함께 지운다.
//   비용   : 왕복 0 / 0.10 / 0.25 / 0.30 / 0.40 %. 주 판정은 0.25 (거래세 0.20 + 수수료·기타 0.05 [가정], 거래세 [확인 필요]).
//   자격   : 정규장 봉 380개 이상, 직전 20거래일 존재, 시가 갭 ±31% 이내, 종목명에 스팩 없음, 신호 봉 종가 >= --minprice(기본 0).
//   채택 기준(주 판정 칸 B2 x X2 하나로만 판단): 아래 넷을 모두 만족해야 "다음 단계(초 단위 검증) 진행".
//     (1) 비용 0.25 뺀 평균 > 0   (2) 대조군 대비 초과의 95% 신뢰구간 하한 > 0
//     (3) 앞 70% 기간과 뒤 30% 기간 초과가 둘 다 > 0   (4) 뒤 30% 기간의 비용 0.25 뺀 평균 > 0
//
// 해석 시 감안할 것
//   - 1분봉이라 신호 봉이 끝난 뒤 다음 봉 시가에 산다. 실제로는 봉 중간에 돌파를 보고 더 빨리 살 수 있지만
//     그만큼 가짜 돌파도 많다 — 초 단위 체결 기록(ticks/)이 쌓이면 다시 잰다.
//   - VI(변동성 완화장치) 2분 단일가는 모사하지 않는다. 소형주 급등 구간에서 체결이 더 나쁠 수 있다.
//   - 봉 거래량이 작은 종목은 1틱 불리 체결도 낙관적이다. 신호 봉 거래대금 분포를 같이 적는다.
//   - 규칙 7 x 청산 4 = 28칸을 본다. 주 판정 칸 외의 좋은 칸은 우연일 수 있다(탐색용).
//   - M1·M2 x X2·X3 은 VWAP 아래에서 사서 VWAP 이탈로 바로 판다(VWAP 청산 96~98%). 대조군 비교가 성립하지 않으니 보지 않는다.
//
// 결과 (breakout-v2.json, 120종목, 2026-07-14~10-13 60일): 28칸 전부 비용 전부터 손실. 주 판정 둘 다 불채택.
//   B2 x X2 총 -0.61% 초과 -0.23 [-0.33,-0.13] / M1 x X4 총 -0.40% 초과 -0.04 [-0.09,0.03].
//   호가 한 칸 중앙값이 가격의 0.14%라 사고팔 때마다 한 칸씩 내면 비용 0.25 전에 이미 약 0.28%를 잃는다.
//   - 롱만 본다.
//
// 사용:
//   node scripts/backtest/measure-breakout.mjs
//   node scripts/backtest/measure-breakout.mjs --out breakout-v2.json --minprice 0
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN_DIR = path.join(HERE, 'cache-min');
const DAILY_DIR = path.join(HERE, 'cache');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = argOf('out', 'breakout-v2.json');
const MIN_PRICE = parseInt(argOf('minprice', '0'), 10);

const OPEN_LABEL = 9 * 60 + 1;
const SESSION_BARS = 390;
const END_LABEL = OPEN_LABEL + SESSION_BARS - 1;
const EXIT_LABEL = 15 * 60 + 20;
const SIG_FIRST = 9 * 60 + 6;
const SIG_LAST = 14 * 60 + 30;
const ORB_END = 9 * 60 + 5;
const ORB_LAST = 9 * 60 + 59;
const BASE_DAYS = 20;
const MIN_BARS = 380;
const GAP_LIMIT = 0.31;
const FEES = [0, 0.10, 0.25, 0.30, 0.40];
const PRIMARY_FEE = 0.25;
const BOOT = 2000;

const tick = p => p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
const roundUp = p => Math.ceil(p / tick(p)) * tick(p);
const roundDown = p => Math.floor(p / tick(p)) * tick(p);

const RULES = {
  B1: { name: '고점돌파', test: x => x.newHigh },
  B2: { name: '고점돌파+5분급증>=3', test: x => x.newHigh && x.rvol5 >= 3 },
  B3: { name: 'B2+당일RVOL>=2', test: x => x.newHigh && x.rvol5 >= 3 && x.rvol >= 2 },
  O1: { name: '시가범위돌파+RVOL>=2', test: x => x.orb, once: true },
  P1: { name: '눌림후재돌파+급증>=2', test: x => x.pullBreak && x.rvol5 >= 2 },
  M1: { name: 'VWAP-2%반등', test: x => x.dip },
  M2: { name: 'M1+5분급증>=2', test: x => x.dip && x.rvol5 >= 2 },
};
const EXITS = {
  X1: { name: '+2/-1', tp: 0.02, sl: 0.01, vwap: false },
  X2: { name: 'VWAP이탈(손절-1.5)', tp: null, sl: 0.015, vwap: true },
  X3: { name: 'VWAP이탈+익절3', tp: 0.03, sl: 0.015, vwap: true },
  X4: { name: 'VWAP회귀(최소+1,손절-1.5)', tp: null, sl: 0.015, vwap: false, vwapTarget: true },
};
const PRIMARY_CELLS = ['B2|X2', 'M1|X4'];       // v1 주 판정, v2(탐색) 주 판정

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- 1. 적재 (measure-intraday.mjs loadSymbol과 같고, 봉 단위 VWAP을 더한다) ----------
async function loadSymbol(code) {
  const j = JSON.parse(await readFile(path.join(MIN_DIR, `${code}.json`), 'utf8'));
  let name = '';
  try { name = JSON.parse(await readFile(path.join(DAILY_DIR, `${code}.json`), 'utf8')).name ?? ''; } catch { /* 일봉 캐시에 없음 */ }
  const byDate = new Map();
  const auction = new Map();
  for (const [ts, o, h, l, c, v] of j.bars) {
    const min = +ts.slice(11, 13) * 60 + +ts.slice(14, 16);
    if (min > END_LABEL && min <= END_LABEL + 5 && v > 0) {
      const dd = ts.slice(0, 10), cur = auction.get(dd);
      if (!cur || min < cur[0]) auction.set(dd, [min, c]);
      continue;
    }
    if (min < OPEN_LABEL || min > END_LABEL) continue;
    const d = ts.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push({ min, o, h, l, c, v });
  }
  const days = [];
  for (const d of [...byDate.keys()].sort()) {
    const bars = byDate.get(d).sort((a, b) => a.min - b.min);
    if (bars.length < MIN_BARS) continue;
    const cumV = new Float64Array(SESSION_BARS);
    let cv = 0, bi = 0;
    for (let m = 0; m < SESSION_BARS; m++) {
      while (bi < bars.length && bars[bi].min - OPEN_LABEL <= m) { cv += bars[bi].v; bi++; }
      cumV[m] = cv;
    }
    const vwap = new Float64Array(bars.length);
    let pv = 0, vv = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v;
      vwap[i] = vv > 0 ? pv / vv : b.c;
    }
    const firstAt = new Int16Array(SESSION_BARS).fill(-1);  // 분 m 이후 첫 봉 인덱스 (대조군 조회용)
    for (let m = SESSION_BARS - 1, i = bars.length - 1; m >= 0; m--) {
      while (i >= 0 && bars[i].min - OPEN_LABEL >= m) i--;
      firstAt[m] = i + 1 < bars.length ? i + 1 : -1;
    }
    days.push({ date: d, bars, cumV, vwap, firstAt, open: bars[0].o, close: auction.get(d)?.[1] ?? bars.at(-1).c });
  }
  return { code, name, days };
}

// ---------- 2. 청산 시뮬레이션 (체결 규칙은 measure-intraday simulate와 같다) ----------
function simulate(day, s, ex) {
  const bars = day.bars, first = bars[s];
  if (!first || first.min > EXIT_LABEL) return null;
  const entry = first.o + tick(first.o);
  const target = ex.vwapTarget ? Math.max(roundUp(day.vwap[s - 1]), roundUp(entry * 1.01))
    : ex.tp ? roundUp(entry * (1 + ex.tp)) : Infinity;
  const stop = roundDown(entry * (1 - ex.sl));
  let last = null, lastIdx = -1, pending = false;
  for (let i = s; i < bars.length; i++) {
    const b = bars[i];
    if (b.min > EXIT_LABEL) break;
    if (pending) { const px = b.o - tick(b.o); return { ret: (px / entry - 1) * 100, out: 'vwap', exitIdx: i }; }
    last = b; lastIdx = i;
    if (b.l <= stop) { const px = Math.min(stop, b.o) - tick(stop); return { ret: (px / entry - 1) * 100, out: 'stop', exitIdx: i }; }
    if (b.h >= target + tick(target)) return { ret: (target / entry - 1) * 100, out: 'target', exitIdx: i };
    if (ex.vwap && b.c < day.vwap[i]) pending = true;
  }
  if (!last) return null;
  const px = last.c - tick(last.c);
  return { ret: (px / entry - 1) * 100, out: 'eod', exitIdx: lastIdx };
}

// ---------- 3. 종목-일 자격과 특성 ----------
// 자격 통과한 종목-일마다 분 단위 기준선(누적·5분)을 미리 만든다. 전부 전일까지의 정보다.
function prepare(symbols) {
  const sd = [];                                   // { s, day, base, base5 }
  const byDate = new Map();                        // date -> [sd]
  for (const s of symbols) {
    if (/스팩/.test(s.name)) continue;
    for (let di = BASE_DAYS; di < s.days.length; di++) {
      const day = s.days[di], prev = s.days[di - 1];
      if (Math.abs(day.open / prev.close - 1) > GAP_LIMIT) continue;
      const base = new Float64Array(SESSION_BARS), base5 = new Float64Array(SESSION_BARS);
      for (let k = di - BASE_DAYS; k < di; k++) {
        const cv = s.days[k].cumV;
        for (let m = 0; m < SESSION_BARS; m++) { base[m] += cv[m]; if (m >= 5) base5[m] += cv[m] - cv[m - 5]; }
      }
      for (let m = 0; m < SESSION_BARS; m++) { base[m] /= BASE_DAYS; base5[m] /= BASE_DAYS; }
      const row = { s, day, base, base5 };
      sd.push(row);
      if (!byDate.has(day.date)) byDate.set(day.date, []);
      byDate.get(day.date).push(row);
    }
  }
  return { sd, byDate };
}

// 신호 봉 i의 특성. 봉 i 종가 시점까지의 정보만 쓴다.
function features(row, i, st) {
  const { day, base, base5 } = row, b = day.bars[i], m = b.min - OPEN_LABEL;
  const rvol = base[m] > 0 ? day.cumV[m] / base[m] : NaN;
  const rvol5 = base5[m] > 0 ? (day.cumV[m] - day.cumV[m - 5]) / base5[m] : NaN;
  const newHigh = b.c > st.hi;
  const orb = !st.orbDone && b.min <= ORB_LAST && b.c > st.orHigh && st.orRvol >= 2;
  const pullBreak = newHigh && i - st.hiIdx >= 10 && st.lowSinceHi <= st.hi * (1 - 0.015);
  const pb = day.bars[i - 1];
  const dip = pb.c <= day.vwap[i - 1] * 0.98 && b.c > pb.h;
  return { rvol, rvol5, newHigh, orb, pullBreak, dip, price: b.c, turn: b.c * b.v, tickPct: tick(b.c) / b.c * 100 };
}

// ---------- 4. 거래 생성 (규칙 x 청산마다 포지션 상태를 따로 둔다) ----------
function buildTrades(prep) {
  const trades = [];                               // { rule, exit, date, code, min, ret, out, turn }
  for (const row of prep.sd) {
    const { day } = row, bars = day.bars;
    // 09:05까지 시가 범위
    let orHigh = 0, orIdx = -1;
    for (let i = 0; i < bars.length && bars[i].min <= ORB_END; i++) { orHigh = Math.max(orHigh, bars[i].h); orIdx = i; }
    const m5 = ORB_END - OPEN_LABEL;
    const orRvol = row.base[m5] > 0 ? day.cumV[m5] / row.base[m5] : NaN;
    for (const [rk, rule] of Object.entries(RULES)) for (const [xk, ex] of Object.entries(EXITS)) {
      let busyUntil = -1, fired = false;
      // 고점 추적 상태 (봉 i를 보기 직전까지)
      const st = { hi: 0, hiIdx: -1, lowSinceHi: Infinity, orHigh, orRvol, orbDone: orIdx < 0 };
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (b.min >= SIG_FIRST && b.min <= SIG_LAST && i > busyUntil && !(rule.once && fired) && i >= 5) {
          const x = features(row, i, st);
          if (x.price >= MIN_PRICE && rule.test(x)) {
            const r = i + 1 < bars.length ? simulate(day, i + 1, ex) : null;
            if (r) {
              trades.push({ rule: rk, exit: xk, date: day.date, code: row.s.code, min: bars[i + 1].min, ret: r.ret, out: r.out, turn: x.turn, tickPct: x.tickPct });
              busyUntil = r.exitIdx;
              fired = true;
            }
          }
          if (rule.once && x.orb) st.orbDone = true;   // 첫 돌파만 (체결 여부와 무관)
          if (b.min > ORB_LAST) st.orbDone = true;
        }
        // 봉 i를 상태에 반영
        if (b.h > st.hi) { st.hi = b.h; st.hiIdx = i; st.lowSinceHi = Infinity; }
        else st.lowSinceHi = Math.min(st.lowSinceHi, b.l);
      }
    }
  }
  return trades;
}

// ---------- 5. 대조군: 같은 날 같은 분, 다른 모든 자격 종목 무조건 매수 ----------
function controlFactory(prep) {
  const cache = new Map();                          // `${date}|${min}|${xk}` -> Map(code -> ret)
  return (date, min, xk) => {
    const key = `${date}|${min}|${xk}`;
    if (cache.has(key)) return cache.get(key);
    const res = new Map();
    for (const row of prep.byDate.get(date) ?? []) {
      const bars = row.day.bars;
      const s = row.day.firstAt[min - OPEN_LABEL];
      if (s < 1 || bars[s].min > min + 2) continue;               // 그 분 근처에 봉이 없으면 뺀다
      if (bars[s - 1].c < MIN_PRICE) continue;
      const r = simulate(row.day, s, EXITS[xk]);
      if (r) res.set(row.s.code, r.ret);
    }
    cache.set(key, res);
    return res;
  };
}

// ---------- 6. 집계 ----------
function bootMean(rows, key, rng) {                 // 날짜 단위 부트스트랩, rows: { d, [key] }
  const byDay = new Map();
  for (const t of rows) { const o = byDay.get(t.d) ?? { s: 0, n: 0 }; o.s += t[key]; o.n++; byDay.set(t.d, o); }
  const days = [...byDay.values()];
  if (!days.length) return [NaN, NaN];
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < days.length; i++) { const x = days[(rng() * days.length) | 0]; s += x.s; n += x.n; }
    if (n) out.push(s / n);
  }
  out.sort((a, c) => a - c);
  return [out[Math.floor(out.length * 0.025)], out[Math.floor(out.length * 0.975)]];
}

function summarize(trades, prep) {
  const dates = [...prep.byDate.keys()].sort();
  const cut = dates[Math.floor(dates.length * 0.7) - 1];
  const ctl = controlFactory(prep);
  const rng = mulberry32(20261014);
  const out = { testDays: dates.length, splitDate: cut, firstDate: dates[0], lastDate: dates.at(-1), minPrice: MIN_PRICE, cells: {} };
  for (const rk of Object.keys(RULES)) for (const xk of Object.keys(EXITS)) {
    const rows = [];
    for (const t of trades) {
      if (t.rule !== rk || t.exit !== xk) continue;
      const c = ctl(t.date, t.min, xk);
      let sum = 0, n = 0;
      for (const [code, r] of c) if (code !== t.code) { sum += r; n++; }
      rows.push({ d: t.date, r: t.ret, o: t.out, ex: n ? t.ret - sum / n : NaN, min: t.min, turn: t.turn, tickPct: t.tickPct });
    }
    const rowsEx = rows.filter(r => Number.isFinite(r.ex));
    const n = rows.length, gross = mean(rows.map(r => r.r));
    const inR = rows.filter(r => r.d <= cut), outR = rows.filter(r => r.d > cut);
    const cell = {
      rule: RULES[rk].name, exit: EXITS[xk].name, n, nDays: new Set(rows.map(r => r.d)).size,
      perDay: n / dates.length,
      targetPct: n ? rows.filter(r => r.o === 'target').length / n * 100 : NaN,
      stopPct: n ? rows.filter(r => r.o === 'stop').length / n * 100 : NaN,
      vwapPct: n ? rows.filter(r => r.o === 'vwap').length / n * 100 : NaN,
      eodPct: n ? rows.filter(r => r.o === 'eod').length / n * 100 : NaN,
      winPct: n ? rows.filter(r => r.r > 0).length / n * 100 : NaN,
      gross, median: median(rows.map(r => r.r)),
      net: Object.fromEntries(FEES.map(fee => [fee, gross - fee])),
      excess: mean(rowsEx.map(r => r.ex)),
      excessIn: mean(rowsEx.filter(r => r.d <= cut).map(r => r.ex)),
      excessOut: mean(rowsEx.filter(r => r.d > cut).map(r => r.ex)),
      nIn: inR.length, nOut: outR.length,
      grossIn: mean(inR.map(r => r.r)), grossOut: mean(outR.map(r => r.r)),
      turnMedian: median(rows.map(r => r.turn)),
      tickPctMedian: median(rows.map(r => r.tickPct)),          // 호가 한 칸이 가격의 몇 %인지 (왕복 약 2칸을 체결 규칙이 이미 뺀다)
      byTime: {
        '09:07-09:59': mean(rows.filter(r => r.min < 600).map(r => r.r)),
        '10:00-11:59': mean(rows.filter(r => r.min >= 600 && r.min < 720).map(r => r.r)),
        '12:00-14:31': mean(rows.filter(r => r.min >= 720).map(r => r.r)),
      },
      byTimeN: {
        '09:07-09:59': rows.filter(r => r.min < 600).length,
        '10:00-11:59': rows.filter(r => r.min >= 600 && r.min < 720).length,
        '12:00-14:31': rows.filter(r => r.min >= 720).length,
      },
    };
    [cell.grossLo, cell.grossHi] = bootMean(rows, 'r', rng);
    [cell.excessLo, cell.excessHi] = bootMean(rowsEx, 'ex', rng);
    if (PRIMARY_CELLS.includes(`${rk}|${xk}`)) {
      cell.primary = true;
      cell.criteria = {
        netPositive: cell.net[PRIMARY_FEE] > 0,
        excessCiAboveZero: cell.excessLo > 0,
        excessBothHalves: cell.excessIn > 0 && cell.excessOut > 0,
        netOutPositive: cell.grossOut - PRIMARY_FEE > 0,
      };
      cell.adopt = Object.values(cell.criteria).every(Boolean);
    }
    out.cells[`${rk}|${xk}`] = cell;
  }
  return out;
}

// ---------- 7. 실행 ----------
const files = (await readdir(MIN_DIR)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const symbols = [];
for (const c of files) { const s = await loadSymbol(c); if (s.days.length > BASE_DAYS + 2) symbols.push(s); }
console.log(`종목 ${symbols.length}개 적재 (캐시 ${files.length}개 중 일수 부족 제외 ${files.length - symbols.length}개), 가격 하한 ${MIN_PRICE}`);
if (!symbols.length) { console.log('측정할 종목이 없다'); process.exit(1); }
const prep = prepare(symbols);
const trades = buildTrades(prep);
const result = summarize(trades, prep);
await writeFile(path.join(HERE, OUT), JSON.stringify(result, null, 1));

const f2 = x => Number.isFinite(x) ? x.toFixed(2) : '-';
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '-';
console.log(`시험 일수 ${result.testDays} (${result.firstDate} ~ ${result.lastDate}), in/out 분할일 ${result.splitDate}`);
console.log('칸                                   건수 하루  승률  목표% 손절% VWAP% 청산%  총%   [95%CI]        net.25  초과%  [95%CI]        in초과/out초과  out net.25');
for (const [k, c] of Object.entries(result.cells)) {
  const tag = c.primary ? '  <== 주 판정' : '';
  console.log(`${(k + ' ' + c.rule + ' x ' + c.exit).padEnd(36)} ${String(c.n).padStart(5)} ${f1(c.perDay).padStart(4)} ${f1(c.winPct).padStart(5)} ${f1(c.targetPct).padStart(5)} ${f1(c.stopPct).padStart(5)} ${f1(c.vwapPct).padStart(5)} ${f1(c.eodPct).padStart(5)} ${f2(c.gross).padStart(5)} [${f2(c.grossLo)}, ${f2(c.grossHi)}] ${f2(c.net[0.25]).padStart(6)} ${f2(c.excess).padStart(6)} [${f2(c.excessLo)}, ${f2(c.excessHi)}] ${f2(c.excessIn)}/${f2(c.excessOut)}  ${f2(c.grossOut - 0.25)}${tag}`);
}
for (const key of PRIMARY_CELLS) {
  const p = result.cells[key];
  console.log(`\n[${key}] 채택 기준: ${JSON.stringify(p.criteria)} -> ${p.adopt ? '채택(다음 단계 진행)' : '불채택'}`);
  console.log(`[${key}] 시간대별 총%: ${JSON.stringify(Object.fromEntries(Object.entries(p.byTime).map(([k, v]) => [k, `${f2(v)} (${p.byTimeN[k]}건)`])))}`);
  console.log(`[${key}] 신호 봉 거래대금 중앙값 ${Math.round(p.turnMedian / 1e4).toLocaleString()}만원, 호가 한 칸 중앙값 ${f2(p.tickPctMedian)}%`);
}
