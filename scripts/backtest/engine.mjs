// 백테스트 공용 엔진 — 캐시 로딩 · 시점 스냅샷 · 성과 집계.
//
// harness.mjs(전략 비교)와 measure-conditions.mjs(개별 조건 정보량)가 같은 엔진을
// 쓴다. 두 진입점이 따로 계산하면 같은 신호를 다르게 재는 사태가 생긴다.
//
// 설계 원칙은 harness.mjs 상단 주석과 동일하다:
//  1. 프로덕션 함수를 slice(0, i+1)로 잘라 호출해 미래 참조를 차단한다.
//  2. 진입가는 신호 다음날 시가다.
//  3. 데이터가 없으면 0으로 채우지 않고 제외하며 사유를 센다.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calcMA, calcRSI, calcMACD, calcBollinger, calcIchimoku, calcStochastic,
  calcOBV, detectRSIDivergence, calcWilliamsR, calcADX,
  calcLivermoreScore, calcCandlePatterns, findKeyLevels,
} from '../../analysis.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(HERE, 'cache');
export const COST = 0.21; // 수수료 0.015%×2(매수+매도) + 거래세 0.18% — analysis.js:944와 동일 근거

// 박세익 축 중립 고정값. 과거 시점의 재무제표를 복원할 수 없어 백테스트로는 이 축을
// 재현하지 못한다. 현재 재무를 과거에 적용하면 look-ahead가 되므로 중립 고정이 정직하다.
// 모든 전략에 동일하게 적용되므로 가격·거래량 축의 상대 비교는 유효하다.
export const PSCORE_NEUTRAL = 50;

// ── 스윙 구조 (아직 프로덕션에 없는 조건) ────────────────────────────
// 이효석 서열에서 추세가 1순위인데 현행 시스템에는 추세를 직접 재는 것이 없다.
// 이평 배열은 추세의 대리지표일 뿐이다. 여기서 고점·저점 갱신 구조를 직접 만든다.
//
// 피벗 확정에 우측 lookback이 필요하므로, 시점 i에서 확정된 마지막 피벗은 i-lookback
// 이전 것뿐이다. 이 지연은 실전에서도 똑같이 발생하므로 제거하면 안 된다 — 제거하는
// 순간 미래를 보는 것이 된다.
export function swingStructure(highs, lows, lookback = 5) {
  const n = highs.length;
  const ph = [], pl = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isH = true, isL = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (highs[k] >= highs[i]) isH = false;
      if (lows[k] <= lows[i]) isL = false;
    }
    if (isH) ph.push({ i, v: highs[i] });
    if (isL) pl.push({ i, v: lows[i] });
  }
  if (ph.length < 2 || pl.length < 2) {
    // 표본이 모자라면 false가 아니라 null이다. "구조가 아니다"와 "판정 불가"는 다르다.
    return { higherHigh: null, higherLow: null, uptrend: null, downtrend: null, lastPivotHigh: ph.at(-1)?.v ?? null, lastPivotLow: pl.at(-1)?.v ?? null };
  }
  const higherHigh = ph.at(-1).v > ph.at(-2).v;
  const higherLow  = pl.at(-1).v > pl.at(-2).v;
  return {
    higherHigh, higherLow,
    uptrend:   higherHigh && higherLow,
    downtrend: !higherHigh && !higherLow,
    lastPivotHigh: ph.at(-1).v,
    lastPivotLow:  pl.at(-1).v,
  };
}

// ── 시점 스냅샷 ──────────────────────────────────────────────────────
export function snapshotAt(ctx, i) {
  const { opens, highs, lows, closes, volumes } = ctx;
  const c = closes.slice(0, i + 1);
  if (c.length < 80) return null;   // 스윙 피벗까지 잡으려면 60봉으로는 모자라다
  const h = highs.slice(0, i + 1);
  const l = lows.slice(0, i + 1);
  const o = opens.slice(0, i + 1);
  const v = volumes.slice(0, i + 1);

  const ma5arr  = calcMA(c, 5);
  const ma20arr = calcMA(c, 20);
  const ma60arr = calcMA(c, 60);
  const rsiArr  = calcRSI(c);
  const macd    = calcMACD(c);
  const bb      = calcBollinger(c);

  const ma5 = ma5arr.at(-1), ma20 = ma20arr.at(-1), ma60 = ma60arr.at(-1);
  const rsi = rsiArr.at(-1);
  if (rsi == null || ma20 == null) return null;

  const close = c.at(-1);

  // volRatio: 데이터가 없으면 null이다. server.js:553은 1로 떨어뜨리는데 그러면 거래가
  // 없는 종목이 "정상 거래량"으로 둔갑한다. 크론(cron.js:331)은 null을 쓴다. null을 따른다.
  const lastVols = v.slice(-21, -1);
  const avgVol = lastVols.length ? lastVols.reduce((a, b) => a + b, 0) / lastVols.length : 0;
  const volRatio = avgVol > 0 ? v.at(-1) / avgVol : null;

  const prevClose = c.at(-2);
  const changeRate = prevClose > 0 ? (close - prevClose) / prevClose * 100 : 0;
  const high52w = Math.max(...c.slice(-252));

  // 52주 이력이 실제로 252봉 있는지 본다. 없으면 "최근 3개월 고가"를 52주 고가라고
  // 부르는 셈이라 거의 모든 종목이 신고가 근접으로 잡힌다. cron.js:341-343이 신규
  // 상장주를 두고 같은 이유로 막아둔 지점이며, 백테스트의 앞구간에서도 똑같이 성립한다.
  // 판정 불가는 false가 아니라 null이다 — false로 두면 "신고가가 아니었다"가 된다.
  const w52Full = c.length >= 252;

  // 60일 레인지 내 위치 0~1. 캔들 패턴의 의미는 위치에 따라 뒤집힌다 — 같은 망치형이라도
  // 바닥권이면 반등, 고점권이면 경고다. 레인지가 0이면(정리매매 등) null이다. 0.5로
  // 채우면 "판정 불가"가 "중간"으로 둔갑한다.
  const win60 = { hi: Math.max(...h.slice(-60)), lo: Math.min(...l.slice(-60)) };
  const range60 = win60.hi - win60.lo;
  const location = range60 > 0 ? (close - win60.lo) / range60 : null;

  const swing = swingStructure(h, l);

  // 박스 상단 돌파: 직전 60봉(당일 제외) 최고가를 당일 종가가 넘었는가.
  const prevHigh60 = Math.max(...h.slice(-61, -1));
  const boxBreak = prevHigh60 > 0 && close > prevHigh60;
  const prevLow60 = Math.min(...l.slice(-61, -1));
  const boxBreakDown = prevLow60 > 0 && close < prevLow60;

  // 되돌림: 최근 60봉 저점에서 고점까지 오른 뒤 얼마나 되밀렸는가.
  const retrace = range60 > 0 ? (win60.hi - close) / range60 : null;

  const candlePatterns = calcCandlePatterns(o, h, l, c);

  // 저항선은 findKeyLevels(:110)가 "현재가보다 위"인 것만 모아 만든다. 따라서 같은 시점의
  // resistance와 종가를 비교하면 돌파는 정의상 절대 성립하지 않는다. 돌파를 재려면 어제
  // 시점의 저항선과 오늘 종가를 비교해야 한다.
  const levels = findKeyLevels(c, v);
  const prevLevels = findKeyLevels(c.slice(0, -1), v.slice(0, -1));

  return {
    i, close, ma5, ma20, ma60, rsi, bb,
    // lastCross는 "가장 최근에 일어난 교차의 방향"이지 "오늘 교차했다"가 아니다
    // (analysis.js:25-31이 뒤에서부터 훑어 첫 교차를 찾는다). 그래서 골든 상태가
    // 수십 봉 이어진다 — 발생률이 50%를 넘는 이유다. 당일 발생만 보는 조건을 따로 둔다.
    macdCross: macd.lastCross,
    macdHist: macd.lastHist ?? null,
    macdFreshGolden: (macd.lastHist != null && macd.histArr.at(-2) != null)
      ? (macd.lastHist > 0 && macd.histArr.at(-2) <= 0) : null,
    volRatio, changeRate, location, retrace, swing,
    boxBreak, boxBreakDown,
    isGreen: close >= o.at(-1),
    near52wHigh: !w52Full ? null : (high52w > 0 && close >= high52w * 0.95),
    lScore: calcLivermoreScore(close, ma5, ma20, ma60, rsi, volRatio, changeRate, high52w, macd.lastCross, bb),
    ichimoku: calcIchimoku(h, l, c),
    stochastic: calcStochastic(h, l, c),
    obv: calcOBV(c, v),
    rsiDiv: detectRSIDivergence(c, rsiArr),
    williamsR: calcWilliamsR(h, l, c),
    adx: calcADX(h, l, c),
    candlePatterns,
    levels, prevLevels,
  };
}

// ── 거래 평가 ────────────────────────────────────────────────────────
export function evaluateTrade(ctx, i, horizon) {
  const { opens, lows, closes } = ctx;
  const entryIdx = i + 1;                 // 신호 다음 거래일
  const exitIdx  = entryIdx + horizon - 1;
  if (entryIdx >= closes.length) return { reason: 'no_entry_bar' };
  if (exitIdx  >= closes.length) return { reason: 'no_exit_bar' };

  const entry = opens[entryIdx];
  if (!(entry > 0)) return { reason: 'bad_entry_price' };

  const ret = (closes[exitIdx] - entry) / entry * 100 - COST;

  // MAE(최대 역행): 보유 구간 중 저가 기준 최대 낙폭. 손절선을 어디 두어야 살아남는지를
  // 보여주므로 평균수익률보다 실전 판단에 가깝다.
  let minLow = Infinity;
  for (let k = entryIdx; k <= exitIdx; k++) if (lows[k] < minLow) minLow = lows[k];
  const mae = (minLow - entry) / entry * 100;

  const retCloseEntry = (closes[Math.min(i + horizon, closes.length - 1)] - closes[i]) / closes[i] * 100 - COST;
  return { ret, mae, retCloseEntry };
}

// ── 집계 ─────────────────────────────────────────────────────────────
export const r2 = (v) => v == null || !isFinite(v) ? null : parseFloat(v.toFixed(2));
export const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(rets, maes) {
  if (!rets.length) return null;
  const wins = rets.filter(v => v > 0);
  const gains = wins.reduce((a, b) => a + b, 0);
  const losses = Math.abs(rets.filter(v => v < 0).reduce((a, b) => a + b, 0));
  return {
    count:     rets.length,
    winRate:   Math.round(wins.length / rets.length * 100),
    avgReturn: r2(rets.reduce((a, b) => a + b, 0) / rets.length),
    medReturn: r2(median(rets)),
    profitFactor: losses > 0 ? r2(gains / losses) : null,
    maxWin:    r2(Math.max(...rets)),
    maxLoss:   r2(Math.min(...rets)),
    avgMAE:    maes.length ? r2(maes.reduce((a, b) => a + b, 0) / maes.length) : null,
    worstMAE:  maes.length ? r2(Math.min(...maes)) : null,
  };
}

// ── 캐시 ─────────────────────────────────────────────────────────────
export async function loadCache(maxStocks = 0) {
  let files;
  try {
    files = (await readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    console.error(`캐시가 없습니다: ${CACHE_DIR}\n먼저 실행: npm run backtest:fetch`);
    process.exit(1);
  }
  if (!files.length) {
    console.error('캐시가 비어 있습니다.\n먼저 실행: npm run backtest:fetch');
    process.exit(1);
  }
  if (maxStocks > 0) files = files.slice(0, maxStocks);
  const out = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(CACHE_DIR, f), 'utf8'));
    out.push({
      code: d.code, name: d.name,
      opens:   d.items.map(x => x.o),
      highs:   d.items.map(x => x.h),
      lows:    d.items.map(x => x.l),
      closes:  d.items.map(x => x.c),
      volumes: d.items.map(x => x.v),
      dates:   d.items.map(x => x.d),
    });
  }
  return out;
}

// ── 평가 루프 ────────────────────────────────────────────────────────
// signalFns: { key: (snapshot) => 'BUY' | 'SELL' | 'HOLD' | null }
// null은 "판정 불가"이며 신호로도 비신호로도 세지 않는다.
//
// endOffset: 평가 구간의 끝을 뒤에서 N봉 앞당긴다. 최근 구간에서 조건을 고르고 가중치를
// 맞춘 뒤, 그 과정에서 한 번도 들여다보지 않은 과거 구간으로 검증하기 위한 장치다.
// 같은 창 안에서 앞뒤를 나눈 in/out 분할은, 분할 결과를 보고 설계를 고치는 순간
// 검증력이 사라진다 — 손대지 않은 구간이 따로 있어야 한다.
export function runEvaluation(stocks, signalFns, { window, horizons, splitRatio = 0.7, endOffset = 0 }) {
  const keys = Object.keys(signalFns);
  const acc = {};
  for (const k of keys) {
    acc[k] = { signals: 0, sells: 0, undecided: 0, errors: 0, errorMsg: null, horizons: {}, excluded: {} };
    for (const h of horizons) {
      acc[k].horizons[h] = { all: { r: [], m: [] }, in: { r: [], m: [] }, out: { r: [], m: [] }, closeEntry: [] };
    }
  }

  let evaluated = 0, snapNull = 0;
  for (const st of stocks) {
    // nEnd는 신호를 내는 마지막 시점의 경계일 뿐이다. 거래 평가는 nEnd 이후의 실제
    // 미래봉을 쓴다 — 신호 시점 i는 i 이후를 보지 않으므로 미래 참조가 아니다.
    const nEnd = st.closes.length - endOffset;
    const start = Math.max(80, nEnd - window);
    if (start >= nEnd) continue;
    const splitIdx = start + Math.floor((nEnd - start) * splitRatio);

    for (let i = start; i < nEnd; i++) {
      const snap = snapshotAt(st, i);
      if (!snap) { snapNull++; continue; }
      evaluated++;
      for (const k of keys) {
        let sig;
        // 예외를 조용히 삼키면 망가진 조건이 "신호 0건"으로 보여 정상처럼 지나간다.
        try { sig = signalFns[k](snap); }
        catch (e) { acc[k].errors++; if (!acc[k].errorMsg) acc[k].errorMsg = e.message; continue; }
        if (sig == null) { acc[k].undecided++; continue; }
        if (sig === 'SELL') { acc[k].sells++; continue; }
        if (sig !== 'BUY') continue;
        acc[k].signals++;
        for (const h of horizons) {
          const t = evaluateTrade(st, i, h);
          if (t.reason) { acc[k].excluded[t.reason] = (acc[k].excluded[t.reason] || 0) + 1; continue; }
          const b = acc[k].horizons[h];
          b.all.r.push(t.ret); b.all.m.push(t.mae);
          b.closeEntry.push(t.retCloseEntry);
          const seg = i < splitIdx ? b.in : b.out;
          seg.r.push(t.ret); seg.m.push(t.mae);
        }
      }
    }
  }
  return { acc, evaluated, snapNull };
}

export function buildReport(acc, keys, horizons, labels = {}) {
  const out = {};
  for (const k of keys) {
    const a = acc[k];
    const rep = { label: labels[k] ?? k, signals: a.signals, sells: a.sells, undecided: a.undecided, excluded: a.excluded, horizons: {} };
    for (const h of horizons) {
      const b = a.horizons[h];
      const all = summarize(b.all.r, b.all.m);
      if (!all) { rep.horizons[h] = null; continue; }
      rep.horizons[h] = {
        all,
        inSample:  summarize(b.in.r, b.in.m),
        outSample: summarize(b.out.r, b.out.m),
        avgReturnCloseEntry: b.closeEntry.length ? r2(b.closeEntry.reduce((x, y) => x + y, 0) / b.closeEntry.length) : null,
      };
    }
    out[k] = rep;
  }
  return out;
}
