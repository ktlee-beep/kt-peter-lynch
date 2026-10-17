// 종목별 실시간 상태 — 마지막 체결, 1초·1분 봉, 최근 체결 목록, 호가, 체결강도.
// 수집기 행 형식(scripts/backtest/stream-collector.mjs 머리말):
//   trade 행: [수신ms, 코드, 가격, 수량, 체결ms]
//   book  행: [수신ms, 코드, 호가ms, [매수1가,매수1량,..], [매도1가,..], 매수10단계합, 매도10단계합]
//   저장 파일은 3단계, 실시간 내보내기(4791 /feed)는 10단계.

// KRX 호가가격단위(2023-01-25 통합) — scripts/backtest/measure-pullback.mjs tick() 과 같은 표 [확인 필요]
export function tickSize(p) {
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}
export const tickUp = (p, n = 1) => { for (let i = 0; i < n; i++) p += tickSize(p); return p; };
// 경계 바로 위 가격(예: 2000)에서 한 칸 내리면 아래 구간 단위(5)가 아니라 1 이 빠져야 한다 — p-1 의 단위를 쓴다
export const tickDown = (p, n = 1) => { for (let i = 0; i < n; i++) p -= tickSize(p - 1); return p; };
export const onTick = p => Number.isInteger(p) && p > 0 && p % tickSize(p) === 0;

const SEC_KEEP = 4 * 3600;   // 1초 봉은 종목당 최근 4시간만(전 종목·하루치를 다 들고 있으면 메모리가 수백 MB)
const TRADES_KEEP = 300;

function pairs(flat) {
  const out = [];
  for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) if (flat[i] > 0) out.push([flat[i], flat[i + 1]]);
  return out;
}

export class Market {
  constructor() { this.sym = new Map(); this.seq = 0; }
  get(code) {
    let s = this.sym.get(code);
    if (!s) {
      s = { code, last: 0, open: 0, high: 0, low: 0, vol: 0, value: 0, buyVol: 0, sellVol: 0, prev: 0,
        bids: [], asks: [], bidSum: 0, askSum: 0, bookAt: 0, lastAt: 0, trades: [], tradeSeq: 0, sec: [], min: [] };
      this.sym.set(code, s);
    }
    return s;
  }
  // 매수·매도 체결 구분: 직전 호가가 있으면 매도1호가 이상 = 매수 체결, 매수1호가 이하 = 매도 체결,
  // 호가 사이·호가 없음이면 직전 체결가보다 오르면 매수·내리면 매도·같으면 직전 방향(틱 규칙).
  onTrade(row) {
    const [recv, code, price, qty, ts] = row;
    if (!(price > 0) || !(qty > 0)) return null;
    const s = this.get(code);
    const t = Number.isFinite(ts) ? ts : recv;
    let side;
    const bid = s.bids[0]?.[0], ask = s.asks[0]?.[0];
    if (ask && price >= ask) side = 1;
    else if (bid && price <= bid) side = -1;
    else if (s.last) side = price > s.last ? 1 : price < s.last ? -1 : (s.lastSide ?? 0);
    else side = 0;
    s.lastSide = side;
    if (!s.open) { s.open = s.high = s.low = price; }
    s.prev = s.last; s.last = price; s.lastAt = t;
    if (price > s.high) s.high = price;
    if (price < s.low) s.low = price;
    s.vol += qty; s.value += price * qty;
    if (side > 0) s.buyVol += qty; else if (side < 0) s.sellVol += qty;
    s.tradeSeq++;
    s.trades.push([t, price, qty, side]);
    if (s.trades.length > TRADES_KEEP) s.trades.splice(0, s.trades.length - TRADES_KEEP);
    bar(s.sec, Math.floor(t / 1000), price, qty, SEC_KEEP);
    bar(s.min, Math.floor(t / 60000) * 60, price, qty, 0);
    this.seq++;
    return s;
  }
  onBook(row) {
    const [recv, code, ts, b, a, sb, sa] = row;
    const s = this.get(code);
    s.bids = pairs(b); s.asks = pairs(a);
    s.bidSum = sb ?? 0; s.askSum = sa ?? 0;
    s.bookAt = Number.isFinite(ts) ? ts : recv;
    this.seq++;
    return s;
  }
  // 체결강도 = 매수 체결량 / 매도 체결량 × 100 (국내 HTS 관례). 매도 체결이 없으면 null.
  static strength(s) { return s.sellVol ? Math.round(s.buyVol / s.sellVol * 1000) / 10 : null; }
  summary(s) {
    return { code: s.code, last: s.last, open: s.open, high: s.high, low: s.low, vol: s.vol, value: s.value,
      chgOpen: s.open ? Math.round((s.last - s.open) / s.open * 10000) / 100 : 0, strength: Market.strength(s),
      bid: s.bids[0]?.[0] ?? null, ask: s.asks[0]?.[0] ?? null, lastAt: s.lastAt };
  }
}

// 봉 배열 끝에 붙이거나 갱신한다. 시각이 거꾸로 온 체결(연결 2개의 도착 순서 차)은 해당 봉을 찾아 고친다.
function bar(arr, t, p, q, keep) {
  const last = arr.at(-1);
  if (last && last.time === t) {
    if (p > last.high) last.high = p;
    if (p < last.low) last.low = p;
    last.close = p; last.volume += q;
    return;
  }
  if (last && t < last.time) {
    for (let i = arr.length - 1; i >= 0 && arr[i].time >= t; i--) {
      if (arr[i].time === t) { const b = arr[i]; b.high = Math.max(b.high, p); b.low = Math.min(b.low, p); b.volume += q; return; }
    }
    return;   // 이미 지나간 빈 칸 — 늦게 온 1건 때문에 봉을 끼워 넣지 않는다
  }
  arr.push({ time: t, open: p, high: p, low: p, close: p, volume: q });
  if (keep && arr.length > keep * 1.1) arr.splice(0, arr.length - keep);
}
