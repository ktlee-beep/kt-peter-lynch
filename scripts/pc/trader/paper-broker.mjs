// 모의(종이) 주문 — 실제 주문은 내지 않고 들어오는 체결·호가로 체결 여부를 정한다.
//
// 체결 규칙(보수적으로):
//   시장가    보이는 반대 호가를 차례로 먹되 단계마다 한 틱 불리하게, 보이는 잔량을 넘는 나머지는 마지막 단계에서 두 틱 불리하게.
//             호가가 없는 종목(수집기가 체결만 구독)은 시장가를 받지 않는다.
//   지정가    낼 때 바로 체결되는 부분(매수가 ≥ 매도1호가)은 호가 잔량만큼 그 값에 체결. 나머지는 대기열 맨 뒤에 선다.
//             이미 가져간 반대 호가 잔량은 그 가격 단계가 호가에서 사라질 때까지 빼고 본다(같은 물량 두 번 체결 방지).
//             대기열 앞 물량 = 낼 때 같은 가격의 잔량(보이는 단계 밖이면 보이는 잔량 중 최대, 호가를 모르면 무한).
//             같은 가격 체결이 나올 때마다 앞 물량을 깎고, 다 깎이면 남는 만큼 체결. 호가가 줄면 앞 물량도 그 잔량까지 준다.
//             내 가격을 뚫고 체결되면(매수: 더 낮은 체결) 남은 수량 전부 체결. 반대 호가가 내 가격까지 오면 그 잔량(가져간 양 빼고)만큼 체결.
//             단 매수1호가 ≥ 매도1호가인 겹친 호가로는 낼 때든 기다릴 때든 호가로 체결하지 않는다(아래 onBook 설명).
//   지연      낸 뒤 LATENCY_MS 안에 들어온 체결·호가로는 대기 주문이 체결되지 않는다(시장가·즉시 체결분은 예외).
// 비용: 수수료 매수·매도 각 0.015%, 매도 거래세 0.20%(2026-01-01 양도분부터 코스피 거래세 0.05%+농특세 0.15%, 코스닥 0.20% —
//       세계일보 2026-01-05 등 보도 기준, 기재부 원문 [확인 필요]) — scripts/backtest/engine.mjs COST(왕복 0.23%)와 같은 근거
// 매매 내역(trip): 종목 보유가 0에서 생겨 다시 0이 될 때까지를 한 건으로 묶는다(중간 추가 매수·분할 매도 포함).
//   실현손익 = 매도금액 − 매수금액 − 비용(양쪽 수수료·거래세), 수익률 = 실현손익 ÷ 매수금액.
import { EventEmitter } from 'node:events';
import { tickSize, tickUp, tickDown, onTick } from './market.mjs';

export const FEE_RATE = 0.00015;
export const TAX_RATE = 0.0020;
export const LATENCY_MS = 100;
const KEEP = 2000;

export class OrderError extends Error {}
const fail = m => { throw new OrderError(m); };

export class PaperBroker extends EventEmitter {
  constructor({ market, risk = null, cash = 10_000_000, latencyMs = LATENCY_MS } = {}) {
    super();
    this.market = market; this.risk = risk; this.latencyMs = latencyMs;
    this.reset(cash);
  }
  reset(cash = this.startCash) {
    this.startCash = cash; this.cash = cash; this.reserved = 0;
    this.pos = new Map();       // 코드 → { qty, avg(수수료 뺀 평균 단가), feeIn(남은 수량에 붙은 매수 수수료), realized(수수료 반영) }
    this.orders = new Map();    // 미체결만
    this.done = [];             // 끝난 주문(최근 KEEP건)
    this.fills = [];
    this.fees = 0; this.realized = 0; this.nextId = 1;
    this.trips = [];            // 끝난 매매(최근 KEEP건)
    this.openTrips = new Map(); // 코드 → 진행 중인 매매
    // 반대 호가에서 내가 이미 가져간 물량. 실제 시장은 모의 체결을 모르므로 다음 호가에도 같은 잔량이 다시 보인다 —
    // 그 가격 단계가 호가에서 사라질 때까지 기억해 같은 물량을 두 번 사지 않는다. 브로커마다 따로라 호가 객체는 건드리지 않는다.
    this.took = new Map();      // 코드+'buy'|'sell'(내 주문 방향) → Map(가격 → 가져간 수량)
    this.tally = { n: 0, win: 0, loss: 0, pnl: 0, sumRet: 0, winPnl: 0, lossPnl: 0, cum: 0, peak: 0, mdd: 0, best: null, worst: null,
      auto: { n: 0, pnl: 0 }, manual: { n: 0, pnl: 0 } };
  }
  available() { return Math.floor(this.cash - this.reserved); }
  sellable(code) {
    let open = 0;
    for (const o of this.orders.values()) if (o.code === code && o.side === 'sell') open += o.qty - o.filled;
    return (this.pos.get(code)?.qty ?? 0) - open;
  }
  equity() {
    let v = this.cash;
    for (const [code, p] of this.pos) if (p.qty) v += p.qty * (this.market.sym.get(code)?.last || p.avg);
    return v;
  }
  #took(code, side) {
    const k = code + side;
    let m = this.took.get(k);
    if (!m) this.took.set(k, m = new Map());
    return m;
  }
  find(id) { return this.orders.get(id) ?? this.done.find(o => o.id === id) ?? null; }

  place({ code, side, type = 'limit', price, qty, tag = 'manual' }, now) {
    if (!/^\d{6}$/.test(code ?? '')) fail('종목 코드가 이상합니다');
    if (side !== 'buy' && side !== 'sell') fail('매수·매도를 고르세요');
    if (type !== 'limit' && type !== 'market') fail('주문 종류는 지정가·시장가만 됩니다');
    qty = Number(qty);
    if (!(Number.isInteger(qty) && qty >= 1 && qty <= 1e7)) fail('수량은 1주 이상의 정수로 넣으세요');
    const s = this.market.sym.get(code);
    const opp = side === 'buy' ? s?.asks : s?.bids;
    if (type === 'limit') {
      price = Number(price);
      if (!(price > 0)) fail('가격을 0보다 큰 숫자로 넣으세요');
      if (!onTick(price)) fail(`가격이 호가 단위에 맞지 않습니다(${price > 0 ? tickSize(price) : '-'}원 단위)`);
    } else if (!opp?.length) fail('이 종목은 호가를 받지 않아 시장가를 낼 수 없습니다. 지정가로 내세요');
    if (side === 'sell') {
      const free = this.sellable(code);
      if (qty > free) fail(free > 0 ? `팔 수 있는 수량은 ${free}주입니다` : '팔 주식이 없습니다(공매도 안 함)');
    }
    // 즉시 체결 예상분(시장가는 전부)을 먼저 계산해 증거금과 위험 한도를 본다
    const crossed = s?.bids?.length && s?.asks?.length && s.asks[0][0] <= s.bids[0][0];
    const plan = this.#sweepPlan(side, type, type === 'limit' ? price : null, qty, type === 'limit' && crossed ? [] : opp ?? [], this.#took(code, side));
    const restQty = qty - plan.qty;
    const value = plan.value + (type === 'limit' ? restQty * price : 0);
    const reserve = side === 'buy' ? Math.ceil(value * (1 + FEE_RATE)) : 0;
    if (side === 'buy' && reserve > this.available()) fail(`주문 가능 금액이 모자랍니다(필요 ${reserve.toLocaleString()}원, 가능 ${this.available().toLocaleString()}원)`);
    this.risk?.check({ code, side, qty, value }, this);

    const o = { id: this.nextId++, code, side, type, price: type === 'limit' ? price : null, qty, filled: 0, avgFill: 0,
      status: 'open', tag, at: now, activeAt: now + this.latencyMs, reserve, queue: Infinity, endAt: 0, reason: '' };
    this.reserved += reserve;
    this.emit('order', o);
    const tk = this.#took(code, side);
    for (const [px, q, lvP] of plan.fills) {
      if (lvP != null) tk.set(lvP, (tk.get(lvP) ?? 0) + q);
      this.#fill(o, px, q, now);
    }
    if (o.status !== 'open') return o;
    if (type === 'market') { this.#close(o, 'canceled', now, '호가 부족'); return o; }   // 계획상 생기지 않음
    o.queue = this.#queueAhead(o, s);
    this.orders.set(o.id, o);
    return o;
  }

  // 반대 호가를 차례로 먹는 계획. 지정가는 가격 한도 안에서만, 시장가는 단계마다 한 틱 불리하게 + 넘치면 두 틱.
  #sweepPlan(side, type, limit, qty, opp, tk) {
    const fills = [];
    let left = qty, value = 0;
    for (const [p, v] of opp) {
      if (left <= 0) break;
      if (type === 'limit' && (side === 'buy' ? p > limit : p < limit)) break;
      const take = Math.min(v - (tk.get(p) ?? 0), left);
      if (take <= 0) continue;
      const px = type === 'market' ? (side === 'buy' ? tickUp(p) : tickDown(p)) : p;
      fills.push([px, take, p]); value += px * take; left -= take;
    }
    if (type === 'market' && left > 0) {
      const lastP = opp.at(-1)[0];
      const px = side === 'buy' ? tickUp(lastP, 2) : tickDown(lastP, 2);
      fills.push([px, left, null]); value += px * left; left = 0;
    }
    return { fills, qty: qty - left, value };
  }

  #queueAhead(o, s) {
    const same = o.side === 'buy' ? s?.bids : s?.asks;
    if (!same?.length) return Infinity;            // 호가를 모르면 뚫고 체결될 때만 체결
    const best = same[0][0];
    if (o.side === 'buy' ? o.price > best : o.price < best) return 0;   // 호가 사이에 새로 선 가격 — 맨 앞
    const lv = same.find(x => x[0] === o.price);
    return lv ? lv[1] : Math.max(...same.map(x => x[1]));
  }

  #fill(o, px, qty, now) {
    if (qty <= 0) return;
    const amt = px * qty;
    const fee = amt * FEE_RATE + (o.side === 'sell' ? amt * TAX_RATE : 0);
    const p = this.pos.get(o.code) ?? { qty: 0, avg: 0, feeIn: 0, realized: 0 };
    let pnl = null;
    if (o.side === 'buy') {
      p.avg = (p.avg * p.qty + amt) / (p.qty + qty); p.qty += qty; p.feeIn += fee;
      this.cash -= amt + fee;
      const rel = o.filled + qty >= o.qty ? o.reserve : Math.min(o.reserve, Math.ceil(o.reserve * qty / (o.qty - o.filled)));
      o.reserve -= rel; this.reserved -= rel;
    } else {
      const feeIn = p.qty ? p.feeIn * qty / p.qty : 0;
      pnl = (px - p.avg) * qty - fee - feeIn;
      p.feeIn -= feeIn; p.qty -= qty; p.realized += pnl; this.realized += pnl;
      if (!p.qty) { p.avg = 0; p.feeIn = 0; }
      this.cash += amt - fee;
    }
    this.pos.set(o.code, p);
    this.fees += fee;
    o.avgFill = (o.avgFill * o.filled + amt) / (o.filled + qty); o.filled += qty;
    const f = { order: o.id, code: o.code, side: o.side, px, qty, fee, pnl, at: now, tag: o.tag };
    this.fills.push(f);
    if (this.fills.length > KEEP) this.fills.splice(0, this.fills.length - KEEP);
    const trip = this.#tripFill(o, amt, qty, fee, pnl, now, p.qty);
    this.emit('fill', f, o);
    if (trip) this.emit('trip', trip);
    if (o.filled >= o.qty) this.#close(o, 'filled', now);
  }

  // 체결 하나를 진행 중인 매매에 더한다. 보유가 0이 되면 그 매매를 끝내 돌려준다.
  #tripFill(o, amt, qty, fee, pnl, now, left) {
    let t = this.openTrips.get(o.code);
    if (!t) {
      t = { code: o.code, tag: o.tag, openAt: now, closeAt: 0, buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0, cost: 0, pnl: 0, ret: 0 };
      this.openTrips.set(o.code, t);
    } else if (t.tag !== o.tag) t.tag = 'mixed';
    if (o.side === 'buy') { t.buyQty += qty; t.buyAmt += amt; }
    else { t.sellQty += qty; t.sellAmt += amt; t.pnl += pnl; }
    t.cost += fee;
    if (left > 0) return null;
    this.openTrips.delete(o.code);
    t.closeAt = now;
    t.ret = t.buyAmt ? t.pnl / t.buyAmt * 100 : 0;
    this.trips.push(t);
    if (this.trips.length > KEEP) this.trips.splice(0, this.trips.length - KEEP);
    const s = this.tally;
    s.n++; s.pnl += t.pnl; s.sumRet += t.ret;
    if (t.pnl > 0) { s.win++; s.winPnl += t.pnl; } else if (t.pnl < 0) { s.loss++; s.lossPnl += t.pnl; }
    s.cum += t.pnl; s.peak = Math.max(s.peak, s.cum); s.mdd = Math.max(s.mdd, s.peak - s.cum);
    if (!s.best || t.pnl > s.best.pnl) s.best = t;
    if (!s.worst || t.pnl < s.worst.pnl) s.worst = t;
    const by = t.tag === 'auto' ? s.auto : t.tag === 'manual' ? s.manual : null;
    if (by) { by.n++; by.pnl += t.pnl; }
    return t;
  }

  // 수익률 요약 — 총 수익률은 평가자산 기준(보유 중인 종목의 평가손익 포함), 나머지는 끝난 매매 기준
  stats() {
    const s = this.tally, r = v => Math.round(v), r2 = v => Math.round(v * 100) / 100;
    const equity = this.equity();
    const avgWin = s.win ? s.winPnl / s.win : null, avgLoss = s.loss ? s.lossPnl / s.loss : null;
    return {
      trips: s.n, win: s.win, loss: s.loss, winRate: s.n ? r2(s.win / s.n * 100) : null,
      pnl: r(s.pnl), avgPnl: s.n ? r(s.pnl / s.n) : null, avgRet: s.n ? r2(s.sumRet / s.n) : null,
      avgWin: avgWin == null ? null : r(avgWin), avgLoss: avgLoss == null ? null : r(avgLoss),
      payoff: avgWin != null && avgLoss ? r2(avgWin / -avgLoss) : null,
      mdd: r(s.mdd), best: s.best && pubTrip(s.best), worst: s.worst && pubTrip(s.worst),
      auto: { n: s.auto.n, pnl: r(s.auto.pnl) }, manual: { n: s.manual.n, pnl: r(s.manual.pnl) },
      fees: r(this.fees), totalRet: r2((equity - this.startCash) / this.startCash * 100),
      realizedRet: r2(this.realized / this.startCash * 100), holding: this.openTrips.size,
    };
  }

  #close(o, status, now, reason = '') {
    if (o.status !== 'open') return;
    o.status = status; o.endAt = now; o.reason = reason;
    this.reserved -= o.reserve; o.reserve = 0;
    this.orders.delete(o.id);
    this.done.push(o);
    if (this.done.length > KEEP) this.done.splice(0, this.done.length - KEEP);
    this.emit('order', o);
  }

  cancel(id, now, reason = '취소') {
    const o = this.orders.get(id);
    if (!o) fail('미체결 주문이 아닙니다(이미 체결됐거나 취소됨)');
    this.#close(o, 'canceled', now, reason);
    return o;
  }
  cancelAll(now, reason = '전체 취소', pred = () => true) {
    const ids = [...this.orders.values()].filter(pred).map(o => o.id);
    for (const id of ids) this.cancel(id, now, reason);
    return ids.length;
  }

  onTrade([recv, code, price, qty]) {
    for (const o of [...this.orders.values()]) {
      if (o.code !== code || recv < o.activeAt) continue;
      const rem = o.qty - o.filled;
      if (o.side === 'buy' ? price < o.price : price > o.price) { this.#fill(o, o.price, rem, recv); continue; }
      if (price === o.price) {
        o.queue -= qty;
        if (o.queue < 0) { const take = Math.min(rem, -o.queue); o.queue = 0; this.#fill(o, o.price, take, recv); }
      }
    }
  }

  onBook([recv, code]) {
    const s = this.market.sym.get(code);
    if (!s) return;
    // 가져간 물량 기억은 그 가격 단계가 호가에서 사라지면 잊는다(새로 생긴 단계는 새 물량)
    for (const side of ['buy', 'sell']) {
      const tk = this.took.get(code + side);
      if (!tk?.size) continue;
      const opp = side === 'buy' ? s.asks : s.bids;
      for (const p of tk.keys()) if (!opp.some(x => x[0] === p)) tk.delete(p);
    }
    const crossed = s.bids.length && s.asks.length && s.asks[0][0] <= s.bids[0][0];
    for (const o of [...this.orders.values()]) {
      if (o.code !== code) continue;
      const same = o.side === 'buy' ? s.bids : s.asks, opp = o.side === 'buy' ? s.asks : s.bids;
      // 대기열 앞 물량은 같은 가격 잔량을 넘을 수 없고, 내가 최우선보다 좋은 가격이면 맨 앞이다
      if (same.length) {
        const best = same[0][0];
        if (o.side === 'buy' ? o.price > best : o.price < best) o.queue = 0;
        else { const lv = same.find(x => x[0] === o.price); if (lv && lv[1] < o.queue) o.queue = lv[1]; }
      }
      if (recv < o.activeAt || !opp.length) continue;
      // 매수1호가 ≥ 매도1호가(겹친 호가)가 장중 호가의 약 9%(10-16 기록). 두 시장(KRX·NXT) 호가를 합친 화면으로 보인다 [확인 필요].
      // 다른 시장 호가끼리는 맞붙지 않으므로 이때는 호가로 체결을 정하지 않고 체결 기록만 쓴다.
      if (crossed) continue;
      // 내 가격까지 들어온 반대 호가 중 아직 가져가지 않은 물량만큼만 내 가격에 체결
      const rem = o.qty - o.filled, tk = this.#took(code, o.side);
      let got = 0;
      for (const [p, v] of opp) {
        if (got >= rem || (o.side === 'buy' ? p > o.price : p < o.price)) break;
        const q = Math.min(rem - got, v - (tk.get(p) ?? 0));
        if (q > 0) { tk.set(p, (tk.get(p) ?? 0) + q); got += q; }
      }
      if (got > 0) { o.queue = 0; this.#fill(o, o.price, got, recv); }
    }
  }

  snapshot() {
    const positions = [];
    for (const [code, p] of this.pos) {
      if (!p.qty && !p.realized) continue;
      const last = this.market.sym.get(code)?.last || p.avg;
      positions.push({ code, qty: p.qty, avg: Math.round(p.avg * 100) / 100, last, eval: p.qty * last,
        unreal: Math.round((last - p.avg) * p.qty), realized: Math.round(p.realized), sellable: this.sellable(code) });
    }
    const equity = this.equity();
    return {
      startCash: this.startCash, cash: Math.round(this.cash), available: this.available(), equity: Math.round(equity),
      pnl: Math.round(equity - this.startCash), realized: Math.round(this.realized), fees: Math.round(this.fees),
      positions, open: [...this.orders.values()].map(pub), done: this.done.slice(-60).reverse().map(pub),
      fills: this.fills.slice(-100).reverse().map(f => ({ ...f, fee: Math.round(f.fee), pnl: f.pnl == null ? null : Math.round(f.pnl) })),
      trips: this.trips.slice(-200).reverse().map(pubTrip), stats: this.stats(),
    };
  }
}
export const pubTrip = t => ({ code: t.code, tag: t.tag, openAt: t.openAt, closeAt: t.closeAt, qty: t.buyQty,
  buyAvg: Math.round(t.buyAmt / t.buyQty * 100) / 100, sellAvg: t.sellQty ? Math.round(t.sellAmt / t.sellQty * 100) / 100 : null,
  buyAmt: Math.round(t.buyAmt), sellAmt: Math.round(t.sellAmt), cost: Math.round(t.cost), pnl: Math.round(t.pnl), ret: Math.round(t.ret * 100) / 100 });
const pub = o => ({ id: o.id, code: o.code, side: o.side, type: o.type, price: o.price, qty: o.qty, filled: o.filled,
  avgFill: Math.round(o.avgFill * 100) / 100, status: o.status, tag: o.tag, at: o.at, endAt: o.endAt, reason: o.reason,
  queue: Number.isFinite(o.queue) ? o.queue : null });
