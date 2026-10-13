// 단타 종목선정 후보의 분봉 측정 (RESEARCH-단타종목선정-종합.md 7절).
//
// 질문: 진입 시각에 종목선정 조건을 만족한 종목이, 조건을 따지지 않은 같은 시각의 모든 종목보다
//       "목표가가 손절가보다 먼저 닿고 15:20에 강제 청산하는 단타"에서 비용 후 더 나은가.
//
// 데이터: cache-min/<code>.json (토스증권 1분봉, fetch-minute.mjs). 봉 타임스탬프는 봉 종료 시각 라벨로 읽는다
//   (첫 봉이 08:01, 마지막이 20:00, 하루 720개 — 2026-10-13 삼성전자로 확인). 정규장은 라벨 09:01~15:30(390개)만 쓴다.
//   08:00~09:00과 15:30~20:00은 NXT 시간대라 뺀다. 봉 거래량이 KRX 단독인지 합산인지는 [확인 필요] — RVOL은
//   같은 종목의 같은 시각 과거 값과의 비율이라 정의가 일관되면 상쇄된다.
//
// 사전 고정 규칙 (측정 결과를 보고 바꾸지 않는다. 임계값 출처는 RESEARCH 문서의 해당 항목, 한국 값은 [가정]).
//   진입   : 신호 봉(라벨 T)의 다음 봉 시가에 1틱 불리하게 매수. T는 0916/0931/1001 세 가지, 주 판정은 0931.
//   목표/손절 : 진입가 기준 (+2%, -1%)이 주, (+1%, -1%)와 (+3%, -1.5%)는 민감도. 호가단위로 올림/내림.
//   체결   : 손절은 봉 저가가 손절가 이하이면 min(손절가, 봉 시가) 1틱 아래. 목표는 봉 고가가 목표가+1틱 이상일 때
//            목표가 체결(터치만으로는 체결 안 된다고 본다). 같은 봉에서 둘 다 닿으면 손절이 먼저.
//   강제 청산 : 라벨 15:20 봉 종가(종가 단일가 15:20~15:30 회피)에서 1틱 불리.
//   비용   : 수수료·세금 왕복 합 0 / 0.10 / 0.25 / 0.40 %를 수익률에서 뺀다. 거래세 확정 수치는 [확인 필요]라서 값을 여러 개 둔다.
//            호가단위 슬리피지는 위 체결 규칙에 이미 들어 있으므로 별도로 더하지 않는다.
//   자격   : 정규장 봉 380개 이상인 날, 직전 20거래일 같은 시각 누적거래량 평균이 있는 날, 신호 시점 종가 5,000원 이상,
//            종목명에 스팩 없음, 전일 종가 대비 시가 갭 ±31% 이내(미조정 주가 급변 제거), 레짐 계산 가능한 날.
//   선정 조건(변형):
//     A1 RVOL>=2, A2 RVOL>=5 : RVOL = 당일 신호 시각까지 누적 거래량 / 직전 20거래일 같은 시각 누적 거래량 평균
//     B  거래대금 상위 20%   : 신호 시각까지 누적 거래대금(종가x거래량)의 당일 유니버스 내 순위 상위 20%
//     C1 갭>=+3%, C2 갭 +5~+10% : 갭 = 당일 시가 / 전일 정규장 종가 - 1
//     E  ATR14/종가 >=3%     : 직전 14거래일 일봉(분봉에서 합산) TR 평균 / 전일 종가
//     F  레짐 양호           : 유니버스 동일가중 지수의 전일 종가 > 직전 20일 이동평균 (코스닥 20일선의 대용 [가정])
//     AB, AC, AE            : A1과 B/C1/E의 교집합
//   대조군 '무조건'은 자격만 통과하면 모두 진입. 초과수익 = 변형 평균 - 무조건 평균.
//
// 해석 시 감안할 것
//   - 유니버스는 일봉 캐시 122종목 중 균등 추출한 종목이다. 단타 후보로 자주 오르는 소형 급등주가 빠져 있을 수 있다.
//   - 같은 날 종목들은 시장 요인을 공유하므로 신뢰구간은 날짜 단위 부트스트랩(2000회, 시드 고정)으로 구한다.
//   - 변형 11개 x 진입 3 x 청산 3 = 99칸을 보므로 우연히 좋아 보이는 칸이 나온다. 주 판정 칸(0931, +2/-1)만 채택 근거로 쓴다.
//   - VI 발동 구간의 2분 단일가 체결은 모사하지 않는다. 봉이 비는 날은 380개 미만이면 자격에서 빠진다.
//   - 롱만 본다. 개인 공매도 제약이 있어서 숏은 대상이 아니다.
//
// 사용:
//   node scripts/backtest/measure-intraday.mjs
//   node scripts/backtest/measure-intraday.mjs --out intraday-v1.json
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN_DIR = path.join(HERE, 'cache-min');
const DAILY_DIR = path.join(HERE, 'cache');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = argOf('out', 'intraday-v1.json');
const MIN_CROSS = parseInt(argOf('minx', '10'), 10);   // 순위를 매길 최소 종목 수. 시험 실행용으로만 낮춘다.

const OPEN_LABEL = 9 * 60 + 1;          // 라벨 09:01 = 인덱스 0
const SESSION_BARS = 390;               // 09:01 ~ 15:30
const EXIT_LABEL = 15 * 60 + 20;        // 15:20 봉 종가에서 강제 청산
const BASE_DAYS = 20;
const ATR_DAYS = 14;
const MIN_BARS = 380;
const MIN_PRICE = parseInt(argOf('minprice', '5000'), 10);   // 5000은 하네스 초기 임의값(근거 없음). 가격 구간별 비교는 --minprice 1000 재측정으로 확인
const GAP_LIMIT = 0.31;
const ENTRY_TIMES = [['0916', 9 * 60 + 16], ['0931', 9 * 60 + 31], ['1001', 10 * 60 + 1]];
const PRIMARY_ENTRY = '0931';
const EXITS = [['+2/-1', 0.02, 0.01], ['+1/-1', 0.01, 0.01], ['+3/-1.5', 0.03, 0.015]];
const PRIMARY_EXIT = '+2/-1';
const FEES = [0, 0.10, 0.25, 0.30, 0.40];     // 왕복 수수료·세금 %, 거래세 [확인 필요]
const BOOT = 2000;

// 2023 통합 호가단위 (한국투자증권 안내, 경계값 귀속 [확인 필요])
const tick = p => p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
const roundUp = p => Math.ceil(p / tick(p)) * tick(p);
const roundDown = p => Math.floor(p / tick(p)) * tick(p);

const VARIANTS = {
  '무조건':            () => true,
  'A1_RVOL>=2':        f => f.rvol >= 2,
  'A2_RVOL>=5':        f => f.rvol >= 5,
  'B_거래대금상위20%': f => f.turnPct <= 0.2,
  'C1_갭>=3%':         f => f.gap >= 0.03,
  'C2_갭5~10%':        f => f.gap >= 0.05 && f.gap < 0.10,
  'E_ATR>=3%':         f => f.atrPct >= 0.03,
  'F_레짐양호':        f => f.regimeOk,
  'AB_A1+B':           f => f.rvol >= 2 && f.turnPct <= 0.2,
  'AC_A1+C1':          f => f.rvol >= 2 && f.gap >= 0.03,
  'AE_A1+E':           f => f.rvol >= 2 && f.atrPct >= 0.03,
  // 거래량 심화 (2026-10-13 사전 고정, 측정 전)
  'V1_급증5분>=3':     f => f.rvol5 >= 3,
  'V2_급증+미상승':    f => f.rvol5 >= 3 && f.ret5 < 0.01,
  'V3_급증+기상승':    f => f.rvol5 >= 3 && f.ret5 >= 0.01,
  'V4_RVOL2+고점':     f => f.rvol >= 2 && f.atHigh,
  'V5_RVOL2+제자리':   f => f.rvol >= 2 && Math.abs(f.retOpen) < 0.005,
};

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- 1. 적재: 종목별 일자별 정규장 봉 ----------
async function loadSymbol(code) {
  const j = JSON.parse(await readFile(path.join(MIN_DIR, `${code}.json`), 'utf8'));
  let name = '';
  try { name = JSON.parse(await readFile(path.join(DAILY_DIR, `${code}.json`), 'utf8')).name ?? ''; } catch { /* 일봉 캐시에 없음 */ }
  const byDate = new Map();
  const auction = new Map();                                // date -> [min, 종가 단일가 종가] (라벨 15:31~15:35, 거래량>0 첫 봉)
  const END_LABEL = OPEN_LABEL + SESSION_BARS - 1;
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
    const cumV = new Float64Array(SESSION_BARS), cumT = new Float64Array(SESSION_BARS);
    let cv = 0, ct = 0, bi = 0;
    for (let m = 0; m < SESSION_BARS; m++) {
      while (bi < bars.length && bars[bi].min - OPEN_LABEL <= m) { cv += bars[bi].v; ct += bars[bi].c * bars[bi].v; bi++; }
      cumV[m] = cv; cumT[m] = ct;
    }
    days.push({
      date: d, bars, cumV, cumT, open: bars[0].o, close: auction.get(d)?.[1] ?? bars.at(-1).c,
      high: Math.max(...bars.map(b => b.h)), low: Math.min(...bars.map(b => b.l)),
    });
  }
  return { code, name, days };
}

// ---------- 2. 유니버스 동일가중 지수와 레짐 ----------
function buildRegime(symbols) {
  const rets = new Map();
  for (const s of symbols) for (let i = 1; i < s.days.length; i++) {
    const r = s.days[i].close / s.days[i - 1].close - 1;
    if (Math.abs(r) > 0.31) continue;                      // 미조정 급변 제외
    const d = s.days[i].date;
    if (!rets.has(d)) rets.set(d, []);
    rets.get(d).push(r);
  }
  const dates = [...rets.keys()].sort();
  const level = new Map(), ok = new Map();
  let L = 100; const hist = [];
  for (const d of dates) {
    L *= 1 + mean(rets.get(d)); level.set(d, L); hist.push([d, L]);
    if (hist.length >= BASE_DAYS) ok.set(d, L > mean(hist.slice(-BASE_DAYS).map(x => x[1])));
  }
  return { dates, ok };
}

// ---------- 3. 단일 거래 시뮬레이션 ----------
function simulate(bars, startIdx, tp, sl) {
  const first = bars[startIdx];
  if (!first) return null;
  const entry = first.o + tick(first.o);
  const target = roundUp(entry * (1 + tp)), stop = roundDown(entry * (1 - sl));
  let last = null;
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    if (b.min > EXIT_LABEL) break;
    last = b;
    if (b.l <= stop) { const px = Math.min(stop, b.o) - tick(stop); return { ret: (px / entry - 1) * 100, out: 'stop' }; }
    if (b.h >= target + tick(target)) return { ret: (target / entry - 1) * 100, out: 'target' };
  }
  if (!last) return null;
  const px = last.c - tick(last.c);
  return { ret: (px / entry - 1) * 100, out: 'eod' };
}

// ---------- 4. 거래 생성 ----------
function buildTrades(symbols, regime) {
  const trades = [];
  // 날짜별 누적 거래대금 횡단면 (순위용)
  const cross = new Map();                                   // date -> Map(code -> cumT)
  for (const s of symbols) for (const d of s.days) {
    if (!cross.has(d.date)) cross.set(d.date, new Map());
    cross.get(d.date).set(s.code, d.cumT);
  }
  for (const s of symbols) {
    if (/스팩/.test(s.name)) continue;
    for (let di = BASE_DAYS; di < s.days.length; di++) {
      const day = s.days[di], prev = s.days[di - 1];
      const regimePrev = regime.ok.get(prev.date);
      if (regimePrev === undefined) continue;
      const gap = day.open / prev.close - 1;
      if (Math.abs(gap) > GAP_LIMIT) continue;
      // ATR14 (전일까지)
      if (di < ATR_DAYS + 1) continue;
      let trSum = 0, jump = false;
      for (let k = di - ATR_DAYS; k < di; k++) {
        const pd = s.days[k - 1], d = s.days[k];
        if (Math.abs(d.close / pd.close - 1) > GAP_LIMIT) jump = true;   // 미조정 급변(분할 등) 창 제외
        trSum += Math.max(d.high - d.low, Math.abs(d.high - pd.close), Math.abs(d.low - pd.close));
      }
      if (jump) continue;
      const atrPct = trSum / ATR_DAYS / prev.close;
      for (const [etag, elabel] of ENTRY_TIMES) {
        const m = elabel - OPEN_LABEL;
        const startIdx = day.bars.findIndex(b => b.min > elabel);
        if (startIdx < 0) continue;
        const sigPrice = day.bars[startIdx - 1]?.c;
        if (!sigPrice || sigPrice < MIN_PRICE) continue;
        let base = 0;
        for (let k = di - BASE_DAYS; k < di; k++) base += s.days[k].cumV[m];
        base /= BASE_DAYS;
        if (!(base > 0)) continue;
        const rvol = day.cumV[m] / base;
        if (!Number.isFinite(rvol)) continue;
        // 거래대금 순위 백분율 (1에 가까울수록 하위)
        const row = cross.get(day.date);
        let better = 0, n = 0;
        for (const t of row.values()) { n++; if (t[m] > day.cumT[m]) better++; }
        if (n < MIN_CROSS) continue;
        const turnPct = (better + 1) / n;
        // 거래량 심화 특성 (2026-10-13 추가). 전부 신호 봉(라벨 elabel)까지의 정보만 쓴다.
        let base5 = 0;
        for (let k = di - BASE_DAYS; k < di; k++) base5 += s.days[k].cumV[m] - s.days[k].cumV[m - 5];
        base5 /= BASE_DAYS;
        const rvol5 = base5 > 0 ? (day.cumV[m] - day.cumV[m - 5]) / base5 : NaN;      // 최근 5분 거래량 / 과거 같은 5분 평균
        const ref = day.bars[startIdx - 6];
        const ret5 = ref ? sigPrice / ref.c - 1 : NaN;                                  // 최근 5분 가격 변화
        const retOpen = sigPrice / day.open - 1;                                        // 시가 대비
        let hiSoFar = 0;
        for (let i = 0; i < startIdx; i++) hiSoFar = Math.max(hiSoFar, day.bars[i].h);
        const atHigh = sigPrice >= hiSoFar * 0.998;                                     // 당일 고점 부근
        const f = { rvol, rvol5, ret5, retOpen, atHigh, turnPct, gap, atrPct, regimeOk: regimePrev };
        const res = {};
        for (const [xtag, tp, sl] of EXITS) {
          const r = simulate(day.bars, startIdx, tp, sl);
          if (r) res[xtag] = r;
        }
        if (Object.keys(res).length !== EXITS.length) continue;
        trades.push({ date: day.date, code: s.code, etag, f, res });
      }
    }
  }
  return trades;
}

// ---------- 5. 집계 ----------
function bootDiff(sel, all, rng) {
  const byDay = new Map();
  const add = (list, key) => { for (const t of list) { const o = byDay.get(t.d) ?? { sS: 0, nS: 0, sA: 0, nA: 0 }; o[key === 's' ? 'sS' : 'sA'] += t.r; o[key === 's' ? 'nS' : 'nA']++; byDay.set(t.d, o); } };
  add(sel, 's'); add(all, 'a');
  const days = [...byDay.values()];
  const diffs = [];
  for (let b = 0; b < BOOT; b++) {
    let sS = 0, nS = 0, sA = 0, nA = 0;
    for (let i = 0; i < days.length; i++) { const x = days[(rng() * days.length) | 0]; sS += x.sS; nS += x.nS; sA += x.sA; nA += x.nA; }
    if (nA) diffs.push((nS ? sS / nS : 0) - sA / nA);      // 선정군 0건 재표본은 버리지 않고 0 기여로 집계
  }
  diffs.sort((a, c) => a - c);
  if (!diffs.length) return [NaN, NaN];
  return [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.floor(diffs.length * 0.975)]];
}

function summarize(trades) {
  const dates = [...new Set(trades.map(t => t.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.7) - 1];
  const out = { testDays: dates.length, splitDate: cut, cells: {} };
  const rng = mulberry32(20261013);
  for (const [etag] of ENTRY_TIMES) for (const [xtag] of EXITS) {
    const pool = trades.filter(t => t.etag === etag);
    const key = `${etag}|${xtag}`;
    const ctl = pool.map(t => ({ d: t.date, r: t.res[xtag].ret }));
    out.cells[key] = {};
    for (const [vname, pred] of Object.entries(VARIANTS)) {
      const sel = pool.filter(t => pred(t.f));
      const rows = sel.map(t => ({ d: t.date, r: t.res[xtag].ret, o: t.res[xtag].out }));
      const n = rows.length;
      const gross = mean(rows.map(r => r.r));
      const cell = {
        n, nDays: new Set(rows.map(r => r.d)).size,
        targetPct: n ? rows.filter(r => r.o === 'target').length / n * 100 : NaN,
        stopPct: n ? rows.filter(r => r.o === 'stop').length / n * 100 : NaN,
        eodPct: n ? rows.filter(r => r.o === 'eod').length / n * 100 : NaN,
        gross, median: median(rows.map(r => r.r)),
        net: Object.fromEntries(FEES.map(fee => [fee, gross - fee])),
      };
      if (vname !== '무조건') {
        cell.excess = gross - mean(ctl.map(r => r.r));
        [cell.excessLo, cell.excessHi] = n ? bootDiff(rows, ctl, rng) : [NaN, NaN];
        const inC = ctl.filter(r => r.d <= cut), outC = ctl.filter(r => r.d > cut);
        const inS = rows.filter(r => r.d <= cut), outS = rows.filter(r => r.d > cut);
        cell.excessIn = inS.length ? mean(inS.map(r => r.r)) - mean(inC.map(r => r.r)) : NaN;
        cell.excessOut = outS.length ? mean(outS.map(r => r.r)) - mean(outC.map(r => r.r)) : NaN;
        cell.nIn = inS.length; cell.nOut = outS.length;
      }
      out.cells[key][vname] = cell;
    }
  }
  return out;
}

// ---------- 6. 실행 ----------
const files = (await readdir(MIN_DIR)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const symbols = [];
for (const c of files) { const s = await loadSymbol(c); if (s.days.length > BASE_DAYS + 2) symbols.push(s); }
console.log(`종목 ${symbols.length}개 적재 (캐시 ${files.length}개 중 일수 부족 제외 ${files.length - symbols.length}개)`);
if (!symbols.length) { console.log('측정할 종목이 없다'); process.exit(1); }
const regime = buildRegime(symbols);
const trades = buildTrades(symbols, regime);
const result = summarize(trades);
await writeFile(path.join(HERE, OUT), JSON.stringify(result, null, 1));

const f2 = x => Number.isFinite(x) ? x.toFixed(2) : '  - ';
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : ' - ';
console.log(`거래 ${trades.length}건, 시험 일수 ${result.testDays}, in/out 분할일 ${result.splitDate}`);
for (const [etag] of ENTRY_TIMES) for (const [xtag] of EXITS) {
  const key = `${etag}|${xtag}`, tag = (etag === PRIMARY_ENTRY && xtag === PRIMARY_EXIT) ? '  <== 주 판정 칸' : '';
  console.log(`\n[진입 ${etag}  목표/손절 ${xtag}]${tag}`);
  console.log('변형                 건수  일수  목표%  손절%  청산%   총%   net.10 net.25 net.30 net.40  초과%  [95%CI]            in/out 초과');
  for (const [v, c] of Object.entries(result.cells[key])) {
    const ex = c.excess === undefined ? '    -  ' : `${f2(c.excess).padStart(6)}  [${f2(c.excessLo)}, ${f2(c.excessHi)}]`.padEnd(26);
    const io = c.excess === undefined ? '' : `${f2(c.excessIn)} (${c.nIn}) / ${f2(c.excessOut)} (${c.nOut})`;
    console.log(`${v.padEnd(20)} ${String(c.n).padStart(5)} ${String(c.nDays).padStart(5)} ${f1(c.targetPct).padStart(6)} ${f1(c.stopPct).padStart(6)} ${f1(c.eodPct).padStart(6)} ${f2(c.gross).padStart(6)} ${f2(c.net[0.1]).padStart(6)} ${f2(c.net[0.25]).padStart(6)} ${f2(c.net[0.3]).padStart(6)} ${f2(c.net[0.4]).padStart(6)}  ${ex} ${io}`);
  }
}
