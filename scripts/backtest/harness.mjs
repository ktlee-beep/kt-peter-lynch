// 신호 백테스트 하네스 (오프라인 전용).
//
// 왜 신설인가: 기존 analysis.js의 runBacktestMulti는 (a) 지표를 자체 재구현해 돌므로
// 프로덕션 신호 로직을 측정하지 않고, (b) combinedSignal을 호출조차 하지 않으며,
// (c) 보유기간이 5·10일뿐이고, (d) 산출물 소비처가 0건이다. 확장할 대상이 아니라
// 측정 계기를 따로 세우는 것이 맞다.
//
// 설계 원칙
//  1. 프로덕션 함수를 그대로 호출한다. 지표를 재구현하지 않는다. 시점 i를 평가할 때는
//     배열을 slice(0, i+1)로 잘라 넘겨 미래 데이터 참조를 원천 차단한다. 느리지만
//     "측정 대상이 실제 코드와 같다"는 보장이 속도보다 중요하다.
//  2. 진입가는 신호 다음날 시가가 기본이다. 신호는 종가가 확정돼야 나오므로 당일 종가로
//     체결하는 것은 불가능하다. 기존 runBacktestMulti(:945)는 당일 종가로 계산해
//     구조적 낙관 편향이 있었다. 참고용으로 종가 진입도 함께 낸다.
//  3. 데이터가 없으면 0이 아니라 제외하고 사유를 센다. 이 프로젝트의 null 보존 원칙을
//     집계 단계에서도 지킨다 — 미래봉이 모자란 신호를 수익 0으로 채우면 승률이 희석된다.
//
// 사용:
//   node scripts/backtest/fetch-ohlcv.mjs          # 먼저 캐시 생성
//   node scripts/backtest/harness.mjs
//   node scripts/backtest/harness.mjs --window 400 --strategies combined_v1
//   node scripts/backtest/harness.mjs --out baseline.json
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calcMA, calcRSI, calcMACD, calcBollinger, calcIchimoku, calcStochastic,
  calcOBV, detectRSIDivergence, calcWilliamsR, calcADX,
  calcLivermoreScore, calcCandlePatterns, combinedSignal,
} from '../../analysis.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'cache');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const WINDOW    = parseInt(argOf('window', '300'), 10);   // 각 종목에서 평가할 최근 봉 수
const MAX_STOCK = parseInt(argOf('stocks', '0'), 10);     // 0 = 전부
const HORIZONS  = argOf('horizons', '5,10,20,60').split(',').map(Number);
const OUT_FILE  = argOf('out', null);
const COST      = 0.21; // 수수료 0.015%×2(매수+매도) + 거래세 0.18% — analysis.js:944와 동일 근거

// ── 전략 레지스트리 ──────────────────────────────────────────────────
// 전략은 스냅샷 하나를 받아 'BUY' | 'SELL' | 'HOLD'를 낸다. 스냅샷은 시점별로 한 번만
// 계산해 모든 전략이 공유한다.
const STRATEGIES = {
  // 현행 온디맨드 신호 엔진. analysis.js:164 combinedSignal을 실제로 호출한다.
  // pScore(박세익 축)는 백테스트로 재현할 수 없다 — 과거 시점의 재무제표를 복원하지
  // 못하므로 현재 재무를 과거에 적용하면 look-ahead가 된다. 그래서 중립값으로 고정하고
  // 가격·거래량 축의 변화만 비교한다. Phase 1이 건드리는 것도 그 축이다.
  combined_v1: {
    label: '현행 combinedSignal (12조건 flat, BUY>=4)',
    run: (s) => combinedSignal(
      s.lScore, PSCORE_NEUTRAL, s.macdCross, s.bb,
      {
        ichimoku: s.ichimoku, stochastic: s.stochastic, obv: s.obv,
        candlePatterns: s.candlePatterns, rsiDivergence: s.rsiDiv, williamsR: s.williamsR,
      },
      s.adx,
    ).signal,
  },

  // 현행 야간 스캔 엔진의 재현본. cron.js:346-371이 인라인이라 import할 수 없어 옮겨
  // 적었다. 사용자가 스크리너에서 실제로 보는 것은 이쪽이므로 베이스라인에 반드시
  // 필요하다.
  //
  // 경고: 이것은 복제본이다. cron.js의 조건이 바뀌면 여기도 같이 바꿔야 하고, 그러지
  // 않으면 조용히 다른 것을 측정하게 된다. cron 쪽 로직을 함수로 추출해 양쪽이 같은
  // 코드를 부르도록 바꾸는 것이 정답이며, 그 전까지는 임시 조치다.
  cron_scan_v1: {
    label: '현행 크론 스캔 재현 (7조건, BUY>=3)',
    run: (s) => {
      let buy = 0, sell = 0;
      if ((s.rsi >= 50 && s.rsi <= 70) || s.rsi < 35) buy++;
      if (s.rsi > 75) sell++;
      if (s.macdCross === 'golden') buy += 2;
      if (s.macdCross === 'dead') sell += 2;
      // cron.js:357은 정배열에 명시적 null 가드가 있다. 그 동작을 그대로 옮긴다.
      if (s.ma5 != null && s.ma20 != null && s.ma60 != null && s.ma5 > s.ma20 && s.ma20 > s.ma60) buy += 2;
      if (s.ma5 != null && s.ma20 != null && s.ma5 < s.ma20) sell++;
      if (s.bb && s.bb.percentB < 15) buy++;
      if (s.bb && s.bb.percentB > 88) sell++;
      if (s.volRatio != null && s.volRatio >= 2.0) buy++;
      if (s.near52wHigh) buy++;
      // cron.js:369-371은 else if가 아니다. 매수·매도가 동시에 3점을 넘으면 매도가
      // 매수를 덮어쓴다. 그 동작까지 재현한다.
      let sig = 'HOLD';
      if (buy >= 3) sig = 'BUY';
      if (sell >= 3) sig = 'SELL';
      return sig;
    },
  },

  // 대조군. 신호와 무관하게 매일 진입했을 때의 수익이다. 어떤 전략이든 이것을
  // 못 이기면 그 신호는 정보가 없는 것이다. 백테스트에서 가장 자주 빠지는 기준선.
  always_buy: {
    label: '대조군 — 무조건 매수 (신호 없음)',
    run: () => 'BUY',
  },
};

// 박세익 축 중립 고정값. combinedSignal은 (lScore+pScore)/2를 쓰므로 이 값이 avg를
// 통해 결과에 영향을 준다. 50은 "가점도 감점도 없음"에 해당한다. 전략 간 상대 비교가
// 목적이므로 모든 전략에 동일하게 적용된다.
const PSCORE_NEUTRAL = 50;

// ── 시점 스냅샷 ──────────────────────────────────────────────────────
// 배열을 잘라 프로덕션 지표 함수에 그대로 넘긴다. i 시점에서 i 이후 데이터는 보이지 않는다.
function snapshotAt(ctx, i) {
  const { opens, highs, lows, closes, volumes } = ctx;
  const c = closes.slice(0, i + 1);
  if (c.length < 60) return null;
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

  // volRatio: 데이터가 없으면 null이다. server.js:553은 여기서 1로 떨어뜨리는데,
  // 그러면 거래가 없는 종목이 "정상 거래량"으로 둔갑한다. 크론(cron.js:331)은 null을
  // 쓴다. 하네스는 null 쪽을 따른다.
  const lastVols = v.slice(-21, -1);
  const avgVol = lastVols.length ? lastVols.reduce((a, b) => a + b, 0) / lastVols.length : 0;
  const volRatio = avgVol > 0 ? v.at(-1) / avgVol : null;

  const prevClose = c.at(-2);
  const changeRate = prevClose > 0 ? (c.at(-1) - prevClose) / prevClose * 100 : 0;
  const high52w = Math.max(...c.slice(-252));

  return {
    i,
    close: c.at(-1),
    ma5, ma20, ma60, rsi, bb,
    macdCross: macd.lastCross,
    volRatio,
    changeRate,
    near52wHigh: high52w > 0 && c.at(-1) >= high52w * 0.95,
    lScore: calcLivermoreScore(c.at(-1), ma5, ma20, ma60, rsi, volRatio, changeRate, high52w, macd.lastCross, bb),
    ichimoku: calcIchimoku(h, l, c),
    stochastic: calcStochastic(h, l, c),
    obv: calcOBV(c, v),
    rsiDiv: detectRSIDivergence(c, rsiArr),
    williamsR: calcWilliamsR(h, l, c),
    adx: calcADX(h, l, c),
    candlePatterns: calcCandlePatterns(o, h, l, c),
  };
}

// ── 성과 측정 ────────────────────────────────────────────────────────
// 한 신호의 결과. 진입은 다음날 시가가 기본.
function evaluateTrade(ctx, i, horizon) {
  const { opens, lows, closes } = ctx;
  const entryIdx = i + 1;                 // 신호 다음 거래일
  const exitIdx  = entryIdx + horizon - 1;
  if (entryIdx >= closes.length) return { reason: 'no_entry_bar' };
  if (exitIdx  >= closes.length) return { reason: 'no_exit_bar' };

  const entry = opens[entryIdx];
  if (!(entry > 0)) return { reason: 'bad_entry_price' };

  const exit = closes[exitIdx];
  const ret = (exit - entry) / entry * 100 - COST;

  // MAE(최대 역행): 보유 구간 중 저가 기준 최대 낙폭. 손절선을 어디 두어야 살아남는지를
  // 보여주는 값이라 평균수익률보다 실전 판단에 가깝다.
  let minLow = Infinity;
  for (let k = entryIdx; k <= exitIdx; k++) if (lows[k] < minLow) minLow = lows[k];
  const mae = (minLow - entry) / entry * 100;

  // 참고: 기존 방식(신호 당일 종가 진입)
  const retCloseEntry = (closes[Math.min(i + horizon, closes.length - 1)] - closes[i]) / closes[i] * 100 - COST;

  return { ret, mae, retCloseEntry };
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (v) => v == null ? null : parseFloat(v.toFixed(2));

function summarize(rets, maes) {
  if (!rets.length) return null;
  const wins = rets.filter(v => v > 0);
  const gains = rets.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(rets.filter(v => v < 0).reduce((a, b) => a + b, 0));
  return {
    count:     rets.length,
    winRate:   Math.round(wins.length / rets.length * 100),
    avgReturn: r2(rets.reduce((a, b) => a + b, 0) / rets.length),
    medReturn: r2(median(rets)),
    // 손익비. 1 미만이면 이겨도 조금 벌고 질 때 크게 잃는 구조다.
    profitFactor: losses > 0 ? r2(gains / losses) : null,
    maxWin:    r2(Math.max(...rets)),
    maxLoss:   r2(Math.min(...rets)),
    avgMAE:    r2(maes.reduce((a, b) => a + b, 0) / maes.length),
    worstMAE:  r2(Math.min(...maes)),
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────
async function loadCache() {
  let files;
  try {
    files = (await readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    console.error(`캐시가 없습니다: ${CACHE_DIR}\n먼저 실행: node scripts/backtest/fetch-ohlcv.mjs`);
    process.exit(1);
  }
  if (!files.length) {
    console.error(`캐시가 비어 있습니다.\n먼저 실행: node scripts/backtest/fetch-ohlcv.mjs`);
    process.exit(1);
  }
  if (MAX_STOCK > 0) files = files.slice(0, MAX_STOCK);
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

async function main() {
  const t0 = Date.now();
  const stocks = await loadCache();
  const stratKeys = (argOf('strategies', null)?.split(',') ?? Object.keys(STRATEGIES))
    .filter(k => STRATEGIES[k]);
  if (!stratKeys.length) { console.error('전략 지정이 잘못됐습니다.'); process.exit(1); }

  console.log(`종목 ${stocks.length} · 종목당 최근 ${WINDOW}봉 평가 · 전략 ${stratKeys.join(', ')}`);
  console.log(`진입 기준: 신호 다음날 시가 / 비용 ${COST}%`);

  // 평가 구간의 뒤 30%를 out-of-sample로 떼는데, 그 구간 길이가 최장 보유기간보다
  // 짧으면 미래봉이 없어 표본이 통째로 비고 검증이 조용히 무력화된다. 앞 구간 성과만
  // 보고 "잘 나왔다"고 판단하는 것이 백테스트에서 가장 흔한 자기기만이라 미리 막는다.
  const outLen = Math.floor(WINDOW * 0.3);
  const maxH = Math.max(...HORIZONS);
  if (outLen <= maxH) {
    console.log(
      `\n[경고] out-of-sample 구간(${outLen}봉)이 최장 보유기간(${maxH}일)보다 짧습니다.\n` +
      `        해당 기간의 검증 표본이 비어 in-sample만 보게 됩니다. --window를 ${Math.ceil((maxH + 1) / 0.3)} 이상으로 주십시오.`
    );
  }
  console.log('');

  // 전략 × 보유기간 × (전체·in·out) 버킷
  const acc = {};
  for (const k of stratKeys) {
    acc[k] = { signals: 0, sells: 0, horizons: {}, excluded: {} };
    for (const h of HORIZONS) acc[k].horizons[h] = { all: { r: [], m: [] }, in: { r: [], m: [] }, out: { r: [], m: [] }, closeEntry: [] };
  }

  let evaluated = 0, snapNull = 0;
  for (const st of stocks) {
    const n = st.closes.length;
    const start = Math.max(60, n - WINDOW);
    // out-of-sample 경계: 이 종목 평가 구간의 뒤 30%를 검증용으로 뗀다. 파라미터를
    // 앞 구간에 맞춰놓고 뒤 구간에서 무너지면 과최적화다.
    const splitIdx = start + Math.floor((n - start) * 0.7);

    for (let i = start; i < n; i++) {
      const snap = snapshotAt(st, i);
      if (!snap) { snapNull++; continue; }
      evaluated++;
      for (const k of stratKeys) {
        let sig;
        try { sig = STRATEGIES[k].run(snap); } catch { continue; }
        if (sig === 'SELL') { acc[k].sells++; continue; }
        if (sig !== 'BUY') continue;
        acc[k].signals++;
        for (const h of HORIZONS) {
          const t = evaluateTrade(st, i, h);
          if (t.reason) {
            acc[k].excluded[t.reason] = (acc[k].excluded[t.reason] || 0) + 1;
            continue;
          }
          const b = acc[k].horizons[h];
          b.all.r.push(t.ret); b.all.m.push(t.mae);
          b.closeEntry.push(t.retCloseEntry);
          const seg = i < splitIdx ? b.in : b.out;
          seg.r.push(t.ret); seg.m.push(t.mae);
        }
      }
    }
  }

  // 리포트
  const report = { at: new Date().toISOString(), stocks: stocks.length, window: WINDOW, cost: COST, evaluatedPoints: evaluated, strategies: {} };

  for (const k of stratKeys) {
    const a = acc[k];
    console.log(`── ${k} — ${STRATEGIES[k].label}`);
    console.log(`   BUY 신호 ${a.signals}건 / SELL ${a.sells}건 / 평가시점 ${evaluated}`);
    const sRate = evaluated ? (a.signals / evaluated * 100).toFixed(1) : '0';
    console.log(`   신호 발생률 ${sRate}%`);
    const rep = { label: STRATEGIES[k].label, signals: a.signals, sells: a.sells, signalRate: parseFloat(sRate), excluded: a.excluded, horizons: {} };

    for (const h of HORIZONS) {
      const b = a.horizons[h];
      const all = summarize(b.all.r, b.all.m);
      if (!all) { console.log(`   ${String(h).padStart(2)}일  표본 없음`); rep.horizons[h] = null; continue; }
      const inS  = summarize(b.in.r, b.in.m);
      const outS = summarize(b.out.r, b.out.m);
      const ce = b.closeEntry.length ? r2(b.closeEntry.reduce((x, y) => x + y, 0) / b.closeEntry.length) : null;
      // out 표본이 없으면 수치 자리에 '표본없음'을 적는다. 빈칸이나 0으로 두면 "검증했는데
      // 0이었다"로 오독된다 — 측정 안 된 것과 측정해서 0인 것은 다르다.
      const outTxt = outS ? `out ${String(outS.avgReturn).padStart(6)}% (n=${outS.count})` : 'out 표본없음';
      console.log(
        `   ${String(h).padStart(2)}일  n=${String(all.count).padStart(5)}  승률 ${String(all.winRate).padStart(3)}%  ` +
        `평균 ${String(all.avgReturn).padStart(6)}%  중앙 ${String(all.medReturn).padStart(6)}%  ` +
        `PF ${String(all.profitFactor ?? '-').padStart(5)}  평균MAE ${String(all.avgMAE).padStart(6)}%  ` +
        `[${outTxt}]  (당일종가진입 ${ce}%)`
      );
      rep.horizons[h] = { all, inSample: inS, outSample: outS, avgReturnCloseEntry: ce };
    }
    // 집계에서 빠진 신호를 사유별로 드러낸다. 0으로 채우지 않고 제외했으므로, 몇 건이
    // 왜 빠졌는지 보이지 않으면 표본 수가 조용히 줄어든 것을 눈치채지 못한다.
    const exKeys = Object.keys(a.excluded);
    if (exKeys.length) {
      console.log(`   제외: ${exKeys.map(k => `${k} ${a.excluded[k]}건`).join(' / ')}`);
    }
    console.log('');
    report.strategies[k] = rep;
  }

  // 대조군 대비. 신호가 정보를 담고 있는지 보는 유일한 기준이다.
  if (report.strategies.always_buy) {
    // 대조군 대비 초과수익. 전체 구간과 out-of-sample을 함께 본다 — 전체에서 앞서는데
    // out에서 뒤진다면 그 우위는 과거 구간에만 있던 것이다.
    console.log('── 대조군(무조건 매수) 대비 초과수익  [전체 / out-of-sample]');
    const diff = (s, b) => s && b ? `${(s.avgReturn - b.avgReturn) >= 0 ? '+' : ''}${r2(s.avgReturn - b.avgReturn)}%p` : '표본없음';
    for (const k of stratKeys) {
      if (k === 'always_buy') continue;
      const line = HORIZONS.map(h => {
        const s = report.strategies[k].horizons[h], base = report.strategies.always_buy.horizons[h];
        if (!s || !base) return `${h}일 -`;
        return `${h}일 ${diff(s.all, base.all)} / ${diff(s.outSample, base.outSample)}`;
      }).join('   ');
      console.log(`   ${k.padEnd(14)} ${line}`);
    }
    console.log('');
  }

  console.log(`소요 ${((Date.now() - t0) / 1000).toFixed(1)}초 · 스냅샷 생략 ${snapNull}건(이력 부족)`);

  if (OUT_FILE) {
    const dest = path.isAbsolute(OUT_FILE) ? OUT_FILE : path.join(HERE, OUT_FILE);
    await writeFile(dest, JSON.stringify(report, null, 2));
    console.log(`리포트 저장: ${dest}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
