// 저장된 초 단위 기록(ticks/<날짜>/trade-*.ndjson.gz, book-*.ndjson.gz)을 수신 시각 순서로 다시 흘려보낸다.
// 장 밖·주말에도 실시간과 같은 엔진(시세 → 자동 규칙 → 모의 주문 → 체결)을 돌려 연습·규칙 시험을 하기 위한 것.
//   배속: 모의 시각 = 기준 모의 시각 + (지금 − 기준 벽시계) × 배속. 일시정지·배속 변경 때 기준을 다시 잡는다.
//   시작 시각(from) 이전 행은 시세에만 반영(warm)하고 주문·자동 규칙에는 넘기지 않는다.
// 수집기가 비정상 종료해 잘린 gz 도 읽을 수 있는 데까지 읽는다(Z_SYNC_FLUSH). 깨진 줄은 건너뛴다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

export const kstMs = (date, hm = '00:00') => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi, s = 0] = hm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h - 9, mi, s);
};
export const kstHms = ms => new Date(ms + 9 * 3600e3).toISOString().slice(11, 19);

export function listDates(ticksDir) {
  let names = [];
  try { names = fs.readdirSync(ticksDir); } catch { return []; }
  return names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .filter(n => { try { return fs.readdirSync(path.join(ticksDir, n)).some(f => /^trade(-.*)?\.ndjson\.gz$/.test(f)); } catch { return false; } })
    .sort();
}
// 10-13 까지는 하루 한 파일(trade.ndjson.gz), 그 뒤는 수집기를 켤 때마다 한 파일(trade-HHMMSS.ndjson.gz)
export function filesOf(ticksDir, date, kind) {
  const dir = path.join(ticksDir, date);
  try { return fs.readdirSync(dir).filter(f => f === kind + '.ndjson.gz' || (f.startsWith(kind + '-') && f.endsWith('.ndjson.gz'))).sort().map(f => path.join(dir, f)); }
  catch { return []; }
}

async function* rows(files) {
  for (const f of files) {
    const rs = fs.createReadStream(f);
    const gz = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const rl = readline.createInterface({ input: rs.pipe(gz), crlfDelay: Infinity });
    const stop = () => { rl.close(); rs.destroy(); };
    rs.on('error', stop); gz.on('error', stop);
    try {
      for await (const line of rl) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (Array.isArray(r) && Number.isFinite(r[0])) yield r;
      }
    } catch { /* 읽다 깨진 파일 — 다음 파일로 */ }
    finally { stop(); }
  }
}

// trade·book 두 흐름을 수신 시각(행 첫 칸)으로 합친다. 같은 시각이면 호가 먼저(체결 방향 판정이 호가를 쓰므로).
export async function* merged(ticksDir, date) {
  const a = rows(filesOf(ticksDir, date, 'trade')), b = rows(filesOf(ticksDir, date, 'book'));
  let x = await a.next(), y = await b.next();
  while (!x.done || !y.done) {
    if (y.done || (!x.done && x.value[0] < y.value[0])) { yield ['trade', x.value]; x = await a.next(); }
    else { yield ['book', y.value]; y = await b.next(); }
  }
}

const YIELD_EVERY = 5000;
const wait = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));

export class Replay extends EventEmitter {
  // sink(kind, row, warm) — warm 이면 시작 시각 이전 행(시세에만 반영)
  constructor({ ticksDir, date, from = '09:00', speed = 1, sink }) {
    super();
    this.ticksDir = ticksDir; this.date = date; this.from = from; this.speed = speed; this.sink = sink;
    this.paused = false; this.stopped = false; this.ended = false; this.count = 0;
    this.anchorSim = kstMs(date, from); this.anchorWall = Date.now(); this.last = this.anchorSim;
  }
  now() {
    if (this.ended) return this.last;
    return this.paused ? this.anchorSim : this.anchorSim + (Date.now() - this.anchorWall) * this.speed;
  }
  pause() { if (!this.paused) { this.anchorSim = this.now(); this.paused = true; } }
  play() { if (this.paused) { this.anchorWall = Date.now(); this.paused = false; } }
  setSpeed(s) { this.anchorSim = this.now(); this.anchorWall = Date.now(); this.speed = s; }
  stop() { this.stopped = true; }

  async run() {
    const fromMs = kstMs(this.date, this.from);
    let warm = true, n = 0;
    try {
      for await (const [kind, row] of merged(this.ticksDir, this.date)) {
        if (this.stopped) return;
        if (warm && row[0] >= fromMs) {
          warm = false;
          this.anchorSim = Math.max(fromMs, row[0] - 1000);   // 시작 시각(기록이 그보다 늦게 시작하면 첫 행 1초 전)에서 출발
          this.anchorWall = Date.now();
          this.emit('ready');
        }
        if (!warm) {
          while (!this.stopped && (this.paused || row[0] > this.now())) await wait(this.paused ? 100 : Math.min(50, Math.max(5, (row[0] - this.now()) / this.speed)));
          if (this.stopped) return;
        }
        this.last = row[0]; this.count++;
        this.sink(kind, row, warm);
        if (++n % YIELD_EVERY === 0) await tick();
      }
      if (warm) this.emit('ready');
      this.ended = true; this.emit('end');
    } catch (e) { this.ended = true; this.emit('error', e); }
  }
}

// 속도 조절 없이 끝까지(측정용). onRow(kind, row, warm)
export async function runFast({ ticksDir, date, from = '00:00', onRow }) {
  const fromMs = kstMs(date, from);
  let n = 0;
  for await (const [kind, row] of merged(ticksDir, date)) {
    onRow(kind, row, row[0] < fromMs);
    if (++n % YIELD_EVERY === 0) await tick();
  }
  return n;
}
