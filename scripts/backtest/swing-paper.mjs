// 스윙(일봉) 모의매매 — 매일 저녁 매수 신호를 내고 모의 장부만 적는다. 실주문은 하지 않는다.
//
// 규칙은 아래로 고정했다(2026-10-15 01시대 KST, 2026-09-11 이후 결과를 보기 전).
// 결과를 본 뒤 같은 장부 안에서 규칙을 고치면 전진 검증이 깨진다. 바꾸려면 RULES_VERSION을
// 올리고 새 장부로 다시 시작한다.
//   점수    composite.mjs의 v2 합성 점수(목표 보유 20일, conditions-v2.json). 가중치는
//           2026-09-11까지의 최근 600봉에서 뽑았다(composite-h20.json, 2026-09-13).
//   매수    그날 종가 기준 점수 >= 4.72(composite-h20.json 기준선 중 상위 2%).
//           설계에 안 쓴 과거 348봉 검증: 20일 평균 4.81%(대조군 0.88%), 승률 50%,
//           평균 최대역행 -13.78%. 그래서 보유 중 -10%대 평가손은 규칙 안의 일이다.
//   진입    신호 다음 거래일 시가. 청산: 진입일을 1일로 세어 20번째 거래일 종가. 손절 없음.
//           engine.mjs evaluateTrade와 같은 정의다 — 측정한 규칙을 그대로 돌린다.
//   비용    왕복 0.21%(engine.mjs COST).
//   장부    1종목 100만원 가정, 동시 보유 최대 10종목(가정값, 측정 대상 아님). 빈자리보다 신호가
//           많으면 점수 높은 순, 같으면 코드 순. 보유 중이거나 매수 대기 중인 종목은 다시 사지 않는다.
//   종목    측정과 같은 cache/의 종목 코드 목록. 시세는 paper/daily/에 새로 받는다
//           (cache/는 측정 재현용이라 덮어쓰지 않는다). 스팩(SPAC)은 뺀다 — 합병 전에는 공모가
//           근처에 묶인 현금 껍데기라 추세 신호가 뜻이 없다. 첫 실행에서 스팩 2건이 신호에 든 것을
//           보고 정했다(둘 다 손익 ±1% 안, 청산 0건 — 성적을 보고 고른 제외가 아니다).
//   시작    2026-09-14 신호부터(가중치 산출에 쓴 마지막 날 다음 거래일).
//   대조군  같은 날 시가에 사서 같은 날 종가에 판 전 종목 평균(조건 없이 매수).
//   재매수  청산일 종가에 다시 신호가 나면 다음 날 다시 산다(청산과 신호는 같은 종가로 판정한다).
//   정지    거래가 멈춘 종목도 장부에서 빼지 않는다. 마지막 봉 가격으로 남기고 halted로 표시한다
//           — 빼면 그 종목의 손익과 자리가 과거로 거슬러 사라진다(생존 편향).
//
// 사용: node scripts/backtest/swing-paper.mjs [--no-fetch]
//   평일 20:15 저녁 작업(scripts/pc/evening.cmd)이 돌리고, 제어판이 paper/swing.json을 보여 준다.
//   장중(15:40 전)에 돌리면 오늘 봉은 미완성이라 버린다. 제어판 버튼과 저녁 작업이 겹치지 않게
//   paper/swing.lock으로 한 번에 하나만 돈다.
//   신호 원장(paper/signals.jsonl)에는 시세를 새로 받았고 그날 거래가 끝난 뒤(20:05 이후)일 때만
//   적는다. 네이버 일봉에 넥스트레이드(20:00까지) 체결이 섞이는지 확인하지 못했다 [확인 필요].
import { readFile, writeFile, mkdir, readdir, appendFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotAt, COST, r2 } from './engine.mjs';
import { buildComposite } from './composite.mjs';
import { CONDITIONS } from './conditions.mjs';
import { takeLock, releaseLockSync } from './run-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODES_DIR = path.join(HERE, 'cache');
const OUT_DIR = path.join(HERE, 'paper');
const DAILY_DIR = path.join(OUT_DIR, 'daily');
const LOCK_FILE = path.join(OUT_DIR, 'swing.lock');
// 규칙을 고정한 날의 가중치(composite-h20.json). conditions-v2.json이 다시 측정되면 같은 코드가
// 다른 가중치를 뽑는다 — 그때는 조용히 바뀌지 말고 멈춘다.
const FROZEN = 'composite-h20.json';

const RULES_VERSION = 1;
const CUTOFF = 4.72;
const HOLD = 20;
const START = '20260914';
const SLOTS = 10;
const NOTIONAL = 1_000_000;
const BARS = 1200;           // 측정 캐시와 같은 길이(지수이동평균 등 초기값 영향을 맞춘다)
const STALE_DAYS = 10;       // 마지막 봉이 이보다 오래되면 거래정지·상장폐지로 보고 화면에 알린다

const NO_FETCH = process.argv.includes('--no-fetch');

function kstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = d.toISOString();
  return { ymd: iso.slice(0, 10).replace(/-/g, ''), hm: iso.slice(11, 16), stamp: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}

// 임시 파일에 쓰고 바꿔 끼운다 — 읽는 쪽(제어판)이 반쯤 쓴 파일을 보지 않게.
// 윈도에서 상대가 파일을 열고 있으면 rename이 EPERM으로 실패하므로 그때는 직접 쓴다.
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  try { await rename(tmp, file); }
  catch { await writeFile(file, text); await unlink(tmp).catch(() => {}); }
}

async function fetchDaily(code) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=${BARS}&requestType=0`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item data="([^"]+)"/g)].map(m => {
    const [d, o, h, l, c, v] = m[1].split('|');
    return { d, o: +o, h: +h, l: +l, c: +c, v: +v };
  }).filter(i => i.c > 0);
  if (items.length < 120) throw new Error(`봉 ${items.length}개(너무 짧음)`);
  return items;
}

async function refreshDaily(universe) {
  await mkdir(DAILY_DIR, { recursive: true });
  const queue = [...universe], fails = [], failCodes = [];
  let ok = 0;
  // 동시 4개·150ms 간격 — fetch-ohlcv.mjs와 같은 예절
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const items = await fetchDaily(s.code);
        await writeAtomic(path.join(DAILY_DIR, `${s.code}.json`), JSON.stringify({ code: s.code, name: s.name, items }));
        ok++;
      } catch (e) { fails.push(`${s.code} ${s.name}: ${e.message}`); failCodes.push(s.code); }
      await new Promise(r => setTimeout(r, 150));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { ok, fails, failCodes: failCodes.sort() };
}

async function loadDaily(universe, dropDate) {
  const out = [];
  for (const s of universe) {
    let d;
    try { d = JSON.parse(await readFile(path.join(DAILY_DIR, `${s.code}.json`), 'utf8')); }
    catch { continue; }
    let items = d.items;
    if (dropDate && items.at(-1)?.d === dropDate) items = items.slice(0, -1);
    out.push({
      code: s.code, name: s.name,
      opens: items.map(x => x.o), highs: items.map(x => x.h), lows: items.map(x => x.l),
      closes: items.map(x => x.c), volumes: items.map(x => x.v), dates: items.map(x => x.d),
      idx: new Map(items.map((x, i) => [x.d, i])),
    });
  }
  return out;
}

const daysBetween = (a, b) =>
  (Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6))) / 86400000;
// 화면에 보일 조건 이름. 목록에 없는 조건은 키에서 축 기호만 떼고 보여 준다.
const LABELS = {
  B_저항_박스상단돌파: '박스 상단 돌파', B_저항_박스하단이탈: '박스 하단 이탈', F_RSI다이버전스: 'RSI 다이버전스',
  B_저항_52주신고가권: '52주 신고가권', D_거래_급증저점권: '저점권 거래 급증', B_되돌림_얕음38: '얕은 되돌림(38% 이내)',
  E_캔들_상승_고점권: '고점권 양봉', D_거래_급증음봉: '거래 급증 음봉', C_이평_일목구름위: '일목 구름 위',
  F_BB_상단80: '볼린저 상단권', F_BB_하단20: '볼린저 하단권', A_추세_정배열: '이평 정배열',
};
const label = (key) => LABELS[key] ?? key.replace(/^[A-F]_/, '').replace(/_/g, ' ');
const ret = (entry, exit) => (exit - entry) / entry * 100 - COST;

async function main() {
  const now = kstNow();
  console.log(`[${now.stamp}] 스윙 모의매매 시작 (규칙 v${RULES_VERSION}, 점수 >= ${CUTOFF}, ${HOLD}일 보유, 최대 ${SLOTS}종목)`);

  // 제어판 버튼과 저녁 작업이 동시에 돌면 같은 파일을 둘이 쓴다 — 하나만 돌게 한다
  const lock = await takeLock(LOCK_FILE, { date: now.stamp.slice(0, 10), startedAtKST: now.stamp });   // 날짜는 제어판 kst().date와 같은 YYYY-MM-DD
  if (!lock.ok) {
    console.log(`이미 계산 중(pid ${lock.held.pid}, 시작 ${lock.held.startedAtKST}) — 이번 실행은 건너뜁니다.`);
    return;
  }
  process.on('exit', () => releaseLockSync(LOCK_FILE));

  const comp = await buildComposite({ horizon: HOLD });
  // 고정한 가중치와 같은지 확인한다. 다르면 규칙이 바뀐 것이다.
  const frozen = JSON.parse(await readFile(path.join(HERE, FROZEN), 'utf8'));
  const weightKey = (picks) => picks.map(p => `${p.key}:${p.weight}`).sort().join("|");
  if (weightKey(comp.picks) !== weightKey(frozen.picks) || !frozen.cutoffs?.includes(CUTOFF)) {
    throw new Error(`가중치가 ${FROZEN}(규칙 고정 시점)과 다릅니다. conditions-v2.json이 다시 측정된 것 같습니다 — RULES_VERSION을 올리고 새 장부로 시작하세요.`);
  }

  const universe = [];
  for (const f of (await readdir(CODES_DIR)).filter(f => f.endsWith('.json')).sort()) {
    const d = JSON.parse(await readFile(path.join(CODES_DIR, f), 'utf8'));
    if (/스팩/.test(d.name)) continue;
    universe.push({ code: d.code, name: d.name });
  }

  let fetchInfo = null;
  if (!NO_FETCH) {
    fetchInfo = await refreshDaily(universe);
    console.log(`일봉 갱신 ${fetchInfo.ok}/${universe.length}종목` + (fetchInfo.fails.length ? ` · 실패 ${fetchInfo.fails.length}: ${fetchInfo.fails.slice(0, 5).join(' / ')}` : ''));
    if (fetchInfo.ok === 0) throw new Error('일봉을 하나도 받지 못했습니다(네트워크 확인).');
  }

  // 장 마감(15:30) 전 봉은 미완성이다 — 오늘 봉을 신호에 쓰지 않는다
  const dropDate = now.hm < '15:40' ? now.ymd : null;
  const all = await loadDaily(universe, dropDate);
  const lastDate = all.reduce((m, s) => (s.dates.at(-1) > m ? s.dates.at(-1) : m), '');
  const stocks = all.filter(s => s.dates.length);
  // 오래 거래가 없는 종목은 알리기만 한다(장부에서 빼면 과거 손익이 소급해 사라진다)
  const dropped = stocks.filter(s => daysBetween(s.dates.at(-1), lastDate) > STALE_DAYS).map(s => `${s.name}(${s.code}, 마지막 ${s.dates.at(-1)})`);

  const days = [...new Set(stocks.flatMap(s => s.dates.filter(d => d >= START)))].sort();

  const positions = [];       // 장부에 들어간 거래(대기·보유·청산)
  const signals = [];         // 기준선을 넘은 모든 신호(자리 없어 건너뛴 것 포함)
  const busy = new Set();     // 대기·보유 중인 종목 코드

  for (const D of days) {
    // 0) 이날 시가 진입: 대기 주문의 진입봉(신호 다음 봉)이 이날이면 보유로 바꾼다.
    //    그 종목만 거래가 없던 날이면 다음 봉이 생기는 날까지 대기로 남는다.
    for (const p of positions) {
      if (p.status !== 'pending') continue;
      const st = stocks.find(s => s.code === p.code);
      const e = p.signalIdx + 1;
      if (st.dates[e] !== D) continue;
      if (!(st.opens[e] > 0)) { p.status = 'cancelled'; busy.delete(p.code); continue; }   // 시가 없는 봉 — 측정에서도 뺀다
      p.status = 'open'; p.entryIdx = e; p.exitIdx = e + HOLD - 1;
      p.entryDate = D; p.entryPrice = st.opens[e];
    }
    // 1) 이날 종가 청산(진입일 포함 20번째 봉)
    for (const p of positions) {
      if (p.status !== 'open') continue;
      const st = stocks.find(s => s.code === p.code);
      if (st.dates[p.exitIdx] === D) {
        p.status = 'closed'; p.exitDate = D; p.exitPrice = st.closes[p.exitIdx];
        busy.delete(p.code);
      }
    }
    // 2) 이날 종가 기준 신호 → 다음 거래일 시가 매수 주문
    const cands = [];
    for (const st of stocks) {
      const i = st.idx.get(D);
      if (i == null) continue;
      const snap = snapshotAt(st, i);
      if (!snap) continue;
      let sc;
      try { sc = comp.score(snap); } catch { sc = null; }
      if (sc == null || sc < CUTOFF) continue;
      // 점수에 가점을 준 조건(composite.mjs score와 같은 판정)만 이유로 보여 준다
      const fired = comp.picks.filter(p => { try { return p.weight > 0 && !!CONDITIONS[p.key](snap); } catch { return false; } }).map(p => label(p.key));
      cands.push({ st, i, score: r2(sc), fired, close: st.closes[i] });
    }
    cands.sort((a, b) => b.score - a.score || a.st.code.localeCompare(b.st.code));
    let free = SLOTS - positions.filter(p => p.status === 'pending' || p.status === 'open').length;
    for (const c of cands) {
      const sig = { date: D, code: c.st.code, name: c.st.name, score: c.score, close: c.close, fired: c.fired };
      if (busy.has(c.st.code)) sig.skip = '보유 중';
      else if (free <= 0) sig.skip = '자리 없음';
      else {
        free--; busy.add(c.st.code);
        positions.push({ code: c.st.code, name: c.st.name, signalDate: D, signalIdx: c.i, score: c.score, fired: c.fired, status: 'pending' });
      }
      signals.push(sig);
    }
  }
  // 루프가 끝난 뒤 남은 대기 주문은 진입봉이 아직 없는 것(마지막 날 신호)이다

  // 대조군: 같은 날 시가에 사서 같은 날 종가에 판 전 종목 평균
  const control = (entryDate, endDate) => {
    const rs = [];
    for (const s of stocks) {
      const a = s.idx.get(entryDate), b = s.idx.get(endDate);
      if (a == null || b == null || !(s.opens[a] > 0)) continue;
      rs.push(ret(s.opens[a], s.closes[b]));
    }
    return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : null;
  };

  const rows = positions.filter(p => p.status !== 'cancelled').map(p => {
    const st = stocks.find(s => s.code === p.code);
    // 이 종목만 마지막 봉이 다른 종목보다 이르면 거래가 멈춘 것이다(정지·상장폐지·시세 실패)
    const halted = st.dates.at(-1) < lastDate ? st.dates.at(-1) : null;
    const base = { code: p.code, name: p.name, signalDate: p.signalDate, score: p.score, fired: p.fired, status: p.status, halted };
    if (p.status === 'pending') return { ...base, plan: '다음 거래일 시가 매수' };
    const endIdx = p.status === 'closed' ? p.exitIdx : st.dates.length - 1;
    let minLow = Infinity;
    for (let k = p.entryIdx; k <= endIdx; k++) minLow = Math.min(minLow, st.lows[k]);
    const endPrice = p.status === 'closed' ? p.exitPrice : st.closes[endIdx];
    const r = ret(p.entryPrice, endPrice);
    const ctl = control(p.entryDate, st.dates[endIdx]);
    return {
      ...base, entryDate: p.entryDate, entryPrice: p.entryPrice,
      exitDate: p.status === 'closed' ? p.exitDate : null, lastDate: st.dates[endIdx], lastPrice: endPrice,
      day: endIdx - p.entryIdx + 1, ret: r2(r), pnl: Math.round(NOTIONAL * r / 100),
      mae: r2((minLow - p.entryPrice) / p.entryPrice * 100), control: r2(ctl), excess: ctl == null ? null : r2(r - ctl),
    };
  });

  const closed = rows.filter(r => r.status === 'closed');
  const open = rows.filter(r => r.status === 'open');
  const pending = rows.filter(r => r.status === 'pending');
  const avg = (a) => a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const realized = sum(closed.map(r => r.pnl)), unrealized = sum(open.map(r => r.pnl));

  // 규칙 자체의 성적: 자리 제한 없이 모든 신호를 샀다면(20일을 다 채운 것만)
  const ruleClosed = [];
  for (const s of signals) {
    const st = stocks.find(x => x.code === s.code);
    const i = st.idx.get(s.date), e = i + 1, x = e + HOLD - 1;
    if (x >= st.dates.length || !(st.opens[e] > 0)) continue;
    const r = ret(st.opens[e], st.closes[x]);
    const c = control(st.dates[e], st.dates[x]);
    ruleClosed.push({ r, ex: c == null ? null : r - c });
  }

  const today = signals.filter(s => s.date === lastDate);
  const result = {
    generatedAt: now.stamp, rulesVersion: RULES_VERSION,
    rules: { cutoff: CUTOFF, hold: HOLD, start: START, slots: SLOTS, notional: NOTIONAL, cost: COST, entry: '신호 다음 거래일 시가', exit: `진입일 포함 ${HOLD}번째 거래일 종가`, stop: '없음' },
    data: { lastDate, droppedToday: dropDate, universe: universe.length, used: stocks.length, dropped, fetchFails: fetchInfo?.fails ?? null, days: days.length },
    summary: {
      closed: closed.length, closedAvg: avg(closed.map(r => r.ret)), closedWin: closed.length ? Math.round(closed.filter(r => r.ret > 0).length / closed.length * 100) : null,
      closedExcess: avg(closed.map(r => r.excess).filter(v => v != null)),
      open: open.length, pending: pending.length, realized, unrealized, total: realized + unrealized,
      totalPct: r2((realized + unrealized) / (SLOTS * NOTIONAL) * 100),
      // 장부 전체(보유+청산)가 같은 기간 아무 종목을 산 것보다 얼마나 나았나
      bookExcess: avg([...closed, ...open].map(r => r.excess).filter(v => v != null)),
      ruleSignals: signals.length, ruleClosed: ruleClosed.length, ruleAvg: avg(ruleClosed.map(x => x.r)),
      ruleExcess: avg(ruleClosed.map(x => x.ex).filter(v => v != null)),
    },
    today: { date: lastDate, signals: today },
    positions: { pending, open, closed: closed.sort((a, b) => b.exitDate.localeCompare(a.exitDate)) },
    signals,
  };

  // 신호 원장: 날짜별로 처음 본 신호만 덧붙인다. 나중에 시세가 수정돼 재계산 결과가 달라져도
  // 그날 실제로 냈던 신호가 무엇이었는지 남는다(전진 검증의 증거).
  const ledgerFile = path.join(OUT_DIR, 'signals.jsonl');
  const ledger = [];
  let ledgerText = '';
  try { ledgerText = await readFile(ledgerFile, 'utf8'); } catch { /* 첫 실행 */ }
  for (const l of ledgerText.split('\n')) {
    if (!l.trim()) continue;
    try { ledger.push(JSON.parse(l)); } catch { /* 깨진 줄은 건너뛴다 — 나머지 날짜로 중복을 막는다 */ }
  }
  const seen = new Set(ledger.map(x => x.date));
  // 원장에 적힌 신호와 지금 다시 계산한 신호가 다른 날 — 시세 수정(액면분할 등)으로 과거가 바뀐 것
  const diff = [];
  for (const x of ledger) {
    if (x.rulesVersion !== RULES_VERSION) continue;
    const was = x.signals.map(s => s.code).sort().join(','), now2 = signals.filter(s => s.date === x.date).map(s => s.code).sort().join(',');
    if (was !== now2) diff.push({ date: x.date, ledger: was, now: now2 });
  }
  // 원장에는 시세를 새로 받고 그날 거래가 다 끝난 뒤에만 적는다(--no-fetch·장중 실행은 기록하지 않음)
  const dayOver = lastDate < now.ymd || now.hm >= '20:05';
  let wroteToday = false;
  if (fetchInfo && dayOver && !seen.has(lastDate)) {
    await appendFile(ledgerFile, JSON.stringify({ date: lastDate, recordedAt: now.stamp, rulesVersion: RULES_VERSION,
      fetchFails: fetchInfo.failCodes,
      signals: today.map(s => ({ code: s.code, score: s.score, close: s.close, taken: !s.skip })) }) + '\n');
    wroteToday = true;
  }
  result.ledger = { days: ledger.length + (wroteToday ? 1 : 0), diff, wroteToday };

  await mkdir(OUT_DIR, { recursive: true });
  await writeAtomic(path.join(OUT_DIR, 'swing.json'), JSON.stringify(result, null, 2));

  const s = result.summary;
  console.log(`데이터 ${lastDate}까지 · ${stocks.length}종목 · 전진 구간 ${days.length}거래일` + (dropped.length ? ` · 제외 ${dropped.length}` : ''));
  console.log(`오늘 신호 ${today.length}건: ${today.map(x => `${x.name}(${x.score}${x.skip ? `, ${x.skip}` : ''})`).join(', ') || '없음'}`);
  console.log(`장부 — 대기 ${s.pending} · 보유 ${s.open} · 청산 ${s.closed}(평균 ${s.closedAvg ?? '-'}%) · 손익 ${s.total.toLocaleString('ko-KR')}원(${s.totalPct}%)`);
  console.log(`규칙 전체 — 신호 ${s.ruleSignals}건 · 20일 채운 것 ${s.ruleClosed}건 평균 ${s.ruleAvg ?? '-'}% · 대조군 대비 ${s.ruleExcess ?? '-'}%p`);
  console.log(`신호 원장 ${result.ledger.days}일` + (wroteToday ? ` · ${lastDate} 기록` : ' · 이번에는 기록 안 함(시세 미갱신 또는 20:05 전)'));
  for (const d of diff) console.log(`[주의] ${d.date} 신호가 원장과 다릅니다 — 원장 [${d.ledger}] / 재계산 [${d.now}]`);
}

main().catch(e => { console.error(`[오류] ${e.stack || e.message}`); process.exit(1); });
