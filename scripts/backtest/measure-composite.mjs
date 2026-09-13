// 합성 점수 후보를 현행 엔진과 나란히 재는 검증 스크립트.
//
// 핵심은 두 구간을 나눠 돌리는 것이다:
//   [설계구간]  최근 WINDOW봉 — 조건 측정 파일을 만든 구간. 여기 수치가 좋은 것은
//               당연하다. 가중치를 여기서 뽑았기 때문이다. 판정 근거로 쓰지 않는다.
//   [검증구간]  --end-offset 만큼 앞당긴 과거 구간 — 조건 선정에도, 가중치 산출에도
//               한 번도 쓰이지 않았다. 합성 점수가 진짜인지 아닌지는 여기서만 갈린다.
//
// 사용:
//   node scripts/backtest/measure-composite.mjs
//   node scripts/backtest/measure-composite.mjs --horizon 60 --cutoffs 1,2,3
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, runEvaluation, buildReport, r2 } from './engine.mjs';
import { STRATEGIES } from './strategies.mjs';
import { buildComposite } from './composite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HORIZON  = parseInt(argOf('horizon', '20'), 10);
const WINDOW   = parseInt(argOf('window', '600'), 10);
const HOLDOUT  = parseInt(argOf('holdout-window', '520'), 10);
const OFFSET   = parseInt(argOf('end-offset', '600'), 10);
const STOCKS   = parseInt(argOf('stocks', '0'), 10);
const HORIZONS = argOf('horizons', '5,20,60').split(',').map(Number);
const OUT      = argOf('out', 'composite-v1.json');
// 설계구간은 가중치를 뽑은 구간이라 판정 근거가 아니다. 이미 한 번 돌려 수치를 확보했다면
// 다시 돌릴 이유가 없다 — 전체 실행시간의 6할이 여기서 나간다. --cutoffs와 함께 쓴다.
const SKIP_DESIGN = argv.includes('--skip-design');

function line(tag, rep, base, horizons) {
  const d = (s, b) => (s && b) ? `${s.avgReturn - b.avgReturn >= 0 ? '+' : ''}${r2(s.avgReturn - b.avgReturn)}` : '  -';
  const cells = horizons.map(h => {
    const s = rep.horizons[h], b = base.horizons[h];
    if (!s || !b) return '       -';
    return `${d(s.all, b.all)}%p`.padStart(9);
  }).join('');
  const n20 = rep.horizons[HORIZON]?.all?.count ?? 0;
  const wr  = rep.horizons[HORIZON]?.all?.winRate ?? null;
  const mae = rep.horizons[HORIZON]?.all?.avgMAE ?? null;
  return tag.padEnd(22) + String(rep.signalRate ?? '-').padStart(6) + '%' +
         String(n20).padStart(9) + cells + String(wr ?? '-').padStart(6) + String(mae ?? '-').padStart(9);
}

async function run(stocks, fns, labels, opts) {
  const { acc, evaluated } = runEvaluation(stocks, fns, opts);
  const keys = Object.keys(fns);
  const built = buildReport(acc, keys, opts.horizons, labels);
  for (const k of keys) built[k].signalRate = evaluated ? parseFloat((acc[k].signals / evaluated * 100).toFixed(1)) : null;
  const broken = keys.filter(k => acc[k].errors > 0);
  if (broken.length) {
    broken.forEach(k => console.error(`[버그] ${k}: 예외 ${acc[k].errors}건 · ${acc[k].errorMsg}`));
    process.exit(1);
  }
  return { built, evaluated };
}

async function main() {
  const comp = await buildComposite({ horizon: HORIZON });
  console.log(`합성 점수 구성 — 목표 보유 ${HORIZON}일 · 채택 조건 ${comp.picks.length}개`);
  console.log(`선정 규칙: 표본 ${comp.params.MIN_N}건 이상 · in/out 부호 일치 · |초과수익| 평균 ${comp.params.MIN_EDGE}%p 이상\n`);
  console.log('조건                       축        가중치   발생률   in초과   out초과');
  console.log('─'.repeat(72));
  for (const p of comp.picks) {
    console.log(p.key.padEnd(26) + p.axis.padEnd(9) + String(p.weight).padStart(7) +
      String(p.rate).padStart(8) + '%' + String(p.eIn).padStart(9) + String(p.eOut).padStart(9));
  }
  console.log(`\n최대 가점 합 ${r2(comp.maxScore)} · 최대 감점 합 ${r2(comp.minScore)}`);

  const stocksAll = await loadCache(STOCKS);

  // 기준선을 최대 가점의 비율로 잡으면 안 된다. 채택 조건들은 동시에 성립하는 일이 거의
  // 없어서 만점 근처 점수가 아예 나오지 않고, 그런 기준선은 신호 0건짜리 빈 전략이 된다.
  // 실제 점수 분포에서 분위수로 잡아야 "상위 몇 %를 고를 것인가"라는 의도대로 움직인다.
  let cutoffs = argOf('cutoffs', null)?.split(',').map(Number);
  if (!cutoffs) {
    const probe = stocksAll.slice(0, Math.min(30, stocksAll.length));
    const vals = [];
    runEvaluation(probe, { __q: (s) => { const v = comp.score(s); if (v != null) vals.push(v); return 'HOLD'; } },
      { window: WINDOW, horizons: [5] });
    vals.sort((x, y) => x - y);
    const q = (p) => r2(vals[Math.floor(vals.length * p)]);
    // 상위 25% / 10% / 5% / 2% 에 해당하는 점수
    cutoffs = [...new Set([q(0.75), q(0.90), q(0.95), q(0.98)])];
    console.log(`\n점수 분포(표본 ${vals.length.toLocaleString()}건, ${probe.length}종목): 중앙 ${q(0.5)} · 상위25% ${q(0.75)} · 상위10% ${q(0.90)} · 상위5% ${q(0.95)} · 상위2% ${q(0.98)} · 최대 ${r2(vals.at(-1))}`);
  }
  console.log(`검증할 점수 기준선: ${cutoffs.join(' / ')}\n`);

  const fns = {}, labels = {};
  for (const [k, v] of Object.entries(STRATEGIES)) { fns[k] = v.run; labels[k] = v.label; }
  for (const c of cutoffs) {
    const key = `v2_score_${String(c).replace('.', '_')}`;
    fns[key] = (s) => { const v = comp.score(s); return v == null ? null : (v >= c ? 'BUY' : 'HOLD'); };
    labels[key] = `합성 점수 >= ${c}`;
  }

  const stocks = stocksAll;
  const head ='전략                      발생률     신호수' +
    HORIZONS.map(h => `${h}일`.padStart(9)).join('') + '    승률   MAE평균';

  let a = null;
  if (SKIP_DESIGN) {
    console.log(`\n[설계구간] 생략(--skip-design). 이 구간 수치는 판정에 쓰이지 않으므로 재실행하지 않는다.`);
  } else {
    console.log(`\n[설계구간] 최근 ${WINDOW}봉 — 가중치를 여기서 뽑았다. 좋게 나오는 것이 정상이며 판정 근거가 아니다.`);
    a = await run(stocks, fns, labels, { window: WINDOW, horizons: HORIZONS });
    console.log(`평가 시점 ${a.evaluated.toLocaleString()}건 · 대조군 대비 초과수익(전체 구간)`);
    console.log(head); console.log('─'.repeat(head.length));
    for (const k of Object.keys(fns)) if (k !== 'always_buy') console.log(line(k, a.built[k], a.built.always_buy, HORIZONS));
  }

  console.log(`\n[검증구간] 뒤에서 ${OFFSET}봉 앞당긴 과거 ${HOLDOUT}봉 — 설계에 한 번도 쓰이지 않은 구간.`);
  const b = await run(stocks, fns, labels, { window: HOLDOUT, horizons: HORIZONS, endOffset: OFFSET });
  console.log(`평가 시점 ${b.evaluated.toLocaleString()}건 · 대조군 대비 초과수익(전체 구간)`);
  console.log(head); console.log('─'.repeat(head.length));
  for (const k of Object.keys(fns)) if (k !== 'always_buy') console.log(line(k, b.built[k], b.built.always_buy, HORIZONS));

  const ctlA = a?.built.always_buy.horizons[HORIZON]?.all ?? null;
  const ctlB = b.built.always_buy.horizons[HORIZON]?.all;
  console.log(`\n대조군 ${HORIZON}일 평균수익 — 설계구간 ${ctlA ? `${ctlA.avgReturn}% (승률 ${ctlA.winRate}%)` : '미실행'} / 검증구간 ${ctlB?.avgReturn}% (승률 ${ctlB?.winRate}%)`);

  const dest = path.join(HERE, OUT);
  await writeFile(dest, JSON.stringify({
    generatedAt: new Date().toISOString(),
    horizon: HORIZON, cutoffs, picks: comp.picks, params: comp.params,
    design: a ? { window: WINDOW, evaluated: a.evaluated, strategies: a.built } : null,
    holdout: { window: HOLDOUT, endOffset: OFFSET, evaluated: b.evaluated, strategies: b.built },
  }, null, 2));
  console.log(`\n저장: ${dest}`);
}

main().catch(e => { console.error(e); process.exit(1); });
