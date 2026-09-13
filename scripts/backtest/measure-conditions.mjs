// 개별 조건 정보량 측정.
//
// conditions.mjs의 조건을 하나씩 단독 매수 규칙으로 돌려 대조군(무조건 매수) 대비
// 초과수익을 잰다. 목적은 "어떤 조건에 가중치를 줄 것인가"를 추정이 아니라 측정으로
// 정하는 것이다.
//
// 사용:
//   node scripts/backtest/measure-conditions.mjs --window 400
//   node scripts/backtest/measure-conditions.mjs --window 600 --out axis-probe.json
//
// 해석 시 반드시 감안할 것 (수치를 그대로 믿으면 안 되는 이유):
//
//  1. 다중비교. 조건을 40개 가까이 동시에 재면 그중 몇 개는 순전히 우연으로 좋아 보인다.
//     전체/in/out 세 구간에서 부호가 일관된 것만 후보로 본다.
//  2. 표본 독립성 없음. 같은 종목의 인접 시점은 보유구간이 겹쳐 사실상 같은 사건이다.
//     아래 t값은 독립 표본을 가정하므로 과대평가된다. 순위 매기는 용도로만 쓰고
//     "유의하다"는 결론의 근거로 쓰지 않는다.
//  3. 생존편향. 유니버스가 현재 상장 종목뿐이라 상장폐지가 빠져 있다.
//  4. 박세익 축(재무)은 과거 재무를 복원할 수 없어 중립 고정이다.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, runEvaluation, r2 } from './engine.mjs';
import { CONDITIONS, AXIS } from './conditions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WINDOW  = parseInt(argOf('window', '400'), 10);
const STOCKS  = parseInt(argOf('stocks', '0'), 10);
const OUT     = argOf('out', 'conditions-v1.json');
const HORIZONS = argOf('horizons', '5,20,60').split(',').map(Number);
const RANK_H  = parseInt(argOf('rank', '20'), 10);

const CONTROL = '__대조군_무조건매수';

function std(a) {
  if (a.length < 2) return null;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

async function main() {
  const stocks = await loadCache(STOCKS);
  const maxH = Math.max(...HORIZONS);
  console.log(`조건 ${Object.keys(CONDITIONS).length}개 · 종목 ${stocks.length} · 창 ${WINDOW}봉 · 보유 ${HORIZONS.join('/')}일`);

  const outLen = Math.floor(WINDOW * 0.3);
  if (outLen <= maxH) {
    console.log(`\n경고: out-of-sample 구간(${outLen}봉)이 최장 보유기간(${maxH}일)보다 짧아 검증이 빕니다.`);
    console.log(`      --window ${Math.ceil((maxH + 30) / 0.3)} 이상을 권합니다.\n`);
  }

  const fns = { [CONTROL]: () => 'BUY' };
  for (const [k, f] of Object.entries(CONDITIONS)) {
    fns[k] = (s) => { const v = f(s); return v == null ? null : (v ? 'BUY' : 'HOLD'); };
  }

  const t0 = Date.now();
  const { acc, evaluated, snapNull } = runEvaluation(stocks, fns, { window: WINDOW, horizons: HORIZONS });
  console.log(`평가 시점 ${evaluated.toLocaleString()}건 (스냅샷 불가 ${snapNull.toLocaleString()}건 제외) · ${((Date.now() - t0) / 1000).toFixed(0)}초\n`);

  const broken = Object.entries(acc).filter(([, a]) => a.errors > 0);
  if (broken.length) {
    console.log('조건 평가 중 예외 — 아래는 측정값이 아니라 버그다:');
    broken.forEach(([k, a]) => console.log(`  ${k}: ${a.errors}건 · ${a.errorMsg}`));
    process.exit(1);
  }

  // 대조군 기준선
  const base = {};
  for (const h of HORIZONS) {
    const b = acc[CONTROL].horizons[h];
    base[h] = {
      all: b.all.r.length ? b.all.r.reduce((x, y) => x + y, 0) / b.all.r.length : null,
      in:  b.in.r.length  ? b.in.r.reduce((x, y) => x + y, 0) / b.in.r.length   : null,
      out: b.out.r.length ? b.out.r.reduce((x, y) => x + y, 0) / b.out.r.length : null,
    };
  }

  const rows = [];
  for (const key of Object.keys(CONDITIONS)) {
    const a = acc[key];
    const row = { key, axis: AXIS[key[0]] ?? '-', signals: a.signals, undecided: a.undecided, h: {} };
    row.rate = evaluated > 0 ? r2(a.signals / evaluated * 100) : null;
    for (const h of HORIZONS) {
      const b = a.horizons[h];
      const mean = (arr) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
      const mAll = mean(b.all.r), mIn = mean(b.in.r), mOut = mean(b.out.r);
      const sd = std(b.all.r);
      row.h[h] = {
        n: b.all.r.length,
        nOut: b.out.r.length,
        excessAll: mAll == null || base[h].all == null ? null : r2(mAll - base[h].all),
        excessIn:  mIn  == null || base[h].in  == null ? null : r2(mIn  - base[h].in),
        excessOut: mOut == null || base[h].out == null ? null : r2(mOut - base[h].out),
        winRate: b.all.r.length ? Math.round(b.all.r.filter(v => v > 0).length / b.all.r.length * 100) : null,
        avgMAE: b.all.m.length ? r2(b.all.m.reduce((x, y) => x + y, 0) / b.all.m.length) : null,
        // t값은 표본 독립 가정이라 과대평가된다 — 순위용으로만 본다(상단 주석 2번).
        t: (sd && b.all.r.length > 30 && mAll != null && base[h].all != null)
             ? r2((mAll - base[h].all) / (sd / Math.sqrt(b.all.r.length))) : null,
      };
    }
    // 일관성: 전체·in·out 세 구간의 초과수익 부호가 모두 같은가.
    const e = row.h[RANK_H];
    row.consistent = e && [e.excessAll, e.excessIn, e.excessOut].every(v => v != null)
      && (Math.sign(e.excessAll) === Math.sign(e.excessIn) && Math.sign(e.excessIn) === Math.sign(e.excessOut));
    rows.push(row);
  }

  rows.sort((x, y) => (y.h[RANK_H]?.excessOut ?? -999) - (x.h[RANK_H]?.excessOut ?? -999));

  const ctl = acc[CONTROL].horizons[RANK_H];
  console.log(`대조군 ${RANK_H}일 평균수익 ${r2(base[RANK_H].all)}% (전체 ${ctl.all.r.length.toLocaleString()}건 / out ${ctl.out.r.length.toLocaleString()}건)`);
  console.log(`아래는 ${RANK_H}일 보유 · out-of-sample 초과수익 내림차순. 일관=전체/in/out 부호 일치.\n`);
  console.log('조건                       축        발생률   신호수    초과(전체)  초과(in)  초과(out)  승률  MAE평균   t    일관');
  console.log('─'.repeat(118));
  const fmt = (v, w) => (v == null ? '-' : String(v)).padStart(w);
  for (const r of rows) {
    const e = r.h[RANK_H] ?? {};
    console.log(
      r.key.padEnd(26) + (r.axis ?? '').padEnd(9) +
      fmt(r.rate, 6) + '%' + fmt(e.n, 9) +
      fmt(e.excessAll, 11) + fmt(e.excessIn, 10) + fmt(e.excessOut, 11) +
      fmt(e.winRate, 6) + fmt(e.avgMAE, 9) + fmt(e.t, 7) + '   ' + (r.consistent ? 'O' : '.')
    );
  }

  // 다른 보유기간 요약 — 20일에서만 좋은 조건과 전 구간에서 좋은 조건을 구분한다.
  console.log(`\n보유기간별 out-of-sample 초과수익 (상위·하위 각 8개, ${RANK_H}일 기준 정렬)`);
  console.log('조건                      ' + HORIZONS.map(h => `${h}일`.padStart(9)).join(''));
  console.log('─'.repeat(26 + HORIZONS.length * 9));
  const edge = [...rows.slice(0, 8), null, ...rows.slice(-8)];
  for (const r of edge) {
    if (!r) { console.log('  ...'); continue; }
    console.log(r.key.padEnd(26) + HORIZONS.map(h => fmt(r.h[h]?.excessOut, 9)).join(''));
  }

  const dest = path.join(HERE, OUT);
  await writeFile(dest, JSON.stringify({
    generatedAt: new Date().toISOString(),
    params: { window: WINDOW, horizons: HORIZONS, stocks: stocks.length, evaluated, rankHorizon: RANK_H },
    control: base,
    conditions: rows,
  }, null, 2));
  console.log(`\n저장: ${dest}`);
}

main().catch(e => { console.error(e); process.exit(1); });
