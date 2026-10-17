// 규칙 학습 — RuleTrader 설정을 무작위로 수백 개 만들어 저장된 날마다 한 번에 돌린다(시세는 하루 한 번만 읽어 함께 쓴다).
// 고른 설정이 "학습에 안 쓴 날"에도 이익인지가 기준이다: 하루씩 빼고 나머지 날로 고른 뒤 뺀 날 손익을 더한다.
// 읽기 전용(ticks 는 읽기만), 손실 한도 없이 하루 전체를 잰다. 결과는 scripts/pc/trader/learn/ (git 제외).
//
//   node scripts/pc/trader/learn.mjs --n 300 --seed 1                 무작위 탐색
//   node scripts/pc/trader/learn.mjs --around learn/<결과>.json --n 300   앞 결과 상위 설정 주변을 바꿔 다시 탐색
//   node scripts/pc/trader/learn.mjs --configs learn/<결과>.json --top 5 --stress   상위 설정을 보수 모드로 다시 시험
//   node scripts/pc/trader/learn.mjs --freeze learn/<결과>.json --top 4   모든 날로 고른 상위 설정을 얼려 전진 시험 장부(learn/candidates.json)에 넣음
//   node scripts/pc/trader/learn.mjs --forward                         얼린 설정을 학습 마지막 날 뒤의 날로만 채점
//   node scripts/pc/trader/learn.mjs --nightly --recent 10              매일 저녁: 전진 채점 → 최근 10일로 다시 학습 → 상위 얼리기
//   공통: --dates 2026-10-14,2026-10-15  --recent 10  --min-rounds 20(학습 날 합계 판 수가 이보다 적은 설정은 고르지 않음)
//   정규장(09:00~15:30) 체결이 없는 날(장 마감 뒤만 받은 날 등)은 학습·채점에서 뺀다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Market } from './market.mjs';
import { PaperBroker } from './paper-broker.mjs';
import { RuleTrader } from './rules.mjs';
import { runFast, listDates } from './replay.mjs';
import { LEARN_DIR as OUT, CAND, PASS, loadCand, grade } from './learn-book.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TICKS = path.join(HERE, '..', '..', 'backtest', 'ticks');
const CASH = 10_000_000;
const SESSION = [9 * 3600e3, 15.5 * 3600e3];   // 정규장(한국 시각 09:00~15:30) — 이 안의 체결이 없는 날은 학습에서 뺀다

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] ?? d); };
const flag = k => args.includes('--' + k);

// ── 시드 있는 난수(같은 시드 → 같은 설정) ────────────────────────────────
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// 설정 공간 — 유전자 하나가 관련 키를 지우고 다시 정한다(주변 탐색은 유전자 1~3개만 다시 뽑는다)
const GENES = {
  entry: (r, o) => { o.entry = pick(r, ['passive', 'taker']); },
  exit: (r, o) => { o.exit = pick(r, ['bid', 'market']); },
  imb: (r, o) => { delete o.imbMin; delete o.imbMax; const k = pick(r, ['none', 'none', 'bid', 'ask']); if (k === 'bid') o.imbMin = pick(r, [1, 1.5, 2, 3]); else if (k === 'ask') o.imbMax = pick(r, [0.33, 0.5, 0.8]); },
  flow: (r, o) => { delete o.flowMin; delete o.flowMax; o.flowSec = pick(r, [30, 60, 120]); const k = pick(r, ['none', 'none', 'buy', 'sell']); if (k === 'buy') o.flowMin = pick(r, [0.55, 0.6, 0.7]); else if (k === 'sell') o.flowMax = pick(r, [0.3, 0.4, 0.45]); },
  ret: (r, o) => { delete o.retMin; delete o.retMax; o.retSec = pick(r, [30, 60, 300]); const k = pick(r, ['none', 'none', 'mom', 'dip']); if (k === 'mom') o.retMin = pick(r, [0.3, 0.5, 1, 2]); else if (k === 'dip') o.retMax = pick(r, [-0.3, -0.5, -1, -2]); },
  day: (r, o) => { delete o.dayMin; delete o.dayMax; const d = pick(r, [null, null, null, [0, 5], [2, 10], [5, 15], [10, 29], [-10, -2], [-5, 0]]); if (d) [o.dayMin, o.dayMax] = d; },
  val: (r, o) => { o.val60Min = pick(r, [0, 0, 5e7, 2e8, 5e8]); },
  brk: (r, o) => { o.breakMin = pick(r, [0, 0, 0, 5, 15, 30]); },
  win: (r, o) => { [o.start, o.end] = pick(r, [['09:00:30', '11:00:00'], ['09:00:30', '15:10:00'], ['09:05:00', '13:00:00'], ['09:30:00', '15:10:00'],
    ['10:00:00', '11:00:00'], ['10:00:00', '15:10:00'], ['13:00:00', '15:10:00'], ['14:00:00', '15:10:00'], ['14:30:00', '15:10:00']]); },
  tp: (r, o) => { o.tpPct = pick(r, [0.4, 0.6, 1, 1.5, 2.5, 4, 6]); },
  sl: (r, o) => { o.slPct = pick(r, [0.3, 0.5, 1, 1.5, 2.5, 4]); },
  hold: (r, o) => { o.holdSec = pick(r, [30, 120, 300, 900, 1800, 3600, 20000]); },
  trail: (r, o) => { delete o.trailStart; delete o.trailPct; const t = pick(r, [null, [0.5, 0.3], [1, 0.5], [2, 1]]); if (t) [o.trailStart, o.trailPct] = t; },
  cool: (r, o) => { o.coolSec = pick(r, [30, 120, 600]); },
  perCode: (r, o) => { o.maxPerCode = pick(r, [1, 3, 99]); },
  spread: (r, o) => { o.maxSpreadTicks = pick(r, [1, 2]); },
};
const sample = r => { const o = {}; for (const g of Object.values(GENES)) g(r, o); return o; };
const mutate = (r, base) => {
  const o = structuredClone(base), names = Object.keys(GENES), k = 1 + Math.floor(r() * 3);
  for (let i = 0; i < k; i++) GENES[pick(r, names)](r, o);
  return o;
};

// ── 하루 돌리기: 시장 하나를 모든 설정이 함께 보고, 설정마다 모의 계좌를 따로 둔다 ─────────────
async function runDay(date, cfgs) {
  const market = new Market();
  const bots = cfgs.map(opts => {
    const broker = new PaperBroker({ market, risk: null, cash: CASH });
    const t = new RuleTrader({ broker, risk: null, opts });
    t.enabled = true; t.quiet = true;
    return { broker, t };
  });
  // 그 종목에 판이 진행 중이거나, 가져간 호가 기억이 남은 계좌만 체결 판정을 돌린다(나머지는 진입 판단만)
  const busy = (b, code) => b.t.st.has(code) || b.broker.took.get(code + 'buy')?.size || b.broker.took.get(code + 'sell')?.size;
  let last = 0, sess = 0;
  const rows = await runFast({ ticksDir: TICKS, date, onRow: (k, r) => {
    if (k === 'trade') {
      const s = market.onTrade(r);
      if (!s) return;
      last = r[0];
      const t = (r[0] + 9 * 3600e3) % 86400e3;
      if (t >= SESSION[0] && t < SESSION[1]) sess++;
      for (const b of bots) { if (busy(b, r[1])) b.broker.onTrade(r); b.t.step(s, r[0], 'trade'); }
    } else if (k === 'book') {
      const s = market.onBook(r);
      if (!s) return;
      last = r[0];
      for (const b of bots) if (busy(b, r[1])) { b.broker.onBook(r); b.t.step(s, r[0], 'book'); }
    }
  } });
  // 하루 끝 — 남은 보유는 시장가로 정리(호가가 없으면 마지막 체결가로 평가된 채 남는다)
  return { rows, sess, out: bots.map(({ broker, t }) => {
    broker.cancelAll(last, '하루 끝');
    for (const [code, p] of broker.pos) if (p.qty > 0) { try { broker.place({ code, side: 'sell', type: 'market', qty: broker.sellable(code), tag: 'flat' }, last); } catch { /* 호가 없음 */ } }
    const snap = broker.snapshot(), rs = t.rounds;
    return { pnl: Math.round(snap.pnl), rounds: rs.length, win: rs.filter(x => x.pnl > 0).length, fees: Math.round(snap.fees) };
  }) };
}

// ── 하루씩 빼고 고르기 ──────────────────────────────────────────────
function lodo(results, dates, minRounds) {
  const out = [];
  for (const test of dates) {
    const train = dates.filter(d => d !== test);
    const ok = results.filter(x => train.reduce((a, d) => a + x.days[d].rounds, 0) >= minRounds);
    const pickBy = f => ok.reduce((b, x) => (b == null || f(x) > f(b) ? x : b), null);
    const sum = x => train.reduce((a, d) => a + x.days[d].pnl, 0);
    const worst = x => Math.min(...train.map(d => x.days[d].pnl));
    const a = pickBy(sum), b = pickBy(worst);
    out.push({ test, bySum: a && { id: a.id, train: sum(a), test: a.days[test].pnl, rounds: a.days[test].rounds },
      byWorst: b && { id: b.id, train: worst(b), test: b.days[test].pnl, rounds: b.days[test].rounds } });
  }
  return out;
}

const won = n => (n >= 0 ? '+' : '') + Math.round(n).toLocaleString();

// ── 학습 한 번: 설정들을 날마다 돌리고 하루씩 빼고 고르기로 잰 뒤 결과 파일을 쓴다 ─────────────────
async function search({ cfgs, mode, dates, seed, minRounds, name = 'run' }) {
  console.log(`${mode} · 날짜 ${dates.join(', ')} · 시드 ${seed}`);
  const results = cfgs.map((opts, id) => ({ id, opts, days: {} }));
  const used = [];
  for (const date of dates) {
    const t0 = Date.now();
    const { rows, sess, out } = await runDay(date, cfgs);
    if (!sess) { console.log(`  ${date} ${rows.toLocaleString()}행 · 정규장(09:00~15:30) 체결이 없어 뺌`); continue; }
    used.push(date);
    out.forEach((x, i) => { results[i].days[date] = x; });
    const best = Math.max(...out.map(x => x.pnl)), plus = out.filter(x => x.pnl > 0).length;
    console.log(`  ${date} ${rows.toLocaleString()}행 ${((Date.now() - t0) / 1000).toFixed(0)}초 · 이익 낸 설정 ${plus}/${out.length} · 최고 ${won(best)}원`);
  }
  if (!used.length) throw new Error('정규장 기록이 있는 날이 없습니다');
  for (const x of results) {
    x.total = used.reduce((a, d) => a + x.days[d].pnl, 0);
    x.worst = Math.min(...used.map(d => x.days[d].pnl));
    x.rounds = used.reduce((a, d) => a + x.days[d].rounds, 0);
  }
  const lo = used.length > 1 ? lodo(results, used, minRounds) : [];
  const sumTest = k => lo.reduce((a, x) => a + (x[k]?.test ?? 0), 0);
  const enough = results.filter(x => x.rounds >= minRounds);
  const byTotal = [...enough].sort((a, b) => b.total - a.total), byWorst = [...enough].sort((a, b) => b.worst - a.worst);
  // 다음 주변 탐색 씨앗: 하루씩 빼고 고른 설정 + 전체 기준 상위. 얼릴 설정(finals)은 모든 날로 고른 상위만.
  const picks = [...lo.flatMap(x => [x.bySum?.id, x.byWorst?.id]), ...byTotal.slice(0, 3).map(x => x.id), ...byWorst.slice(0, 3).map(x => x.id)].filter(x => x != null);
  const finals = [...new Set([...byTotal.slice(0, 2), ...byWorst.slice(0, 2)].map(x => x.id))];

  if (lo.length) {
    console.log('\n하루씩 빼고 고르기 — 고른 설정이 학습에 안 쓴 날 낸 손익');
    for (const x of lo) console.log(`  ${x.test} 시험 · 합계 기준 #${x.bySum?.id} ${won(x.bySum?.test ?? 0)}원(${x.bySum?.rounds ?? 0}판) · 최저일 기준 #${x.byWorst?.id} ${won(x.byWorst?.test ?? 0)}원(${x.byWorst?.rounds ?? 0}판)`);
    console.log(`  시험일 합계 — 합계 기준 ${won(sumTest('bySum'))}원 · 최저일 기준 ${won(sumTest('byWorst'))}원`);
  }
  const allPlus = enough.filter(x => used.every(d => x.days[d].pnl > 0));
  console.log(`\n모든 날 이익인 설정 ${allPlus.length}개 (판 수 ${minRounds} 이상 ${enough.length}개 중)`);
  console.log('전체 합계 상위 5');
  for (const x of byTotal.slice(0, 5)) console.log(`  #${x.id} 합계 ${won(x.total)}원 · 최저일 ${won(x.worst)}원 · ${x.rounds}판 · ${used.map(d => won(x.days[d].pnl)).join(' / ')}\n     ${JSON.stringify(x.opts)}`);

  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(2, 16).replace(/[-:]/g, '').replace('T', '-');
  const file = path.join(OUT, `${name}-${stamp}-s${seed}.json`);   // holdout 중간 결과는 holdrun-* (매일 학습의 씨앗으로 쓰지 않음)
  const run = { at: new Date().toISOString(), mode, seed, dates: used, minRounds, lodo: lo, picks: [...new Set(picks)], finals, results };
  fs.writeFileSync(file, JSON.stringify(run, null, 1));
  console.log(`\n저장: ${path.relative(process.cwd(), file)}`);
  return { run, file };
}

// ── 전진 시험 장부 — 고른 설정을 얼려 두고, 학습에 쓴 마지막 날 "뒤에" 온 날로만 성적을 매긴다 ─────────
// 판정 기준(PASS·grade)은 learn-book.mjs 에 있다 — 매매 화면도 같은 기준으로 보여준다.
const keyOf = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
function saveCand(c) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(CAND + '.tmp', JSON.stringify(c, null, 1)); fs.renameSync(CAND + '.tmp', CAND); }

function freeze(run, file, top) {
  const c = loadCand(), have = new Set(c.list.map(x => keyOf(x.opts)));
  const through = [...run.dates].sort().at(-1);
  let added = 0;
  for (const id of (run.finals ?? run.picks).slice(0, top)) {
    const x = run.results.find(y => y.id === id);
    if (!x || have.has(keyOf(x.opts))) continue;
    have.add(keyOf(x.opts));
    c.list.push({ n: (c.list.at(-1)?.n ?? 0) + 1, opts: x.opts, trainedThrough: through, from: path.basename(file), frozenAt: new Date().toISOString(),
      train: { dates: run.dates, total: x.total, worst: x.worst, rounds: x.rounds }, forward: {} });
    added++;
  }
  saveCand(c);
  console.log(`얼린 설정 ${added}개 추가(학습 마지막 날 ${through}) · 장부 ${c.list.length}개`);
}

// 오늘(KST) 기록은 수집기가 끝난(20:05) 뒤에만 쓴다 — 장중에 돌리면 덜 모인 날 성적이 장부에 영구히 남는다
const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString();
const closedDates = () => listDates(TICKS).filter(d => d !== kstNow().slice(0, 10) || kstNow().slice(11, 16) >= '20:10');

async function forward() {
  const c = loadCand();
  if (!c.list.length) { console.log('얼린 설정이 없습니다(--freeze 로 먼저 얼리세요)'); return; }
  for (const date of closedDates()) {
    const todo = c.list.filter(x => date > x.trainedThrough && !(date in x.forward));
    if (!todo.length) continue;
    const t0 = Date.now();
    const { sess, out } = await runDay(date, todo.map(x => x.opts));
    todo.forEach((x, i) => { x.forward[date] = sess ? out[i] : { skip: '정규장 체결 없음' }; });
    console.log(`  전진 ${date} · 설정 ${todo.length}개 · ${((Date.now() - t0) / 1000).toFixed(0)}초${sess ? '' : ' · 정규장 체결 없음(성적에서 뺌)'}`);
  }
  saveCand(c);
  console.log(`\n전진 시험 — 학습에 안 쓴 뒤의 날 성적 (합격: ${PASS.days}거래일 이상 · 합계 + · ${PASS.rounds}판 이상)`);
  for (const x of c.list) {
    const g = grade(x);
    console.log(`  #${x.n} ${g.verdict} · ${g.days}일 ${won(g.pnl)}원 · ${g.rounds}판 · 이익일 ${g.plusDays} · 학습 ~${x.trainedThrough}`);
  }
}

const latestRun = () => {
  try {
    const f = fs.readdirSync(OUT).filter(x => /^run-.*\.json$/.test(x)).map(x => path.join(OUT, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch { return null; }
};
const topsOf = prev => [...new Set(prev.picks)].map(id => prev.results.find(x => x.id === id)?.opts).filter(Boolean);

async function main() {
  const n = Number(arg('n', 300)), minRounds = Number(arg('min-rounds', 20)), top = Number(arg('top', 4));
  let dates = arg('dates') ? arg('dates').split(',') : closedDates();
  if (arg('recent')) dates = dates.slice(-Number(arg('recent')));
  if (flag('forward')) return forward();
  if (arg('holdout')) {
    // 시험일을 완전히 숨기고 학습 전체(무작위 → 상위 주변 → 고르기)를 다시 한 뒤 시험일만 돌린다.
    // 주변 탐색의 씨앗까지 시험일을 못 보게 해야 "학습에 안 쓴 날" 성적이 깨끗하다.
    const test = arg('holdout'), train = dates.filter(d => d !== test);
    const seed = Number(arg('seed', 1)), r = mulberry32(seed);
    const tag = `[시험일 ${test} 숨김]`;
    const a = await search({ cfgs: Array.from({ length: n }, () => sample(r)), mode: `${tag} 무작위 ${n}개`, dates: train, seed, minRounds, name: `holdrun-${test}-a` });
    const tops = topsOf(a.run);
    const b = await search({ cfgs: [...tops, ...Array.from({ length: n }, (_, i) => mutate(r, tops[i % tops.length]))], mode: `${tag} 상위 ${tops.length}개 주변 ${n}개`, dates: train, seed, minRounds, name: `holdrun-${test}-b` });
    const finals = b.run.finals.map(id => b.run.results.find(x => x.id === id));
    const { sess, out } = await runDay(test, finals.map(x => x.opts));
    console.log(`\n${tag} 학습으로 고른 설정의 시험일 성적${sess ? '' : ' — 시험일에 정규장 체결이 없음'}`);
    finals.forEach((x, i) => console.log(`  ${i + 1}. 학습 합계 ${won(x.total)}원 · 학습 최저일 ${won(x.worst)}원 · ${x.rounds}판 → 시험일 ${won(out[i].pnl)}원(${out[i].rounds}판, 이익 ${out[i].win})\n     ${JSON.stringify(x.opts)}`));
    const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(2, 16).replace(/[-:]/g, '').replace('T', '-');
    fs.writeFileSync(path.join(OUT, `holdout-${stamp}-${test}-s${seed}.json`), JSON.stringify({ test, train, seed, n, minRounds, sess,
      finals: finals.map((x, i) => ({ opts: x.opts, train: { total: x.total, worst: x.worst, rounds: x.rounds }, test: out[i] })) }, null, 1));
    return;
  }
  if (arg('freeze')) { const f = path.resolve(HERE, arg('freeze')); return freeze(JSON.parse(fs.readFileSync(f, 'utf8')), f, top); }
  if (flag('nightly')) {
    // 매일 저녁(evening.cmd): 전진 시험 → 최근 날로 다시 학습(무작위 + 지난 결과 주변) → 상위 설정 얼리기
    await forward();
    if (loadCand().list.some(x => x.trainedThrough >= dates.at(-1))) { console.log(`새 날이 없어 다시 학습하지 않음(마지막 ${dates.at(-1)})`); return; }
    const seed =Number(arg('seed', Number(dates.at(-1).replaceAll('-', '')) % 100000));   // 날짜로 정해지는 시드
    const r = mulberry32(seed), prev = latestRun(), tops = prev ? topsOf(prev) : [];
    const cfgs = [...Array.from({ length: n }, () => sample(r)), ...tops, ...(tops.length ? Array.from({ length: n }, (_, i) => mutate(r, tops[i % tops.length])) : [])];
    const { run, file } = await search({ cfgs, mode: `매일 학습(무작위 ${n}개 + 지난 상위 ${tops.length}개 주변 ${tops.length ? n : 0}개)`, dates, seed, minRounds });
    return freeze(run, file, top);
  }
  const seed = Number(arg('seed', 1)), r = mulberry32(seed);
  let cfgs, mode;
  if (arg('configs')) {
    const prev = JSON.parse(fs.readFileSync(path.resolve(HERE, arg('configs')), 'utf8'));
    const ids = prev.picks ?? prev.results.map(x => x.id);
    const base = [...new Set(ids)].slice(0, Number(arg('top', 5))).map(id => prev.results.find(x => x.id === id).opts);
    cfgs = base.flatMap(o => flag('stress') ? [o, { ...o, stress: true }] : [o]);
    mode = `설정 다시 시험(${base.length}개${flag('stress') ? ', 보수 모드 함께' : ''})`;
  } else if (arg('around')) {
    const tops = topsOf(JSON.parse(fs.readFileSync(path.resolve(HERE, arg('around')), 'utf8')));
    cfgs = [...tops, ...Array.from({ length: n }, (_, i) => mutate(r, tops[i % tops.length]))];
    mode = `주변 탐색(상위 ${tops.length}개 × 변형 ${n}개)`;
  } else {
    cfgs = Array.from({ length: n }, () => sample(r));
    mode = `무작위 탐색 ${n}개`;
  }
  await search({ cfgs, mode, dates, seed, minRounds });
}

main().catch(e => { console.error(e); process.exit(1); });
