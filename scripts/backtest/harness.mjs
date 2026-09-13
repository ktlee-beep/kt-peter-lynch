// 신호 백테스트 하네스 (오프라인 전용) — 전략 비교 CLI.
//
// 왜 신설인가: 기존 analysis.js의 runBacktestMulti는 (a) 지표를 자체 재구현해 돌므로
// 프로덕션 신호 로직을 측정하지 않고, (b) combinedSignal을 호출조차 하지 않으며,
// (c) 보유기간이 5·10일뿐이고, (d) 산출물 소비처가 0건이다. 확장할 대상이 아니라
// 측정 계기를 따로 세우는 것이 맞다.
//
// 설계 원칙(스냅샷·거래평가·집계의 실제 구현은 engine.mjs):
//  1. 프로덕션 함수를 그대로 호출한다. 시점 i는 slice(0, i+1)로 잘라 넘겨 미래 참조를
//     원천 차단한다. 느리지만 "측정 대상이 실제 코드와 같다"는 보장이 속도보다 중요하다.
//  2. 진입가는 신호 다음날 시가다. 기존 runBacktestMulti(:945)는 당일 종가로 계산해
//     구조적 낙관 편향이 있었다. 참고용으로 종가 진입도 함께 낸다.
//  3. 데이터가 없으면 0이 아니라 제외하고 사유를 센다.
//
// 사용:
//   node scripts/backtest/fetch-ohlcv.mjs          # 먼저 캐시 생성
//   node scripts/backtest/harness.mjs
//   node scripts/backtest/harness.mjs --window 400 --strategies combined_v1
//   node scripts/backtest/harness.mjs --out baseline.json
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, runEvaluation, buildReport, COST, r2 } from './engine.mjs';
import { STRATEGIES } from './strategies.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const WINDOW    = parseInt(argOf('window', '300'), 10);   // 각 종목에서 평가할 최근 봉 수
const MAX_STOCK = parseInt(argOf('stocks', '0'), 10);     // 0 = 전부
const HORIZONS  = argOf('horizons', '5,10,20,60').split(',').map(Number);
const OUT_FILE  = argOf('out', null);

async function main() {
  const t0 = Date.now();
  const stocks = await loadCache(MAX_STOCK);
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

  const fns = {};
  for (const k of stratKeys) fns[k] = STRATEGIES[k].run;
  const { acc, evaluated, snapNull } = runEvaluation(stocks, fns, { window: WINDOW, horizons: HORIZONS });

  const labels = Object.fromEntries(stratKeys.map(k => [k, STRATEGIES[k].label]));
  const built = buildReport(acc, stratKeys, HORIZONS, labels);
  const report = { at: new Date().toISOString(), stocks: stocks.length, window: WINDOW, cost: COST, evaluatedPoints: evaluated, strategies: built };

  for (const k of stratKeys) {
    const a = acc[k], rep = built[k];
    console.log(`── ${k} — ${rep.label}`);
    console.log(`   BUY 신호 ${a.signals}건 / SELL ${a.sells}건 / 평가시점 ${evaluated}`);
    const sRate = evaluated ? (a.signals / evaluated * 100).toFixed(1) : '0';
    rep.signalRate = parseFloat(sRate);
    console.log(`   신호 발생률 ${sRate}%`);
    if (a.errors) console.log(`   [버그] 전략 실행 중 예외 ${a.errors}건: ${a.errorMsg}`);

    for (const h of HORIZONS) {
      const r = rep.horizons[h];
      if (!r) { console.log(`   ${String(h).padStart(2)}일  표본 없음`); continue; }
      const { all, outSample, avgReturnCloseEntry: ce } = r;
      // out 표본이 없으면 수치 자리에 '표본없음'을 적는다. 빈칸이나 0으로 두면 "검증했는데
      // 0이었다"로 오독된다 — 측정 안 된 것과 측정해서 0인 것은 다르다.
      const outTxt = outSample ? `out ${String(outSample.avgReturn).padStart(6)}% (n=${outSample.count})` : 'out 표본없음';
      console.log(
        `   ${String(h).padStart(2)}일  n=${String(all.count).padStart(5)}  승률 ${String(all.winRate).padStart(3)}%  ` +
        `평균 ${String(all.avgReturn).padStart(6)}%  중앙 ${String(all.medReturn).padStart(6)}%  ` +
        `PF ${String(all.profitFactor ?? '-').padStart(5)}  평균MAE ${String(all.avgMAE).padStart(6)}%  ` +
        `[${outTxt}]  (당일종가진입 ${ce}%)`
      );
    }
    // 집계에서 빠진 신호를 사유별로 드러낸다. 0으로 채우지 않고 제외했으므로, 몇 건이
    // 왜 빠졌는지 보이지 않으면 표본 수가 조용히 줄어든 것을 눈치채지 못한다.
    const exKeys = Object.keys(a.excluded);
    if (exKeys.length) console.log(`   제외: ${exKeys.map(x => `${x} ${a.excluded[x]}건`).join(' / ')}`);
    console.log('');
  }

  // 대조군 대비. 신호가 정보를 담고 있는지 보는 유일한 기준이다.
  if (built.always_buy) {
    console.log('── 대조군(무조건 매수) 대비 초과수익  [전체 / out-of-sample]');
    const diff = (s, b) => s && b ? `${(s.avgReturn - b.avgReturn) >= 0 ? '+' : ''}${r2(s.avgReturn - b.avgReturn)}%p` : '표본없음';
    for (const k of stratKeys) {
      if (k === 'always_buy') continue;
      const line = HORIZONS.map(h => {
        const s = built[k].horizons[h], base = built.always_buy.horizons[h];
        if (!s || !base) return `${h}일 -`;
        return `${h}일 ${diff(s.all, base.all)} / ${diff(s.outSample, base.outSample)}`;
      }).join('   ');
      console.log(`   ${k.padEnd(16)} ${line}`);
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
