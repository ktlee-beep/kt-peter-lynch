// 백테스트용 장기 일봉 수집기 (오프라인 캐시 생성).
//
// 네이버 fchart는 cron.js:306이 쓰는 것과 같은 엔드포인트다. 인증이 없고 OHLCV를
// 전부 주므로 별도 데이터 계약이 필요 없다. 다만 크론은 count=280(52주+버퍼)만
// 받는 반면 백테스트는 60거래일 보유 결과까지 재려면 훨씬 긴 이력이 필요하다.
//
// 사용:
//   node scripts/backtest/fetch-ohlcv.mjs                 # 기본 80종목 × 1200봉
//   node scripts/backtest/fetch-ohlcv.mjs --count 200 --bars 2000
//   node scripts/backtest/fetch-ohlcv.mjs --codes 005930,000660
//
// 캐시는 scripts/backtest/cache/<code>.json 에 쌓이고 이미 있으면 건너뛴다.
// 다시 받으려면 --force.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KRX_STOCKS } from '../../krx_stocks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'cache');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const FORCE = argv.includes('--force');
const BARS  = parseInt(argOf('bars', '1200'), 10);
const LIMIT = parseInt(argOf('count', '80'), 10);
const CODES = argOf('codes', null);

// 종목 선정: KRX_STOCKS의 앞쪽은 대형주 중심이라 그대로 자르면 시총 상위 편향이 생긴다.
// 전체에서 균등 간격으로 뽑아 섹터·규모가 한쪽으로 쏠리는 것을 줄인다. 그래도 이 유니버스
// 자체가 상장 유지 종목만 담고 있어 생존편향은 남는다 — 결과 해석 시 감안할 것.
function pickUniverse() {
  if (CODES) {
    const want = new Set(CODES.split(',').map(s => s.trim()));
    return KRX_STOCKS.filter(s => want.has(s.code));
  }
  const all = KRX_STOCKS;
  if (all.length <= LIMIT) return all;
  const step = all.length / LIMIT;
  return Array.from({ length: LIMIT }, (_, i) => all[Math.floor(i * step)]);
}

async function fetchOne(code, name) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=${BARS}&requestType=0`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item data="([^"]+)"/g)].map(m => {
    const [d, o, h, l, c, v] = m[1].split('|');
    return { d, o: +o, h: +h, l: +l, c: +c, v: +v };
  }).filter(i => i.c > 0);
  if (items.length < 120) throw new Error(`bars=${items.length} (너무 짧음)`);
  return { code, name, bars: items.length, from: items[0].d, to: items.at(-1).d, items };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  const universe = pickUniverse();
  console.log(`유니버스 ${universe.length}종목 · 요청 ${BARS}봉 · 캐시 ${CACHE_DIR}`);

  let done = 0, skipped = 0, failed = 0;
  const fails = [];
  // 동시 4개로 제한한다. 네이버는 공개 엔드포인트지만 페이싱 없이 수백 건을 쏘면
  // 차단될 수 있고, 이 스크립트는 한 번 돌려 캐시를 만들면 끝이라 서두를 이유가 없다.
  const queue = [...universe];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      const dest = path.join(CACHE_DIR, `${s.code}.json`);
      if (!FORCE && existsSync(dest)) { skipped++; continue; }
      try {
        const data = await fetchOne(s.code, s.name);
        await writeFile(dest, JSON.stringify(data));
        done++;
        if (done % 10 === 0) console.log(`  ...${done}건 수집`);
      } catch (e) {
        failed++;
        fails.push(`${s.code} ${s.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 150));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  console.log(`\n수집 ${done} / 기존캐시 ${skipped} / 실패 ${failed}`);
  if (fails.length) {
    console.log('실패 목록:');
    fails.slice(0, 20).forEach(f => console.log(`  ${f}`));
    if (fails.length > 20) console.log(`  ... 외 ${fails.length - 20}건`);
  }
  const files = await readdir(CACHE_DIR);
  console.log(`캐시 총 ${files.filter(f => f.endsWith('.json')).length}종목`);
}

main().catch(e => { console.error(e); process.exit(1); });
