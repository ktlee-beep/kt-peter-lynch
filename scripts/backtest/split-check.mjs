// 교차 로버스트니스 점검 — 홀드아웃 우위가 유니버스 전반의 것인지, 몇몇 종목이
// 만든 것인지 가른다.
//
// 왜 필요한가: 홀드아웃은 "시간"만 나눈다. 같은 구간이라도 우위가 소수 종목의
// 그 시기 사연에서 나왔다면 그건 신호가 아니다. 종목 코드로 두 묶음을 만들어
// 같은 구간을 각각 평가하고, 양쪽 부호가 갈리면 채택하지 않는다.
//
// 사용:
//   node scripts/backtest/split-check.mjs --horizon 20 --cutoff 4.72 --holdout-window 348 --end-offset 600
import { loadCache, runEvaluation, buildReport, r2 } from './engine.mjs';
import { STRATEGIES } from './strategies.mjs';
import { buildComposite } from './composite.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HORIZON = parseInt(argOf('horizon', '20'), 10);
const CUTOFFS = argOf('cutoff', '2.13,4.72').split(',').map(Number);
const HOLDOUT = parseInt(argOf('holdout-window', '348'), 10);
const OFFSET  = parseInt(argOf('end-offset', '600'), 10);
const HORIZONS = argOf('horizons', '5,20,60').split(',').map(Number);

function evalGroup(stocks, fns, labels) {
  const { acc, evaluated } = runEvaluation(stocks, fns, { window: HOLDOUT, horizons: HORIZONS, endOffset: OFFSET });
  const keys = Object.keys(fns);
  const broken = keys.filter(k => acc[k].errors > 0);
  if (broken.length) { broken.forEach(k => console.error(`[버그] ${k}: ${acc[k].errorMsg}`)); process.exit(1); }
  return { built: buildReport(acc, keys, HORIZONS, labels), evaluated, acc };
}

async function main() {
  const comp = await buildComposite({ horizon: HORIZON });
  const all = await loadCache(0);

  // 코드순으로 세운 뒤 한 칸씩 번갈아 가른다. 끝자리 홀짝은 쓸 수 없다 — 국내 보통주
  // 코드는 거의 전부 0으로 끝나 한쪽이 통째로 비어버린다(실제로 122종목 전부 짝수였다).
  // 코드 정렬은 대체로 상장 순서라 번갈아 뽑으면 양쪽 업종·업력 구성이 비슷해진다.
  const sorted = [...all].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const even = sorted.filter((_, i) => i % 2 === 0);
  const odd  = sorted.filter((_, i) => i % 2 === 1);

  const fns = { always_buy: STRATEGIES.always_buy.run, cron_scan_v1: STRATEGIES.cron_scan_v1.run };
  const labels = { always_buy: '대조군', cron_scan_v1: '현행 스캔' };
  for (const c of CUTOFFS) {
    fns[`score_${c}`] = (s) => { const v = comp.score(s); return v == null ? null : (v >= c ? 'BUY' : 'HOLD'); };
    labels[`score_${c}`] = `합성 >= ${c}`;
  }

  console.log(`합성 점수 목표 보유 ${HORIZON}일 · 채택 조건 ${comp.picks.length}개`);
  console.log(`구간: 뒤에서 ${OFFSET}봉 앞당긴 과거 ${HOLDOUT}봉 (홀드아웃과 동일)\n`);

  for (const [name, group] of [['A군(홀수번째)', even], ['B군(짝수번째)', odd]]) {
    const { built, evaluated } = evalGroup(group, fns, labels);
    const base = built.always_buy;
    console.log(`── ${name} ${group.length}종목 · 평가시점 ${evaluated.toLocaleString()}`);
    for (const k of Object.keys(fns)) {
      if (k === 'always_buy') continue;
      const cells = HORIZONS.map(h => {
        const s = built[k].horizons[h], b = base.horizons[h];
        if (!s || !b) return '        -';
        return `${(s.all.avgReturn - b.all.avgReturn) >= 0 ? '+' : ''}${r2(s.all.avgReturn - b.all.avgReturn)}%p`.padStart(9);
      }).join('');
      const t = built[k].horizons[HORIZON]?.all;
      console.log(`   ${k.padEnd(14)} n=${String(t?.count ?? 0).padStart(5)}${cells}  승률 ${t?.winRate ?? '-'}%  PF ${t?.profitFactor ?? '-'}`);
    }
    const bh = base.horizons[HORIZON]?.all;
    console.log(`   대조군 ${HORIZON}일 평균 ${bh?.avgReturn}% (승률 ${bh?.winRate}%)\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
