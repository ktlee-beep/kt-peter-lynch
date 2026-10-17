// 자동 규칙 하루치 모의 측정 — 저장된 초 단위 기록을 최대 속도로 돌리며 매매 화면과 같은 엔진(시세 → 모의 체결 → 자동 규칙 → 손실 한도)을 실행한다.
//   node scripts/pc/trader/bench.mjs [--date 2026-10-16] [--loss-limit 300000] [--budget 1000000]
// 결과는 모의손익이다. 실제 체결은 대기열·지연·부분 체결 때문에 이보다 나쁠 수 있다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, defaultTicksDir } from './engine.mjs';
import { runFast, kstHms } from './replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ticksDir = argOf('ticks', defaultTicksDir(ROOT));
const engine = new Engine({ ticksDir, limits: { maxDailyLoss: Number(argOf('loss-limit', 300000)) }, strategyOpts: { budget: Number(argOf('budget', 1_000_000)) } });
const date = argOf('date', engine.dates().at(-1));
if (!date || !engine.dates().includes(date)) { console.error(`기록이 없는 날짜입니다: ${date ?? '(없음)'}`); process.exit(1); }

engine.strategy.enabled = true;
let haltAt = 0;
const t0 = Date.now();
const rows = await runFast({ ticksDir, date, onRow: (k, r) => {
  engine.dispatch(k, r);
  if (!haltAt && engine.risk.halted) haltAt = r[0];
} });

const st = engine.strategy, b = engine.broker, snap = b.snapshot();
const rounds = st.rounds, n = rounds.length;
const won = v => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString()}원`;
const byCode = new Map();
for (const r of rounds) {
  const x = byCode.get(r.code) ?? { code: r.code, n: 0, win: 0, pnl: 0 };
  x.n++; x.pnl += r.pnl; if (r.pnl > 0) x.win++;
  byCode.set(r.code, x);
}
const how = { tp: rounds.filter(r => r.how === 'tp'), stop: rounds.filter(r => r.how === 'stop') };
const sumP = a => a.reduce((s, r) => s + r.pnl, 0);
const tried = st.log.filter(l => l.msg.startsWith('진입 주문')).length;

console.log(`\n=== ${date} 자동 규칙 "호가 미리 걸기" 모의 측정 (${rows.toLocaleString()}행, ${((Date.now() - t0) / 1000).toFixed(1)}초) ===`);
console.log(`판 ${n}회 · 이김 ${st.stats().win}회 · 승률 ${n ? (st.stats().win / n * 100).toFixed(1) : '-'}% · 판당 평균 ${n ? won(sumP(rounds) / n) : '-'}`);
console.log(`  익절로 끝 ${how.tp.length}회 ${won(sumP(how.tp))} / 손절·시간 청산 ${how.stop.length}회 ${won(sumP(how.stop))}`);
console.log(`장부: 시작 ${snap.startCash.toLocaleString()}원 → 평가 ${snap.equity.toLocaleString()}원 = ${won(snap.pnl)} (실현 ${won(snap.realized)}, 수수료·세금 ${snap.fees.toLocaleString()}원)`);
const held = snap.positions.filter(p => p.qty > 0);
if (held.length) console.log(`  장 끝 보유 ${held.length}종목(평가에 포함): ${held.map(p => `${p.code} ${p.qty}주 ${won(p.unreal)}`).join(', ')}`);
console.log(`진입 주문 ${tried}회 중 체결 ${n + held.length}회(안 사진 주문은 취소)`);
console.log(haltAt ? `하루 손실 한도 ${engine.risk.limits.maxDailyLoss.toLocaleString()}원에 닿아 ${kstHms(haltAt)}에 전체 정지` : '손실 한도에 닿지 않음');
const codes = [...byCode.values()].sort((a, b) => b.pnl - a.pnl);
if (codes.length) {
  const line = x => `  ${x.code} ${x.n}판 ${x.win}승 ${won(x.pnl)}`;
  console.log('종목별 위:'); codes.slice(0, 5).forEach(x => console.log(line(x)));
  console.log('종목별 아래:'); codes.slice(-5).reverse().forEach(x => console.log(line(x)));
}
