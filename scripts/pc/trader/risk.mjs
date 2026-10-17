// 위험 관리 — 주문 한 번·종목당 보유·하루 손실·미체결 개수 한도, 그리고 전체 정지.
// 정지(halt)는 미체결을 모두 취소하고 자동매매를 멈춘다. 보유 주식은 그대로 둔다(청산은 따로 누른다).
// 손실 한도는 시작 자금 대비 평가손익(실현+미실현, 비용 포함)으로 본다.
import { OrderError } from './paper-broker.mjs';

export const DEFAULT_LIMITS = {
  maxOrderValue: 3_000_000,   // 주문 한 번 최대 금액
  maxPosValue: 5_000_000,     // 종목당 보유(매수 대기 포함) 최대 금액
  maxDailyLoss: 300_000,      // 하루 손실 한도(시작 자금 1천만 원의 3%)
  maxOpenOrders: 20,
};

export class Risk {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.halted = false; this.haltReason = ''; this.haltAt = 0;
  }
  // 위반이면 OrderError 를 던진다. 매도(보유 줄이기)는 정지 중에도 받는다 — 손실을 줄이는 길은 열어 둔다.
  check({ code, side, value }, broker) {
    const L = this.limits;
    if (side === 'sell') return;
    if (this.halted) throw new OrderError(`전체 정지 중입니다(${this.haltReason}). 재개를 누르기 전에는 매수할 수 없습니다`);
    if (value > L.maxOrderValue) throw new OrderError(`주문 한 번 한도 ${won(L.maxOrderValue)}을 넘습니다(${won(value)})`);
    if (broker.orders.size >= L.maxOpenOrders) throw new OrderError(`미체결 주문이 ${L.maxOpenOrders}건이라 더 낼 수 없습니다`);
    const p = broker.pos.get(code);
    const last = broker.market.sym.get(code)?.last || p?.avg || 0;
    let exposure = (p?.qty ?? 0) * last;
    for (const o of broker.orders.values()) if (o.code === code && o.side === 'buy') exposure += (o.qty - o.filled) * (o.price ?? last);
    if (exposure + value > L.maxPosValue) throw new OrderError(`종목당 보유 한도 ${won(L.maxPosValue)}을 넘습니다(현재 ${won(exposure)} + 주문 ${won(value)})`);
    const loss = broker.startCash - broker.equity();
    if (loss >= L.maxDailyLoss) throw new OrderError(`하루 손실 한도 ${won(L.maxDailyLoss)}에 닿았습니다`);
  }
  // 체결·시세마다 부른다. 한도에 닿으면 스스로 정지한다. 정지했으면 true.
  watch(broker, now) {
    if (this.halted) return false;
    const loss = broker.startCash - broker.equity();
    if (loss >= this.limits.maxDailyLoss) { this.halt(broker, now, `하루 손실 한도 도달(-${won(Math.round(loss))})`); return true; }
    return false;
  }
  halt(broker, now, reason = '수동 전체 정지') {
    this.halted = true; this.haltReason = reason; this.haltAt = now;
    broker.cancelAll(now, '전체 정지');
  }
  resume() { this.halted = false; this.haltReason = ''; }
  usage(broker) {
    const loss = Math.max(0, broker.startCash - broker.equity());
    return { ...this.limits, halted: this.halted, haltReason: this.haltReason, loss: Math.round(loss),
      lossPct: Math.round(loss / this.limits.maxDailyLoss * 1000) / 10 };
  }
}
const won = v => `${Math.round(v).toLocaleString()}원`;
