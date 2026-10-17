// 매매 장부 저장 — 세션(재생 한 번, 실시간 시작 한 번)마다 ledger/<id>.json 한 파일.
// 끝난 매매가 생기면 1초 모아서 덮어쓰고, 다음 세션으로 넘어가거나 프로그램이 꺼질 때 마지막으로 쓴다.
// 매매가 한 건도 없는 세션은 파일을 만들지 않는다. 개인 기록이라 git 에서 뺀다(.gitignore).
import fs from 'node:fs';
import path from 'node:path';
import { pubTrip } from './paper-broker.mjs';

const ID_RE = /^(replay|live)-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/;
const MAX_FILES = 300;
const kstClock = ms => new Date(ms + 9 * 3600e3).toISOString().slice(11, 19).replaceAll(':', '');
export const kstText = ms => (ms ? new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') : '');

export class Ledger {
  constructor(dir, { name = c => c, log = console.error } = {}) {
    this.dir = dir; this.name = name; this.log = log; this.cur = null; this.timer = null;
  }
  file(id) { return path.join(this.dir, id + '.json'); }
  static validId(id) { return ID_RE.test(String(id ?? '')); }

  // session: { mode, date, from?, speed?, startedAt }. broker 의 'trip' 이 생길 때마다 저장을 예약한다.
  begin(session, broker) {
    this.flush(true);
    const base = `${session.mode}-${session.date}-${kstClock(session.startedAt)}`;
    let id = base;
    for (let i = 2; fs.existsSync(this.file(id)) || id === this.cur?.id; i++) id = `${base}-${i}`;
    const cur = { ...session, id, broker, dirty: false };
    this.cur = cur;
    broker.on('trip', () => { cur.dirty = true; if (this.cur === cur) this.#soon(); else this.#write(cur); });
    return id;
  }
  #soon() { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000); }
  // final: 세션이 끝날 때(다음 세션 시작·프로그램 종료) — 매매가 있었으면 마지막 평가(총 수익률)까지 다시 쓴다
  flush(final = false) {
    clearTimeout(this.timer); this.timer = null;
    if (this.cur?.dirty || (final && this.cur?.broker.trips.length)) this.#write(this.cur);
  }
  #doc(c) {
    const b = c.broker;
    return { v: 1, id: c.id, mode: c.mode, date: c.date, from: c.from ?? null, speed: c.speed ?? null, startedAt: c.startedAt, savedAt: Date.now(),
      startCash: b.startCash, stats: b.stats(), trips: b.trips.map(t => ({ ...pubTrip(t), name: this.name(t.code) })) };
  }
  #write(c) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this.file(c.id), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.#doc(c)));
      fs.renameSync(tmp, f);
      c.dirty = false;
    } catch (e) { this.log(`매매 장부 저장 실패(${c.id}): ${e.message}`); }
  }
  #read(id) {
    if (this.cur?.id === id) return this.#doc(this.cur);
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  // 세션 목록(최근 것 먼저). 지금 세션은 저장 전이라도 메모리 값으로 넣는다.
  list() {
    let ids = [];
    try { ids = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(id => ID_RE.test(id)); } catch { /* 아직 폴더 없음 */ }
    if (this.cur && !ids.includes(this.cur.id)) ids.push(this.cur.id);
    const out = [];
    for (const id of ids) {
      const d = this.#read(id);
      if (!d) continue;
      const { best, worst, ...stats } = d.stats ?? {};
      out.push({ id, mode: d.mode, date: d.date, from: d.from, speed: d.speed, startedAt: d.startedAt, savedAt: d.savedAt,
        startCash: d.startCash, stats, current: id === this.cur?.id });
    }
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_FILES);
  }

  // 매매 내역 CSV(엑셀용 BOM). id 하나 또는 전체(all)
  csv({ id = null, all = false } = {}) {
    const ids = all ? this.list().map(s => s.id) : [id];
    const head = ['세션', '방식', '기록 날짜', '종목코드', '종목명', '매수 시각', '매도 시각', '보유(초)', '수량', '평균 매수가', '평균 매도가', '매수금액', '매도금액', '비용', '실현손익', '수익률(%)', '출처'];
    // 엑셀이 수식으로 읽는 글자(= + - @ 탭 CR)로 시작하는 글은 앞에 ' 를 붙인다(음수 같은 숫자는 그대로).
    // 종목코드 칸(3번)만 예외 — 6자리 숫자로 검사된 값을 ="005930" 꼴로 일부러 쓴다.
    const q = (v, i) => { let s = String(v ?? ''); if (i !== 3 && /^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
    const lines = [head.join(',')];
    for (const i of ids) {
      const d = this.#read(i);
      if (!d) continue;
      for (const t of d.trips ?? []) {
        // 종목코드는 ="005930" 꼴로 — 엑셀이 앞자리 0을 지우지 않게
        lines.push([d.id, d.mode === 'live' ? '실시간' : '재생', d.date, `="${t.code}"`, t.name ?? this.name(t.code), kstText(t.openAt), kstText(t.closeAt),
          Math.round((t.closeAt - t.openAt) / 1000), t.qty, t.buyAvg, t.sellAvg, t.buyAmt, t.sellAmt, t.cost, t.pnl, t.ret,
          t.tag === 'auto' ? '자동' : t.tag === 'manual' ? '손' : '섞임'].map(q).join(','));
      }
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
}
