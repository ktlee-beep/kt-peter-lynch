// 실시간 — 수집기(stream-collector.mjs)가 127.0.0.1:4791/feed 로 내보내는 행을 받는다.
// 매매 화면은 토스에 직접 붙지 않는다(계정당 웹소켓 2연결을 수집기가 다 쓰고, 토큰을 다시 받으면 수집기 토큰이 폐기됨).
// 수집기가 꺼져 있으면 3초마다 다시 붙는다. 상태: connecting → live / down.
import http from 'node:http';
import { EventEmitter } from 'node:events';

export class LiveFeed extends EventEmitter {
  constructor({ url = 'http://127.0.0.1:4791/feed', sink, retryMs = 3000 } = {}) {
    super();
    this.url = url; this.sink = sink; this.retryMs = retryMs;
    this.state = 'down'; this.hello = null; this.count = 0; this.lastAt = 0; this.req = null; this.stopped = false; this.timer = null;
  }
  start() { this.stopped = false; this.#connect(); return this; }
  stop() {
    this.stopped = true; clearTimeout(this.timer);
    try { this.req?.destroy(); } catch {}
    this.#set('down');
  }
  #set(s, why = '') { if (this.state !== s) { this.state = s; this.emit('state', s, why); } }
  #retry(why) {
    this.req = null;
    this.#set('down', why);
    if (!this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => this.#connect(), this.retryMs); }
  }
  #connect() {
    if (this.stopped) return;
    this.#set('connecting');
    const req = http.get(this.url, { headers: { accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return this.#retry(`응답 ${res.statusCode}`); }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { this.#block(buf.slice(0, i)); buf = buf.slice(i + 2); }
        if (buf.length > 4 << 20) buf = '';   // 구분자 없는 이상 응답 — 버린다
      });
      res.on('end', () => this.#retry('수집기 연결 끊김'));
      res.on('error', () => this.#retry('수집기 연결 오류'));
    });
    req.on('error', e => this.#retry(e.code === 'ECONNREFUSED' ? '수집기 꺼짐' : e.message));
    req.setTimeout(40000, () => req.destroy(new Error('응답 없음(40초)')));   // 수집기는 15초마다 ping
    this.req = req;
  }
  #block(block) {
    let ev = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) ev = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) return;
    let v; try { v = JSON.parse(data); } catch { return; }
    if (ev === 'hello') { this.hello = v; this.#set('live'); this.emit('hello', v); return; }
    if ((ev === 'trade' || ev === 'book') && Array.isArray(v)) {
      this.count++; this.lastAt = Date.now();
      this.sink(ev, v);
    }
  }
}
