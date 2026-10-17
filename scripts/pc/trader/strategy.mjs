// 시험용 자동 규칙 "호가 미리 걸기"(PassiveScalp) — 수익을 보장하는 규칙이 아니라 연결 구조
// (시세 → 판단 → 주문 → 체결 → 청산)를 초 단위로 돌려 보고 모의손익을 재는 출발점이다.
//   진입  09:00:30~15:15, 호가를 받는 종목, 매수·매도 1호가 차이가 1틱이고 매수 잔량합 ≥ 매도 잔량합,
//         최근 10초 안에 체결이 있음 → 매수 1호가에 지정가 매수(1회 100만 원).
//   취소  30초 안에 안 사지거나 매수 1호가가 내 가격보다 2틱 이상 올라가면(따라가지 않음) 진입 주문 취소.
//   청산  사지면 평균가 +2틱(비용을 못 넘으면 넘는 첫 호가)에 지정가 매도. 평균가 −3틱 이하 체결이 나오면 손절, 120초 지나면 시간 청산(둘 다 시장가).
//   쉼    한 번 끝나면 그 종목은 10초 쉰다. 주문이 거절되면 60초 쉰다. 동시에 최대 5종목.
import { tickUp, tickDown, tickSize } from './market.mjs';
import { OrderError, FEE_RATE, TAX_RATE } from './paper-broker.mjs';
import { kstHms } from './replay.mjs';

export const DEFAULTS = { budget: 1_000_000, tpTicks: 2, slTicks: 3, holdMs: 120_000, entryWaitMs: 30_000,
  chaseTicks: 2, coolMs: 10_000, rejectCoolMs: 60_000, maxActive: 5, start: '09:00:30', end: '15:15:00', minPrice: 1000 };
const LOG_KEEP = 500;

export class PassiveScalp {
  constructor({ broker, risk, opts = {} }) {
    this.broker = broker; this.risk = risk; this.o = { ...DEFAULTS, ...opts };
    this.enabled = false;
    this.st = new Map();        // 코드 → { phase: 'entering'|'holding'|'exiting', buyId, sellId, entryAt, fillAt, avg, pnl }
    this.cool = new Map();      // 코드 → 쉬는 끝 시각
    this.log = []; this.rounds = [];
    broker.on('fill', (f, o) => { if (o.tag === 'auto') this.#onFill(f, o); });
    broker.on('order', o => { if (o.tag === 'auto' && o.status !== 'open') this.#onClosed(o); });
  }
  #note(now, code, msg) {
    this.log.push({ at: now, code, msg });
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
  }
  #place(now, code, side, type, price, qty) {
    try { return this.broker.place({ code, side, type, price, qty, tag: 'auto' }, now); }
    catch (e) {
      if (!(e instanceof OrderError)) throw e;
      this.#note(now, code, `${side === 'buy' ? '매수' : '매도'} 거절: ${e.message}`);
      this.cool.set(code, now + this.o.rejectCoolMs);
      return null;
    }
  }

  // 종목 하나의 시세가 바뀔 때마다(체결·호가) 부른다
  step(s, now) {
    const st = this.st.get(s.code);
    if (st) return this.#manage(s, st, now);
    if (!this.enabled || this.risk.halted) return;
    if (this.st.size >= this.o.maxActive) return;
    if ((this.cool.get(s.code) ?? 0) > now) return;
    const hms = kstHms(now);
    if (hms < this.o.start || hms >= this.o.end) return;
    const bid = s.bids[0]?.[0], ask = s.asks[0]?.[0];
    if (!bid || !ask || bid < this.o.minPrice || ask - bid !== tickSize(bid)) return;
    if (s.bidSum < s.askSum || now - s.lastAt > 10_000) return;
    if (this.broker.pos.get(s.code)?.qty) return;                       // 손으로 산 종목은 건드리지 않는다
    for (const o of this.broker.orders.values()) if (o.code === s.code) return;
    const qty = Math.floor(this.o.budget / bid);
    if (qty < 1) return;
    const o = this.#place(now, s.code, 'buy', 'limit', bid, qty);
    if (!o) return;
    this.st.set(s.code, { phase: 'entering', buyId: o.id, sellId: null, entryAt: now, fillAt: 0, avg: 0, pnl: 0, buyPx: bid, qty: 0 });
    this.#note(now, s.code, `진입 주문 ${bid.toLocaleString()}원 × ${qty}주`);
    if (o.status === 'filled') this.#afterBuy(s.code, now);
  }

  #manage(s, st, now) {
    const pos = this.broker.pos.get(s.code)?.qty ?? 0;
    if (st.phase !== 'entering' && pos === 0) return this.#orphan(s.code, st, now);
    if (this.risk.halted) return;   // 전체 정지 중에는 자동으로 아무것도 하지 않는다(청산도 사람이 누른다)
    if (st.phase === 'entering') {
      const buy = this.broker.orders.get(st.buyId);
      if (!buy) return;
      const away = s.bids[0]?.[0] && s.bids[0][0] >= tickUp(buy.price, this.o.chaseTicks);
      if (now - st.entryAt > this.o.entryWaitMs || away) {
        this.broker.cancel(buy.id, now, away ? '호가가 멀어짐' : '진입 대기 시간 초과');   // #onClosed 가 다음 단계를 정한다
      }
      return;
    }
    if (st.phase === 'holding' && pos > 0) {
      if (!st.sellId) return this.#afterBuy(s.code, now);   // 정지 뒤 재개·손으로 취소 — 익절 주문을 다시 건다
      const last = s.last;
      const stop = last && last <= tickDown(st.avg, this.o.slTicks);
      const late = now - st.fillAt > this.o.holdMs;
      if (stop || late) this.#exit(s.code, st, now, stop ? `손절(${last.toLocaleString()}원)` : '시간 청산');
    }
  }

  // 손 청산·전량 청산으로 보유가 0이 됐는데 상태가 남은 경우 — 남은 자동 주문이 없으면 이 판을 끝낸다
  // (그대로 두면 동시 보유 한도를 차지해 신규 진입이 멈춘다)
  #orphan(code, st, now) {
    for (const x of this.broker.orders.values()) if (x.code === code && x.tag === 'auto') return;
    const t = this.broker.trips.at(-1);
    const pnl = Math.round(t?.code === code && t.closeAt >= st.entryAt ? t.pnl : st.pnl);
    this.rounds.push({ code, entryAt: st.entryAt, fillAt: st.fillAt, exitAt: now, qty: st.qty, avg: Math.round(st.avg), pnl, how: 'manual' });
    this.st.delete(code); this.cool.set(code, now + this.o.coolMs);
    this.#note(now, code, `보유가 0이 되어(손 청산) 한 판 끝 ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}원`);
  }

  #exit(code, st, now, why) {
    st.phase = 'exiting';
    if (st.sellId && this.broker.orders.has(st.sellId)) this.broker.cancel(st.sellId, now, why);
    const qty = this.broker.sellable(code);
    if (qty <= 0) return;
    const o = this.#place(now, code, 'sell', 'market', null, qty);
    this.#note(now, code, `${why} → 시장가 매도 ${qty}주${o ? '' : ' 실패'}`);
    if (!o) st.phase = 'holding';
  }

  #afterBuy(code, now) {
    const st = this.st.get(code);
    const p = this.broker.pos.get(code);
    if (!st || !p?.qty) return;
    st.phase = 'holding'; st.avg = p.avg; st.fillAt = st.fillAt || now;
    if (this.risk.halted || this.broker.sellable(code) <= 0) return;
    let px = tickUp(Math.ceil(p.avg / tickSize(p.avg)) * tickSize(p.avg), this.o.tpTicks);
    // 2틱이 왕복 비용(약 0.23%)보다 작은 가격대가 많다 — 팔아도 비용을 못 넘으면 넘는 첫 호가까지 올린다
    while (px * (1 - FEE_RATE - TAX_RATE) <= p.avg * (1 + FEE_RATE)) px = tickUp(px);
    const o = this.#place(now, code, 'sell', 'limit', px, this.broker.sellable(code));
    if (o) { st.sellId = o.id; this.#note(now, code, `매수 체결 평균 ${Math.round(p.avg).toLocaleString()}원 × ${p.qty}주 → 익절 주문 ${px.toLocaleString()}원`); }
  }

  #onFill(f, o) {
    const st = this.st.get(f.code);
    if (!st) return;
    if (f.side === 'buy') { st.qty += f.qty; if (!st.fillAt) st.fillAt = f.at; }
    else st.pnl += f.pnl ?? 0;
  }

  #onClosed(o) {
    const st = this.st.get(o.code);
    if (!st) return;
    const now = o.endAt;
    if (o.id === st.buyId) {
      if (o.filled > 0) this.#afterBuy(o.code, now);
      else { this.st.delete(o.code); this.cool.set(o.code, now + this.o.coolMs); this.#note(now, o.code, `진입 안 됨(${o.reason || o.status})`); }
      return;
    }
    // 매도 주문이 끝났다 — 다 팔렸으면 한 판 끝
    if ((this.broker.pos.get(o.code)?.qty ?? 0) === 0 && !this.broker.orders.has(st.buyId)) {
      const r = { code: o.code, entryAt: st.entryAt, fillAt: st.fillAt, exitAt: now, qty: st.qty, avg: Math.round(st.avg), pnl: Math.round(st.pnl), how: o.type === 'market' ? 'stop' : 'tp' };
      this.rounds.push(r);
      this.st.delete(o.code); this.cool.set(o.code, now + this.o.coolMs);
      this.#note(now, o.code, `한 판 끝 ${r.pnl >= 0 ? '+' : ''}${r.pnl.toLocaleString()}원(${o.type === 'market' ? '시장가 청산' : '익절'})`);
    } else if (o.id === st.sellId) {
      st.sellId = null;   // 익절 주문이 취소됨(정지·손 취소) — 보유 중이면 다음 시세 때 다시 건다
      if (st.phase === 'exiting') st.phase = 'holding';
    }
  }

  stats() {
    const n = this.rounds.length, win = this.rounds.filter(r => r.pnl > 0).length;
    const pnl = this.rounds.reduce((a, r) => a + r.pnl, 0);
    return { enabled: this.enabled, active: this.st.size, rounds: n, win, winRate: n ? Math.round(win / n * 1000) / 10 : null,
      pnl, avg: n ? Math.round(pnl / n) : null, opts: this.o };
  }
}
