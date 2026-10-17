// 매매 화면 엔진(scripts/pc/trader/) — 호가 단위, 모의 체결(지정가 관통·대기열·지연·시장가 호가 따라가기),
// 수수료·실현손익, 주문 거절, 전체 정지·손실 한도, 자동 규칙 익절가, 재생 파일 읽기.
// 실제 주문·네트워크는 쓰지 않는다. 재생 시험은 임시 폴더만 쓴다(ticks 폴더는 건드리지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { tickSize, tickUp, tickDown, onTick, Market } from '../scripts/pc/trader/market.mjs';
import { PaperBroker, OrderError, FEE_RATE, TAX_RATE, pubTrip } from '../scripts/pc/trader/paper-broker.mjs';
import { Ledger } from '../scripts/pc/trader/ledger.mjs';
import { Risk } from '../scripts/pc/trader/risk.mjs';
import { PassiveScalp } from '../scripts/pc/trader/strategy.mjs';
import { listDates, filesOf, merged, kstMs } from '../scripts/pc/trader/replay.mjs';
import { TossBroker } from '../scripts/pc/trader/toss-broker.mjs';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} got=${g} want=${w}`); }
};
const near = (name, got, want, eps = 1e-6) => ok(name, Math.abs(got - want) < eps ? want : got, want);
const throws = (name, fn, re) => {
  try { fn(); fail++; console.log(`  FAIL ${name} — 예외가 나지 않음`); }
  catch (e) { ok(name, e instanceof OrderError && re.test(e.message) ? 'OrderError' : `${e.constructor.name}: ${e.message}`, 'OrderError'); }
};

const C = '005930';
const T0 = kstMs('2026-10-16', '10:00');
// 시세를 엔진과 같은 순서로 흘린다(시장 상태 먼저, 그다음 모의 체결)
const setup = (opts = {}) => {
  const m = new Market(), risk = new Risk(opts.limits), b = new PaperBroker({ market: m, risk, cash: opts.cash ?? 10_000_000 });
  const book = (t, bids, asks, sb = 1000, sa = 1000) => { const r = [t, C, t, bids.flat(), asks.flat(), sb, sa]; m.onBook(r); b.onBook(r); };
  const trade = (t, px, q) => { const r = [t, C, px, q, t]; m.onTrade(r); b.onTrade(r); };
  return { m, risk, b, book, trade };
};

console.log('호가 단위');
ok('1999원 단위 1', tickSize(1999), 1);
ok('2000원 단위 5', tickSize(2000), 5);
ok('2000 한 칸 아래 = 1999(아래 구간 단위)', tickDown(2000), 1999);
ok('1999 한 칸 위 = 2000', tickUp(1999), 2000);
ok('5000 한 칸 아래 = 4995', tickDown(5000), 4995);
ok('4995 한 칸 위 = 5000', tickUp(4995), 5000);
ok('20000 한 칸 아래 = 19990', tickDown(20000), 19990);
ok('199900 두 칸 위 = 200500', tickUp(199900, 2), 200500);
ok('호가 단위 검사', [onTick(2003), onTick(2005), onTick(0), onTick(10010.5)], [false, true, false, false]);

console.log('지정가 — 지연·관통 체결');
{
  const { b, book, trade } = setup();
  book(T0, [[10000, 500], [9990, 800]], [[10010, 300], [10020, 400]]);
  const o = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 10 }, T0);
  ok('대기열 앞 물량 = 같은 가격 잔량', o.queue, 500);
  trade(T0 + 50, 9990, 1);
  ok('낸 직후(지연 안) 관통 체결은 무시', o.filled, 0);
  trade(T0 + 200, 9990, 1);
  ok('지연 뒤 내 가격 아래 체결 → 전량 체결', [o.filled, o.status, o.avgFill], [10, 'filled', 10000]);
}

console.log('지정가 — 같은 가격 대기열');
{
  const { b, trade, book } = setup();
  book(T0, [[10000, 500]], [[10010, 300]]);
  const o = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 10 }, T0);
  trade(T0 + 200, 10000, 300);
  ok('앞 물량 500 중 300 체결 → 남은 앞 물량 200, 체결 0', [o.queue, o.filled], [200, 0]);
  trade(T0 + 300, 10000, 205);
  ok('앞 물량을 5 넘김 → 5주 체결', [o.queue, o.filled], [0, 5]);
  trade(T0 + 400, 10000, 3);
  ok('맨 앞이면 같은 가격 체결만큼', o.filled, 8);
  trade(T0 + 500, 10000, 10);
  ok('남은 2주만 체결하고 끝', [o.filled, o.status], [10, 'filled']);
}

console.log('지정가 — 호가로 대기열·체결 갱신');
{
  const { b, book } = setup();
  book(T0, [[10000, 500]], [[10010, 300]]);
  const o = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 10 }, T0);
  book(T0 + 200, [[10000, 120]], [[10010, 300]]);
  ok('같은 가격 잔량이 줄면 앞 물량도 준다', o.queue, 120);
  book(T0 + 300, [[9990, 50]], [[10010, 300]]);
  ok('내 가격이 최우선보다 좋으면 맨 앞', o.queue, 0);
  book(T0 + 400, [[9990, 50]], [[10000, 4]]);
  ok('매도1호가가 내 가격과 같으면 그 잔량만큼', o.filled, 4);
  book(T0 + 500, [[9980, 50]], [[9990, 100]]);
  ok('매도호가가 내 가격 아래로 오면 남은 전량', [o.filled, o.status, o.avgFill], [10, 'filled', 10000]);
}
{
  const { b, book, trade } = setup();
  book(T0, [[10000, 500]], [[10010, 300]]);
  const o = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 10 }, T0);
  book(T0 + 200, [[10000, 500]], [[10000, 300]]);
  book(T0 + 300, [[10010, 500]], [[9990, 300]]);
  ok('겹친 호가(매수1 ≥ 매도1)로는 체결하지 않는다', o.filled, 0);
  trade(T0 + 400, 9990, 1);
  ok('겹친 호가 중에도 체결 기록으로는 체결', [o.filled, o.status], [10, 'filled']);
}

console.log('시장가 — 호가 따라가기');
{
  const { m, b, book } = setup();
  book(T0, [[10000, 500]], [[10010, 30], [10020, 40]]);
  const o = b.place({ code: C, side: 'buy', type: 'market', qty: 100 }, T0);
  ok('단계마다 1틱 불리, 넘친 수량은 마지막 단계 2틱 불리', b.fills.map(f => [f.px, f.qty]), [[10020, 30], [10030, 40], [10040, 30]]);
  ok('즉시 전량 체결', [o.filled, o.status], [100, 'filled']);
  ok('시장 호가는 그대로 두고 가져간 잔량은 브로커가 기억', [m.sym.get(C).asks, [...b.took.get(C + 'buy')]], [[[10010, 30], [10020, 40]], [[10010, 30], [10020, 40]]]);
  book(T0 + 1000, [[10000, 50]], [[10010, 30]]);
  b.place({ code: C, side: 'sell', type: 'market', qty: 60 }, T0 + 1000);
  ok('매도도 같은 규칙(아래로)', b.fills.slice(3).map(f => [f.px, f.qty]), [[9990, 50], [9980, 10]]);
  ok('100주 중 60주 팔고 40주 남음', b.pos.get(C).qty, 40);
}

console.log('같은 호가 물량을 두 번 체결하지 않는다');
{
  const { b, book } = setup();
  book(T0, [[9990, 50]], [[10000, 30]]);
  const o = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 100 }, T0);
  ok('보이는 30주만 바로 체결', o.filled, 30);
  for (let i = 1; i <= 3; i++) book(T0 + 200 * i, [[9990, 50]], [[10000, 30]]);
  ok('같은 호가가 다시 와도 더 체결하지 않음', o.filled, 30);
  book(T0 + 1000, [[9990, 50]], [[10000, 45]]);
  ok('잔량이 늘어난 만큼만 체결', o.filled, 45);
  book(T0 + 1200, [[9990, 50]], [[10010, 70]]);
  book(T0 + 1400, [[9990, 50]], [[10000, 20]]);
  ok('그 가격 단계가 사라졌다 다시 생기면 새 물량', o.filled, 65);
}
{
  const { b, book } = setup();
  book(T0, [[10000, 500]], [[10010, 300]]);
  const o1 = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 50 }, T0);
  const o2 = b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 50 }, T0);
  book(T0 + 200, [[9990, 50]], [[10000, 5]]);
  ok('대기 주문 두 개가 호가 5주를 나눠 가짐(합계 5)', o1.filled + o2.filled, 5);
}

console.log('수수료·실현손익');
{
  const { b, book } = setup();
  book(T0, [[9990, 1000]], [[10000, 1000]]);
  b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 100 }, T0);
  near('매수: 현금 = 1천만 − 100만 − 수수료 150', b.cash, 10_000_000 - 1_000_000 - 150);
  ok('평균 단가는 수수료 빼고', b.pos.get(C).avg, 10000);
  book(T0 + 1000, [[10100, 1000]], [[10110, 1000]]);
  b.place({ code: C, side: 'sell', type: 'limit', price: 10100, qty: 100 }, T0 + 1000);
  const sellFee = 1_010_000 * FEE_RATE + 1_010_000 * TAX_RATE;
  near('매도 실현손익 = 1만 − 매도 비용 − 매수 수수료', b.realized, 10_000 - sellFee - 150);
  near('수수료·세금 합계', b.fees, 150 + sellFee);
  near('현금 = 시작 + 실현손익', b.cash, 10_000_000 + b.realized);
  const s = b.snapshot();
  ok('장부 평가손익 = 실현손익(보유 없음)', s.pnl, Math.round(b.realized));
}

console.log('주문 거절');
{
  const { b, book } = setup();
  throws('호가 없는 종목 시장가 거절', () => b.place({ code: C, side: 'buy', type: 'market', qty: 1 }, T0), /시장가/);
  book(T0, [[10000, 500]], [[10010, 300]]);
  throws('공매도 거절', () => b.place({ code: C, side: 'sell', type: 'limit', price: 10010, qty: 1 }, T0), /팔 주식이 없습니다/);
  throws('호가 단위 안 맞는 가격 거절', () => b.place({ code: C, side: 'buy', type: 'limit', price: 10005, qty: 1 }, T0), /호가 단위/);
  throws('코드 형식 거절', () => b.place({ code: 'ABC', side: 'buy', type: 'limit', price: 10000, qty: 1 }, T0), /종목 코드/);
  throws('소수 수량 거절(내림하지 않음)', () => b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 1.5 }, T0), /정수/);
  throws('숫자 아닌 가격은 가격 문구로 거절', () => b.place({ code: C, side: 'buy', type: 'limit', price: 'abc', qty: 1 }, T0), /숫자로/);
  throws('주문 가능 금액 초과', () => b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 2000 }, T0), /주문 가능 금액|한도/);
  throws('주문 한 번 한도(300만) 초과', () => b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 301 }, T0), /주문 한 번 한도/);
  ok('거절된 주문은 증거금을 잡지 않는다', b.available(), 10_000_000);
}

console.log('전체 정지·하루 손실 한도');
{
  const { b, risk, book, trade } = setup({ limits: { maxDailyLoss: 1000 } });
  book(T0, [[9990, 1000]], [[10000, 1000]]);
  b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 100 }, T0);
  const wait = b.place({ code: C, side: 'buy', type: 'limit', price: 9980, qty: 10 }, T0);
  trade(T0 + 500, 9980, 1);
  ok('손실 2,150원 ≥ 한도 1,000원 → 정지', risk.watch(b, T0 + 500), true);
  ok('정지하면 미체결 취소', [wait.status, b.orders.size], ['canceled', 0]);
  throws('정지 중 매수 거절', () => b.place({ code: C, side: 'buy', type: 'limit', price: 9990, qty: 1 }, T0 + 600), /전체 정지/);
  const sell = b.place({ code: C, side: 'sell', type: 'limit', price: 9990, qty: 100 }, T0 + 600);
  ok('정지 중에도 매도는 받는다', sell.status, 'filled');
  risk.resume();
  ok('재개하면 다시 매수 가능(한도 검사는 따로)', risk.halted, false);
}

console.log('자동 규칙 — 익절가가 왕복 비용을 넘는다');
{
  const { m, b, risk, book, trade } = setup();
  const st = new PassiveScalp({ broker: b, risk });
  st.enabled = true;
  const step = t => st.step(m.sym.get(C), t);
  book(T0, [[10000, 500]], [[10010, 300]], 2000, 1000); trade(T0, 10010, 1); step(T0);
  const buy = [...b.orders.values()].find(o => o.side === 'buy');
  ok('매수1호가에 미리 걸기', buy && [buy.price, buy.qty, buy.tag], [10000, 100, 'auto']);
  trade(T0 + 500, 9990, 1); step(T0 + 500);
  const sell = [...b.orders.values()].find(o => o.side === 'sell');
  ok('2틱(10,020)은 비용을 못 넘어 3틱 10,030 에 익절 주문', sell && [sell.price, sell.qty], [10030, 100]);
  ok('익절가로 팔면 비용 뒤에도 이익', sell.price * (1 - FEE_RATE - TAX_RATE) > 10000 * (1 + FEE_RATE), true);
  trade(T0 + 1000, 10040, 1); step(T0 + 1000);
  const r = st.rounds[0];
  ok('익절로 한 판 끝, 이익', r && [r.how, r.qty, r.pnl > 0], ['tp', 100, true]);
}
{
  // 가격대마다 익절가가 비용을 넘는지(1,000원대·5,000원 경계·10만원대)
  for (const [bid, ask] of [[1000, 1001], [4995, 5000], [100000, 100100]]) {
    const { m, b, risk, book, trade } = setup();
    const st = new PassiveScalp({ broker: b, risk });
    st.enabled = true;
    book(T0, [[bid, 500]], [[ask, 300]], 2000, 1000); trade(T0, ask, 1); st.step(m.sym.get(C), T0);
    trade(T0 + 500, tickDown(bid), 1); st.step(m.sym.get(C), T0 + 500);
    const sell = [...b.orders.values()].find(o => o.side === 'sell');
    ok(`${bid.toLocaleString()}원 익절가 ${sell?.price} 가 비용을 넘는다`, !!sell && sell.price * (1 - FEE_RATE - TAX_RATE) > bid * (1 + FEE_RATE), true);
  }
}

console.log('재생 파일 — 옛 이름·새 이름·시각순 병합');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-trader-'));
  const put = (date, name, rows, cut = 0) => {
    fs.mkdirSync(path.join(dir, date), { recursive: true });
    let gz = zlib.gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (cut) gz = gz.subarray(0, gz.length - cut);
    fs.writeFileSync(path.join(dir, date, name), gz);
  };
  put('2026-10-13', 'trade.ndjson.gz', [[1000, C, 10000, 1, 1000]]);
  put('2026-10-13', 'book.ndjson.gz', [[1000, C, 1000, [9990, 5], [10000, 5], 5, 5]]);
  put('2026-10-14', 'trade-120000.ndjson.gz', [[3000, C, 10010, 1, 3000]]);
  put('2026-10-14', 'trade-085000.ndjson.gz', [[1000, C, 10000, 1, 1000], [2000, C, 10000, 2, 2000]]);
  put('2026-10-14', 'book-085000.ndjson.gz', [[1500, C, 1500, [9990, 5], [10000, 5], 5, 5], [2000, C, 2000, [9990, 5], [10000, 5], 5, 5]], 8);
  fs.writeFileSync(path.join(dir, '2026-10-14', 'trade-note.txt'), 'x');
  put('2026-10-15', 'book-090000.ndjson.gz', [[1000, C, 1000, [], [], 0, 0]]);
  ok('체결 기록이 있는 날만', listDates(dir), ['2026-10-13', '2026-10-14']);
  ok('옛 이름(하루 한 파일)', filesOf(dir, '2026-10-13', 'trade').map(f => path.basename(f)), ['trade.ndjson.gz']);
  ok('새 이름은 켠 순서대로, 다른 파일 제외', filesOf(dir, '2026-10-14', 'trade').map(f => path.basename(f)), ['trade-085000.ndjson.gz', 'trade-120000.ndjson.gz']);
  const seq = [];
  for await (const [k, r] of merged(dir, '2026-10-14')) seq.push(`${k}@${r[0]}`);
  ok('수신 시각순, 같은 시각이면 호가 먼저, 끝이 잘린 gz 도 읽는다', seq, ['trade@1000', 'book@1500', 'book@2000', 'trade@2000', 'trade@3000']);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('매매 내역 — 산 종목을 전부 팔 때까지 한 건');
{
  const { b, book } = setup();
  const trips = []; b.on('trip', t => trips.push(t));
  book(T0, [[9990, 1000]], [[10000, 1000]]);
  b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 100 }, T0);
  b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 50 }, T0 + 1000);
  book(T0 + 2000, [[10100, 1000]], [[10110, 1000]]);
  b.place({ code: C, side: 'sell', type: 'limit', price: 10100, qty: 100 }, T0 + 2000);
  ok('일부만 팔면 아직 한 건이 아님(진행 중 1)', [trips.length, b.stats().holding], [0, 1]);
  book(T0 + 3000, [[10200, 1000]], [[10210, 1000]]);
  b.place({ code: C, side: 'sell', type: 'limit', price: 10200, qty: 50, tag: 'auto' }, T0 + 3000);
  ok('전부 팔면 한 건', trips.length, 1);
  const t = trips[0], p = pubTrip(t);
  const cost = 1_500_000 * FEE_RATE + 1_520_000 * (FEE_RATE + TAX_RATE);
  near('실현손익 = 매도금액 − 매수금액 − 비용', t.pnl, 1_520_000 - 1_500_000 - cost);
  near('한 건 손익 = 장부 실현손익', t.pnl, b.realized);
  near('수익률 = 실현손익 ÷ 매수금액', t.ret, t.pnl / 1_500_000 * 100);
  ok('추가 매수·분할 매도는 평균가로 묶음', [p.qty, p.buyAvg, p.sellAvg, p.buyAmt, p.sellAmt, p.cost, p.ret], [150, 10000, 10133.33, 1_500_000, 1_520_000, Math.round(cost), 1.1]);
  ok('손·자동이 섞이면 섞임, 시각은 첫 체결~마지막 체결', [p.tag, p.openAt, p.closeAt], ['mixed', T0, T0 + 3000]);
  // 두 번째 매매: 자동, 손실
  book(T0 + 4000, [[10190, 1000]], [[10200, 1000]]);
  b.place({ code: C, side: 'buy', type: 'limit', price: 10200, qty: 100, tag: 'auto' }, T0 + 4000);
  book(T0 + 5000, [[10100, 1000]], [[10110, 1000]]);
  b.place({ code: C, side: 'sell', type: 'limit', price: 10100, qty: 100, tag: 'auto' }, T0 + 5000);
  const loss = -10_000 - 1_020_000 * FEE_RATE - 1_010_000 * (FEE_RATE + TAX_RATE);
  near('손실 매매도 같은 식', trips[1].pnl, loss);
  const s = b.stats();
  ok('승률·평균 이익·평균 손실', [s.trips, s.win, s.loss, s.winRate, s.avgWin, s.avgLoss], [2, 1, 1, 50, Math.round(t.pnl), Math.round(loss)]);
  ok('손익비 = 평균 이익 ÷ 평균 손실', s.payoff, Math.round(t.pnl / -loss * 100) / 100);
  ok('최대 낙폭 = 고점 뒤 최대 하락(실현 누적)', s.mdd, Math.round(-loss));
  ok('자동·손 구분(섞임은 어느 쪽에도 넣지 않음)', [s.auto, s.manual], [{ n: 1, pnl: Math.round(loss) }, { n: 0, pnl: 0 }]);
  ok('보유 없으면 총 수익률 = 실현 수익률', [s.totalRet, s.realizedRet], [Math.round(b.realized / 100_000 * 100) / 100, Math.round(b.realized / 100_000 * 100) / 100]);
  ok('화면 목록은 최신 먼저', b.snapshot().trips.map(x => x.openAt), [T0 + 4000, T0]);
}

console.log('매매 장부 — 세션 저장·목록·CSV');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-ledger-'));
  try {
    const logs = [];
    const L = new Ledger(dir, { name: c => (c === C ? '삼성전자' : c), log: m => logs.push(m) });
    const s1 = { mode: 'replay', date: '2026-10-16', from: '09:00', speed: 5, startedAt: T0 };
    const { b, book } = setup();
    const id1 = L.begin(s1, b);
    ok('세션 이름 = 방식-날짜-시작 시각(KST)', [id1, Ledger.validId(id1)], ['replay-2026-10-16-100000', true]);
    L.flush();
    ok('매매 0건이면 파일을 만들지 않음', fs.readdirSync(dir).length, 0);
    ok('저장 전에도 목록에 지금 세션', L.list().map(x => [x.id, x.current, x.stats.trips]), [[id1, true, 0]]);
    book(T0, [[9990, 1000]], [[10000, 1000]]);
    b.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 10 }, T0);
    book(T0 + 1000, [[10100, 1000]], [[10110, 1000]]);
    b.place({ code: C, side: 'sell', type: 'limit', price: 10100, qty: 10 }, T0 + 1000);
    L.flush();
    ok('끝난 매매가 생기면 파일 저장', fs.readdirSync(dir), [id1 + '.json']);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, id1 + '.json'), 'utf8'));
    ok('저장 내용', [doc.mode, doc.speed, doc.trips.length, doc.trips[0].name, doc.stats.trips], ['replay', 5, 1, '삼성전자', 1]);
    const id2 = L.begin({ ...s1 }, setup().b);
    ok('같은 시각에 다시 시작하면 -2', id2, id1 + '-2');
    ok('목록: 저장된 세션 + 지금 세션', L.list().map(x => [x.id, x.current]).sort(), [[id1, false], [id2, true]].sort());
    const lines = L.csv({ id: id1 }).split('\r\n');
    ok('CSV 머리에 BOM, 머리줄 + 1건', [lines[0].charCodeAt(0), lines.filter(Boolean).length], [0xfeff, 2]);
    const f = lines[1].split(',');
    ok('CSV 내용(방식·종목·보유초·수량·손익·수익률·출처)', [f[1], f[3], f[4], f[5], f[7], f[8], f[14], f[15], f[16]],
      ['재생', '"=""005930"""', '삼성전자', '2026-10-16 10:00:00', '1', '10', '768', '0.77', '손']);
    ok('전체 CSV는 매매 있는 세션만', L.csv({ all: true }).split('\r\n').filter(Boolean).length, 2);
    const L2 = new Ledger(dir, { name: () => '=HYPERLINK("x")', log: m => logs.push(m) });
    const { b: b2, book: book2 } = setup();
    const id3 = L2.begin({ ...s1, startedAt: T0 + 7000 }, b2);
    book2(T0, [[9990, 1000]], [[10000, 1000]]);
    b2.place({ code: C, side: 'buy', type: 'limit', price: 10000, qty: 10 }, T0);
    book2(T0 + 1000, [[9900, 1000]], [[9910, 1000]]);
    b2.place({ code: C, side: 'sell', type: 'limit', price: 9900, qty: 10 }, T0 + 1000);
    L2.flush();
    const g = L2.csv({ id: id3 }).split('\r\n')[1].split(',');
    ok('CSV 수식 주입 막기(종목명 앞에 \', 음수 손익은 숫자 그대로, 코드 칸은 ="…")', [g[4].startsWith(`"'=HYPERLINK`), Number(g[14]) < 0, g[3]], [true, true, '"=""005930"""']);
    ok('세션 이름 검사(경로 조작 차단)', ['../x', 'replay-2026-10-16-100000', 'live-2026-10-16-235959-3', 'replay-2026-10-16-100000.json', '', null].map(Ledger.validId),
      [false, true, true, false, false, false]);
    ok('저장 오류 없음', logs, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('실주문 잠금');
{
  let msg = '';
  try { new TossBroker(); } catch (e) { msg = e.message; }
  ok('승인 전에는 실주문 브로커를 만들 수 없다', /실주문 미승인/.test(msg), true);
}

console.log(`\n총 ${pass + fail}건 — 통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
