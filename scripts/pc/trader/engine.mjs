// 매매 엔진 — 시세(Market) · 모의 주문(PaperBroker) · 위험 관리(Risk) · 자동 규칙(PassiveScalp)을 한데 묶고
// 시세 공급원(재생 Replay / 실시간 LiveFeed)을 갈아 끼운다. 행 하나가 들어올 때마다
//   시세 갱신 → 대기 주문 체결 판정 → 자동 규칙 → 손실 한도 감시
// 순서로 같은 스레드에서 처리하므로 "초 단위로 주고받는" 흐름이 재생과 실시간에서 똑같다.
// 실주문은 없다. toss-broker.mjs 는 승인 전까지 생성자부터 막혀 있다.
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Market } from './market.mjs';
import { PaperBroker, OrderError } from './paper-broker.mjs';
import { Risk } from './risk.mjs';
import { PassiveScalp } from './strategy.mjs';
import { Replay, runFast, listDates, kstMs } from './replay.mjs';
import { LiveFeed } from './feed.mjs';

const FLUSH_WAIT_MS = 6000;   // 수집기 파일 쓰기 주기(5초) + 여유
export const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export class Engine extends EventEmitter {
  constructor({ ticksDir, feedUrl, cash = 10_000_000, limits = {}, strategyOpts = {} }) {
    super();
    this.ticksDir = ticksDir; this.feedUrl = feedUrl; this.cash = cash; this.limits = limits; this.strategyOpts = strategyOpts;
    this.mode = 'idle'; this.replay = null; this.feed = null; this.lastRow = 0; this.gen = 0; this.warming = false;
    this.#fresh();
  }
  #fresh() {
    this.market = new Market();
    this.risk = new Risk(this.limits);
    this.broker = new PaperBroker({ market: this.market, risk: this.risk, cash: this.cash });
    this.strategy = new PassiveScalp({ broker: this.broker, risk: this.risk, opts: this.strategyOpts });
    this.lastRow = 0;
    this.gen++;
    this.emit('reset');
  }
  // 새 모의 장부가 시작될 때마다(재생 한 번·실시간 시작 한 번) 알린다 — 매매 장부 저장(ledger.mjs)이 받는다
  #session(s) { this.session = { ...s, startedAt: Date.now() }; this.emit('session', this.session, this.broker); }
  dates() { return listDates(this.ticksDir); }
  now() {
    if (this.mode === 'replay' && this.replay) return Math.max(this.lastRow, Math.floor(this.replay.now()));
    return Date.now();
  }

  dispatch(kind, row, warm = false) {
    if (kind === 'trade') {
      const s = this.market.onTrade(row);
      if (!s || warm) return;
      this.lastRow = row[0];
      this.broker.onTrade(row);
      this.strategy.step(s, row[0]);
    } else if (kind === 'book') {
      const s = this.market.onBook(row);
      if (warm) return;
      this.lastRow = row[0];
      this.broker.onBook(row);
      this.strategy.step(s, row[0]);
    } else return;
    if (this.warming && this.mode === 'replay') this.warming = false;   // 재생 시작 시각에 닿았다
    // 손실 한도에 닿아 스스로 정지하면 자동매매도 끈다(재개해도 사람이 다시 켜야 돈다)
    if (this.broker.pos.size && this.risk.watch(this.broker, row[0])) {
      this.strategy.enabled = false;
      this.emit('note', `${this.risk.haltReason} — 미체결 취소, 자동매매 꺼짐`);
    }
  }
  // 오늘 기록·재생 시작 전 구간을 읽는 동안은 시세가 몇 시간 전 것이라 주문을 받지 않는다
  #ready() { if (this.warming) throw new OrderError('기록을 읽는 중입니다. "실시간 준비 완료"(재생은 시작 시각) 뒤에 주문하세요'); }

  #stopSource() {
    this.replay?.stop(); this.replay = null;
    this.feed?.stop(); this.feed = null;
    this.warming = false;
  }

  // 저장된 날을 다시 돌린다. 모의 장부는 새로 시작한다(지난 시각으로 되돌리면 체결 이력이 맞지 않으므로).
  startReplay({ date, from = '09:00', speed = 1, auto = false } = {}) {
    if (!this.dates().includes(date)) throw new Error(`기록이 없는 날짜입니다: ${date}`);
    if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(from)) throw new Error('시작 시각은 HH:MM 형식입니다(00:00~23:59)');
    this.#stopSource();
    this.#fresh();
    this.strategy.enabled = !!auto;
    this.mode = 'replay'; this.warming = true;
    this.#session({ mode: 'replay', date, from, speed });
    const rp = new Replay({ ticksDir: this.ticksDir, date, from, speed, sink: (k, r, w) => this.dispatch(k, r, w) });
    this.replay = rp;
    rp.on('end', () => { if (this.replay === rp) this.emit('note', `${date} 재생이 끝났습니다`); });
    rp.on('error', e => { if (this.replay === rp) this.emit('note', `재생 오류: ${e.message}`); });
    rp.run();
    return { date, from, speed };
  }

  // 실시간 — 오늘 기록 파일을 먼저 읽어 시가·봉을 채운 뒤(수집기는 5초마다 파일을 비움), 그동안 받은 실시간 행 중
  // 파일에 없던 것부터 이어 붙인다.
  async startLive({ auto = false } = {}) {
    this.#stopSource();
    this.#fresh();
    this.strategy.enabled = !!auto;
    this.mode = 'live';
    this.#session({ mode: 'live', date: kstToday() });
    const gen = this.gen;
    const buf = [];
    this.warming = true;
    const feed = new LiveFeed({ url: this.feedUrl, sink: (k, r) => {
      if (this.gen !== gen) return;
      if (this.warming) { buf.push([k, r]); if (buf.length > 500_000) buf.splice(0, 100_000); }
      else this.dispatch(k, r);
    } });
    this.feed = feed;
    feed.on('state', (s, why) => { if (this.feed === feed) this.emit('note', s === 'live' ? '수집기에 연결됐습니다' : s === 'down' ? `수집기 연결 안 됨: ${why}` : '수집기에 연결하는 중'); });
    feed.start();
    const date = kstToday();
    // 수집기는 5초마다 파일에 쓴다. 연결 직전에 받은 행이 파일에도 버퍼에도 없는 일이 없게, 연결된 뒤 한 쓰기 주기를 기다렸다 읽는다.
    const t0 = Date.now();
    while (this.gen === gen && feed.state !== 'live' && Date.now() - t0 < 10_000) await new Promise(r => setTimeout(r, 200));
    if (feed.state === 'live') await new Promise(r => setTimeout(r, FLUSH_WAIT_MS));
    if (this.gen !== gen) return;
    // 파일의 체결·호가는 따로 쓰이므로 끝 시각도 따로 본다. 끝 시각과 같은 ms 행은 내용으로 겹침을 가린다.
    const last = { trade: 0, book: 0 }, atLast = { trade: new Set(), book: new Set() };
    if (this.dates().includes(date)) {
      await runFast({ ticksDir: this.ticksDir, date, from: '23:59', onRow: (k, r) => {
        if (this.gen !== gen || !(k in last)) return;
        if (r[0] > last[k]) { last[k] = r[0]; atLast[k].clear(); }
        if (r[0] === last[k]) atLast[k].add(JSON.stringify(r));
        this.dispatch(k, r, true);
      } });
    }
    if (this.gen !== gen) return;
    for (const [k, r] of buf) if (r[0] > last[k] || (r[0] === last[k] && !atLast[k].has(JSON.stringify(r)))) this.dispatch(k, r);
    buf.length = 0;
    this.warming = false;
    this.emit('note', `실시간 준비 완료(오늘 기록 ${last.trade || last.book ? '반영' : '없음'})`);
  }

  stop() { this.#stopSource(); this.mode = 'idle'; }

  order(p) { this.#ready(); return this.broker.place({ ...p, tag: 'manual' }, this.now()); }
  cancel(id) { return this.broker.cancel(Number(id), this.now(), '손 취소'); }
  cancelAll() { return this.broker.cancelAll(this.now(), '전체 취소'); }
  halt(reason) { this.risk.halt(this.broker, this.now(), reason); this.strategy.enabled = false; }
  resume() {
    const loss = this.broker.startCash - this.broker.equity();
    if (loss >= this.risk.limits.maxDailyLoss) throw new OrderError(`손실 ${Math.round(loss).toLocaleString()}원이 하루 한도 이상이라 오늘은 재개할 수 없습니다(보유 매도는 정지 중에도 됩니다)`);
    this.risk.resume();
  }
  // 보유 전량을 시장가로 판다(호가를 안 받는 종목은 매수 1호가가 없어 못 판다 — 결과에 남긴다)
  flatten(code = null) {
    this.#ready();
    const now = this.now(), out = [];
    for (const [c, p] of this.broker.pos) {
      if (!p.qty || (code && c !== code)) continue;
      this.broker.cancelAll(now, '청산', o => o.code === c && o.side === 'sell');
      try { const o = this.broker.place({ code: c, side: 'sell', type: 'market', qty: this.broker.sellable(c), tag: 'manual' }, now); out.push({ code: c, ok: true, qty: o.filled, px: o.avgFill }); }
      catch (e) { out.push({ code: c, ok: false, message: e.message }); }
    }
    return out;
  }
  setAuto(on) {
    if (on) this.#ready();
    if (on && this.risk.halted) throw new OrderError('전체 정지 중입니다. 재개를 먼저 누르세요');
    this.strategy.enabled = !!on;
  }

  status() {
    const rp = this.replay;
    return {
      mode: this.mode, now: this.now(), warming: this.warming,
      replay: rp ? { date: rp.date, from: rp.from, speed: rp.speed, paused: rp.paused, ended: rp.ended, rows: rp.count } : null,
      feed: this.feed ? { state: this.feed.state, rows: this.feed.count, lastAt: this.feed.lastAt, hello: this.feed.hello && { date: this.feed.hello.date, startedAtKST: this.feed.hello.startedAtKST } } : null,
      risk: this.risk.usage(this.broker), auto: this.strategy.stats(), realOrders: false,
    };
  }
}

export const defaultTicksDir = root => path.join(root, 'scripts', 'backtest', 'ticks');
export { kstMs };
