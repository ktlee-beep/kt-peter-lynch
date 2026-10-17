// 설정으로 바꿀 수 있는 자동 규칙(RuleTrader) — learn.mjs 가 수백 가지 설정을 저장된 날에 돌려 고른다.
// PassiveScalp 와 같은 모양(step·rounds·log·stats·enabled)이라 엔진에 그대로 끼울 수 있다.
//
//   진입 조건(모두 만족) : 시간 창, 매수·매도 1호가 차이 ≤ maxSpreadTicks, 매수 잔량합 ÷ 매도 잔량합이 [imbMin, imbMax],
//                          최근 flowSec 초 매수 체결 비중이 [flowMin, flowMax], 최근 retSec 초 등락률이 [retMin, retMax],
//                          시가 대비 등락률이 [dayMin, dayMax], 최근 60초 거래대금 ≥ val60Min,
//                          breakMin > 0 이면 지금 값이 직전 breakMin 분 고가를 넘음, 가격 ≥ minPrice.
//   진입 방식            : passive = 매수 1호가에 지정가(안 사지면 entryWaitSec 뒤 취소)
//                          taker   = 매도 1호가에 지정가(보이는 잔량만큼 바로 체결, 남은 건 1초 뒤 취소)
//   청산                 : 익절 = 평균가 +tpPct% 지정가(비용을 못 넘으면 넘는 첫 호가),
//                          손절 = 평균가 −slPct% 이하 체결, 추적 = 고점이 +trailStart% 를 넘은 뒤 고점 −trailPct%,
//                          시간 = holdSec 초, 장 마감 전 flatAt 에 전부 청산.
//                          청산 주문은 exit='bid' 면 매수 1호가 지정가(1초마다 다시 걸고 5초 넘으면 시장가), 'market' 이면 시장가.
//   보수 모드(stress)    : taker 진입을 시장가(단계마다 1틱 불리)로, 청산을 전부 시장가로 낸다 — 학습 결과가 체결 가정에 기대는지 본다.
//   쉼                   : 한 판 끝나면 그 종목 coolSec 초 쉼, 한 종목 하루 maxPerCode 판까지, 동시에 maxActive 종목.
import { tickUp, tickSize } from './market.mjs';
import { OrderError, FEE_RATE, TAX_RATE } from './paper-broker.mjs';

export const RULE_DEFAULTS = {
  entry: 'passive', maxSpreadTicks: 1, imbMin: 0, imbMax: Infinity, flowSec: 60, flowMin: 0, flowMax: 1, retSec: 60, retMin: -Infinity, retMax: Infinity,
  dayMin: -Infinity, dayMax: Infinity, val60Min: 0, breakMin: 0, minPrice: 1000,
  tpPct: 0.6, slPct: 0.5, trailStart: 0, trailPct: 0, holdSec: 120, entryWaitSec: 30, chaseTicks: 2,
  exit: 'bid', start: '09:00:30', end: '15:10:00', flatAt: '15:18:00',
  budget: 1_000_000, coolSec: 60, maxPerCode: 99, maxActive: 5, stress: false,
};
const LOG_KEEP = 300;
// 'HH:MM:SS' → 한국 시각 하루 안의 ms (날짜 문자열을 만들지 않아 빠르다)
const hmsMs = hms => { const [h, m, x = 0] = hms.split(':').map(Number); return ((h * 60 + m) * 60 + x) * 1000; };
const dayMs = now => (now + 9 * 3600e3) % 86400e3;

// ── 시세 특징(같은 시각·같은 종목이면 여러 규칙이 나눠 쓴다) ─────────────────────────
function memo(s, now, key, f) {
  if (s._fAt !== now || s._fSeq !== s.tradeSeq) { s._fAt = now; s._fSeq = s.tradeSeq; s._f = new Map(); }
  let v = s._f.get(key);
  if (v === undefined) { v = f(); s._f.set(key, v); }
  return v;
}
// retSec 초 전 값 대비 등락률(%) — 1초 봉에서 그 시각 이전 마지막 봉의 종가
export function retPct(s, now, sec) {
  return memo(s, now, 'r' + sec, () => {
    const arr = s.sec, cut = Math.floor(now / 1000) - sec;
    let lo = 0, hi = arr.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].time <= cut) { at = m; lo = m + 1; } else hi = m - 1; }
    const p = at >= 0 ? arr[at].close : s.open;
    return p ? (s.last - p) / p * 100 : 0;
  });
}
// 최근 sec 초 매수 체결 비중(0~1). 체결이 없으면 0.5
export function flowRatio(s, now, sec) {
  return memo(s, now, 'f' + sec, () => {
    const cut = now - sec * 1000;
    let b = 0, d = 0;
    for (let i = s.trades.length - 1; i >= 0; i--) {
      const t = s.trades[i];
      if (t[0] < cut) break;
      if (t[3] > 0) b += t[2]; else if (t[3] < 0) d += t[2];
    }
    return b + d ? b / (b + d) : 0.5;
  });
}
// 최근 sec 초 거래대금(원, 1초 봉 종가×거래량 근사)
export function valueIn(s, now, sec) {
  return memo(s, now, 'v' + sec, () => {
    const cut = Math.floor(now / 1000) - sec;
    let v = 0;
    for (let i = s.sec.length - 1; i >= 0 && s.sec[i].time > cut; i--) v += s.sec[i].close * s.sec[i].volume;
    return v;
  });
}
// 직전 n 분(지금 분 제외) 고가. 기록이 모자라면 Infinity(돌파 판정 안 함)
export function priorHigh(s, now, n) {
  return memo(s, now, 'h' + n, () => {
    const cur = Math.floor(now / 60000) * 60, from = cur - n * 60;
    let h = -Infinity, seen = 0;
    for (let i = s.min.length - 1; i >= 0 && s.min[i].time >= from; i--) {
      if (s.min[i].time >= cur) continue;
      seen++; if (s.min[i].high > h) h = s.min[i].high;
    }
    return seen >= Math.min(n, 3) ? h : Infinity;
  });
}

const sellBreakEven = avg => { let px = Math.ceil(avg / tickSize(avg)) * tickSize(avg); while (px * (1 - FEE_RATE - TAX_RATE) <= avg * (1 + FEE_RATE)) px = tickUp(px); return px; };

export class RuleTrader {
  constructor({ broker, risk, opts = {} }) {
    this.broker = broker; this.risk = risk; this.o = { ...RULE_DEFAULTS, ...opts };
    this.at = { start: hmsMs(this.o.start), end: hmsMs(this.o.end), flat: hmsMs(this.o.flatAt) };
    this.enabled = false;
    this.st = new Map(); this.cool = new Map(); this.count = new Map();
    this.log = []; this.rounds = []; this.quiet = false;
    broker.on('fill', (f, o) => { if (o.tag === 'auto') this.#onFill(f); });
    broker.on('order', o => { if (o.tag === 'auto' && o.status !== 'open') this.#onClosed(o); });
  }
  #note(now, code, msg) {
    if (this.quiet) return;
    this.log.push({ at: now, code, msg });
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
  }
  #place(now, code, side, type, price, qty) {
    try { return this.broker.place({ code, side, type, price, qty, tag: 'auto' }, now); }
    catch (e) {
      if (!(e instanceof OrderError)) throw e;
      this.#note(now, code, `${side === 'buy' ? '매수' : '매도'} 거절: ${e.message}`);
      this.cool.set(code, now + 60_000);
      return null;
    }
  }

  // kind: 'trade'|'book'(없으면 둘 다로 본다). 진입 판단은 체결 때만 한다.
  step(s, now, kind) {
    const st = this.st.get(s.code);
    if (st) return this.#manage(s, st, now);
    if (!this.enabled || this.risk?.halted || kind === 'book') return;
    const o = this.o;
    if (this.st.size >= o.maxActive || (this.cool.get(s.code) ?? 0) > now) return;
    if ((this.count.get(s.code) ?? 0) >= o.maxPerCode) return;
    const t = dayMs(now);
    if (t < this.at.start || t >= this.at.end) return;
    const bid = s.bids[0]?.[0], ask = s.asks[0]?.[0];
    if (!bid || !ask || ask <= bid || bid < o.minPrice) return;
    if (ask - bid > o.maxSpreadTicks * tickSize(bid)) return;
    if (o.imbMin > 0 && !(s.askSum > 0 && s.bidSum / s.askSum >= o.imbMin)) return;
    if (o.imbMax < Infinity && !(s.askSum > 0 && s.bidSum / s.askSum <= o.imbMax)) return;
    if (s.open) { const d = (s.last - s.open) / s.open * 100; if (d < o.dayMin || d > o.dayMax) return; }
    if (o.retMin > -Infinity || o.retMax < Infinity) { const r = retPct(s, now, o.retSec); if (r < o.retMin || r > o.retMax) return; }
    if (o.flowMin > 0 || o.flowMax < 1) { const f = flowRatio(s, now, o.flowSec); if (f < o.flowMin || f > o.flowMax) return; }
    if (o.val60Min > 0 && valueIn(s, now, 60) < o.val60Min) return;
    if (o.breakMin > 0 && !(s.last > priorHigh(s, now, o.breakMin))) return;
    if (this.broker.pos.get(s.code)?.qty) return;
    for (const x of this.broker.orders.values()) if (x.code === s.code) return;
    const px = o.entry === 'taker' ? ask : bid;
    const qty = Math.floor(o.budget / px);
    if (qty < 1) return;
    const ord = o.stress && o.entry === 'taker' ? this.#place(now, s.code, 'buy', 'market', null, qty) : this.#place(now, s.code, 'buy', 'limit', px, qty);
    if (!ord) return;
    this.count.set(s.code, (this.count.get(s.code) ?? 0) + 1);
    this.st.set(s.code, { phase: 'entering', buyId: ord.id, sellId: null, exitId: null, exitAt: 0, entryAt: now, fillAt: ord.filled ? now : 0, avg: 0, peak: 0, pnl: 0, qty: ord.filled, buyPx: px });
    this.#note(now, s.code, `진입 주문 ${px.toLocaleString()}원 × ${qty}주`);
    if (ord.status === 'open') return;
    // 바로 다 체결(또는 바로 끝남) — place 안에서 난 체결은 아직 상태가 없어 여기서 채운다
    if (ord.filled > 0) this.#afterBuy(s.code, now);
    else this.st.delete(s.code);
  }

  #manage(s, st, now) {
    if (this.risk?.halted) return;
    const o = this.o;
    const pos = this.broker.pos.get(s.code)?.qty ?? 0;
    if (st.phase === 'entering') {
      const buy = this.broker.orders.get(st.buyId);
      if (!buy) return;
      const wait = o.entry === 'taker' ? 1000 : o.entryWaitSec * 1000;
      const away = o.entry === 'passive' && s.bids[0]?.[0] >= tickUp(buy.price, o.chaseTicks);
      if (now - st.entryAt > wait || away || dayMs(now) >= this.at.flat) this.broker.cancel(buy.id, now, away ? '호가가 멀어짐' : '진입 대기 끝');
      return;
    }
    if (pos <= 0) {
      // 손 청산 등으로 보유가 0인데 상태가 남았다 — 남은 자동 주문이 없으면 판을 끝낸다
      for (const x of this.broker.orders.values()) if (x.code === s.code && x.tag === 'auto') return;
      this.rounds.push({ code: s.code, entryAt: st.entryAt, fillAt: st.fillAt, exitAt: now, qty: st.qty, avg: Math.round(st.avg), pnl: Math.round(st.pnl), how: 'manual' });
      this.st.delete(s.code); this.cool.set(s.code, now + o.coolSec * 1000);
      return;
    }
    if (st.phase === 'holding') {
      if (!st.sellId) return this.#afterBuy(s.code, now);
      const last = s.last;
      if (last > st.peak) st.peak = last;
      let stopPx = st.avg * (1 - o.slPct / 100);
      if (o.trailPct > 0 && st.peak >= st.avg * (1 + o.trailStart / 100)) stopPx = Math.max(stopPx, st.peak * (1 - o.trailPct / 100));
      const why = last && last <= stopPx ? '손절·추적' : now - st.fillAt > o.holdSec * 1000 ? '시간 청산' : dayMs(now) >= this.at.flat ? '장 마감 청산' : null;
      if (why) this.#exit(s, st, now, why);
      return;
    }
    if (st.phase === 'exiting') {
      // 매수 1호가 지정가로 내놨는데 1초 넘게 안 팔리면 새 호가로 다시, 5초 넘으면 시장가
      const ex = st.exitId && this.broker.orders.get(st.exitId);
      if (ex && now - ex.at > 1000) {
        this.broker.cancel(ex.id, now, '청산 다시 걸기');
        this.#exitOrder(s, st, now, now - st.exitAt > 5000 ? 'market' : o.exit);
      } else if (!ex) this.#exitOrder(s, st, now, now - st.exitAt > 5000 ? 'market' : o.exit);
    }
  }

  #exit(s, st, now, why) {
    st.phase = 'exiting'; st.exitAt = now;
    if (st.sellId && this.broker.orders.has(st.sellId)) this.broker.cancel(st.sellId, now, why);
    st.sellId = null;
    this.#note(now, s.code, `${why} → 청산`);
    this.#exitOrder(s, st, now, this.o.exit);
  }
  #exitOrder(s, st, now, how) {
    const qty = this.broker.sellable(s.code);
    if (qty <= 0) return;
    if (this.o.stress) how = 'market';
    const bid = s.bids[0]?.[0];
    const ord = how === 'bid' && bid ? this.#place(now, s.code, 'sell', 'limit', bid, qty) : this.#place(now, s.code, 'sell', 'market', null, qty);
    st.exitId = ord && ord.status === 'open' ? ord.id : null;
  }

  #afterBuy(code, now) {
    const st = this.st.get(code);
    const p = this.broker.pos.get(code);
    if (!st || !p?.qty) return;
    if (st.phase === 'entering') { st.phase = 'holding'; st.peak = p.avg; }
    st.avg = p.avg; st.fillAt = st.fillAt || now;
    if (st.phase !== 'holding' || this.risk?.halted || this.broker.sellable(code) <= 0) return;
    const want = p.avg * (1 + this.o.tpPct / 100);
    let px = Math.ceil(want / tickSize(want)) * tickSize(want);
    px = Math.max(px, sellBreakEven(p.avg));
    const o = this.#place(now, code, 'sell', 'limit', px, this.broker.sellable(code));
    if (o) st.sellId = o.status === 'open' ? o.id : null;
  }

  #onFill(f) {
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
      else { this.st.delete(o.code); this.cool.set(o.code, now + 10_000); }
      return;
    }
    if ((this.broker.pos.get(o.code)?.qty ?? 0) === 0 && !this.broker.orders.has(st.buyId)) {
      const r = { code: o.code, entryAt: st.entryAt, fillAt: st.fillAt, exitAt: now, qty: st.qty, avg: Math.round(st.avg), pnl: Math.round(st.pnl), how: o.id === st.sellId ? 'tp' : 'exit' };
      this.rounds.push(r);
      this.st.delete(o.code); this.cool.set(o.code, now + this.o.coolSec * 1000);
      // 남은 청산 주문 정리(상태를 먼저 지워 같은 판을 두 번 세지 않는다)
      for (const x of [...this.broker.orders.values()]) if (x.code === o.code && x.tag === 'auto') this.broker.cancel(x.id, now, '한 판 끝');
      this.#note(now, o.code, `한 판 끝 ${r.pnl >= 0 ? '+' : ''}${r.pnl.toLocaleString()}원`);
    } else if (o.id === st.sellId) st.sellId = null;
    else if (o.id === st.exitId) st.exitId = null;
  }

  stats() {
    const n = this.rounds.length, win = this.rounds.filter(r => r.pnl > 0).length;
    const pnl = this.rounds.reduce((a, r) => a + r.pnl, 0);
    return { enabled: this.enabled, active: this.st.size, rounds: n, win, winRate: n ? Math.round(win / n * 1000) / 10 : null,
      pnl, avg: n ? Math.round(pnl / n) : null, opts: this.o };
  }
}
