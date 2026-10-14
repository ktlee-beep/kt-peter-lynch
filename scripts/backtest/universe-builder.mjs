// 일일 단타 후보 유니버스 빌더 (읽기 전용. 주문·토스 호출 없음 -> 가동 중인 웹소켓 수집기의 토큰과 충돌하지 않는다).
//
// 소스: 네이버 증권 테마 내부 API(비공식, 호출 최소화) + 네이버 검색 오픈API(공식, 뉴스)
//   1) 테마 목록(거래대금순 상위 + 등락률순 상위) -> 각 테마의 구성종목(거래대금순 100)
//   2) 종목 단위 필터: ETF 제외 / 종가 5,000원 미만 제외 / 거래대금 하한 미만 제외 / 투자경고·관리·거래정지 제외
//   3) 기존 코어 풀(일봉 캐시 122종목)에 없는 종목 중 거래대금 상위 SLOTS개를 소형주 슬롯으로 선정
//   4) 뉴스: 상위 테마명·선정 종목명으로 뉴스 제목을 모아 키워드 빈도를 저장 (신호가 아니라 기록)
// 저장: scripts/backtest/universe/<기준일>.json  (선정 근거·제외 사유·시세 스냅샷 시각 포함)
//
// 주의: 값은 호출 시점의 스냅샷이다. 평일 저녁(작업 스케줄러 \KT\KT-PeterLynch-Evening, 20:15) 장 마감 뒤에 돌려
//       그날 하루치 값으로 다음 거래일 후보를 만든다. 장 시작 전 08:50 호출은 거래대금이 0으로 와서 전 종목이 탈락했다
//       (2026-10-14: passed 0, 스냅샷 1090종목 PREOPEN). 장중 호출은 당일 진행값이라 같은 날 쓰면 룩어헤드다.
//       수집기는 [직전 평일 15:40, 당일 07:00) 사이 빌드만 자동으로 받는다(stream-collector.mjs loadPicks).
// 사용: node scripts/backtest/universe-builder.mjs [--slots 60] [--minvalue 3000000000] [--themes 40] [--noNews]
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'cache');
const OUT_DIR = path.join(HERE, 'universe');
const ENV_PATH = 'C:/Users/ThinkBook/.secrets/api-keys.env';
const NAVER = 'https://stock.naver.com/api';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SLOTS = parseInt(argOf('slots', '60'), 10);
const MIN_VALUE = Number(argOf('minvalue', '3000000000'));   // 거래대금 하한(원). 근거 없는 시작값이며 데이터로 재정의 대상.
const N_THEMES = parseInt(argOf('themes', '40'), 10);
const NO_NEWS = argv.includes('--noNews');
const MIN_PRICE = parseInt(argOf('minprice', '0'), 10);   // 가격 하드 제외 없음(기본 0). 5,000원·1,000원 기준 모두 근거 없는 임의값이라 폐기. 가격 구간·호가 한 칸 비율을 기록해 측정 단계에서 비교
const GAP_MS = 250;
if (!(SLOTS > 0) || !(N_THEMES > 0) || !Number.isFinite(MIN_VALUE) || !(MIN_PRICE >= 0)) throw new Error('인자 오류: --slots/--themes/--minvalue/--minprice는 양수여야 함');

// 네트워크가 걸려 멈춘 채 다음 작업과 겹치지 않도록 전체 시간에 상한을 둔다
// (파일을 쓰기 전에 끊기면 다음 날 수집기는 저녁 빌드가 없다고 보고 코어만으로 시작한다).
setTimeout(() => { console.error('전체 시간 8분 초과 — 중단'); process.exit(2); }, 8 * 60_000).unref();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0' };

async function getJson(url, headers = UA) {
  for (let a = 0; a < 3; a++) {
    let r;
    try { r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); } catch (e) { if (a === 2) throw e; await sleep(1000 * (a + 1)); continue; }
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * (a + 1)); continue; }
    throw new Error(`HTTP ${r.status} ${url}`);
  }
  throw new Error(`재시도 초과 ${url}`);
}

const kst = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};

// ---------- 1) 테마 ----------
async function themeList(sortType) {
  const out = []; let cursor = '';
  for (let page = 0; page < 3; page++) {
    const j = await getJson(`${NAVER}/stockSecurity/rankings/v2/domestic/themes?sortType=${sortType}&size=100&period=daily${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...j.items);
    if (!j.hasNext || !j.cursor) break;
    cursor = j.cursor; await sleep(GAP_MS);
  }
  return out;
}
async function themeStocks(code) {
  const j = await getJson(`${NAVER}/domestic/market/theme/${code}/stocklist?marketType=ALL&orderType=priceTop&startIdx=0&pageSize=100`);
  if (!Array.isArray(j)) throw new Error(`구성종목 응답이 배열이 아님 (테마 ${code}): ${JSON.stringify(j).slice(0, 120)}`);
  return j;
}

// ---------- 2) 종목 필터 ----------
function exclusion(s) {
  if (s.etfType) return 'ETF';
  const price = Number(s.nowPrice);
  if (!Number.isFinite(price) || price < MIN_PRICE) return `현재가<${MIN_PRICE}`;
  if (s.tradeStopYn !== 'N') return '거래정지';
  if (s.manageStatusGb !== '0') return `관리(${s.manageStatusGb})`;
  if (s.marketAlertType !== '00') return `시장경보(${s.marketAlertType})`;
  if (s.tradableStatus !== 'tradable') return `거래불가(${s.tradableStatusCode})`;
  if (!(Number(s.tradeAmount) >= MIN_VALUE)) return '거래대금하한미달';
  if (!(Number(s.marketSum) > 0)) return '시총없음';
  if (/스팩|\d+호$/.test(s.itemname)) return '스팩';
  return null;
}
const tickOf = p => p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;   // KRX 호가단위(두 시장 동일, 2023.1.25 이후)
const sizeBucket = cap => cap < 5e10 ? 'micro<500억' : cap < 3e11 ? 'small<3000억' : cap < 2e12 ? 'mid<2조' : 'large';

// ---------- 4) 뉴스 ----------
const STOP = new Set(['오늘', '이번', '관련', '있다', '위한', '대한', '통해', '지난', '올해', '내년', '대비', '속보', '특징주', '종합', '개월', '억원', '조원', '주가', '주식', '증시', '코스피', '코스닥', '상승', '하락', '급등', '급락']);
let naverHeaders = null;
async function loadNaverHeaders() {
  let txt;
  try { txt = await readFile(ENV_PATH, 'utf8'); } catch (e) { console.log(`키 파일 읽기 실패 -> 뉴스 생략: ${e.message}`); return null; }
  const get = k => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^['"]|['"]$/g, '');
  const id = get('NAVER_CLIENT_ID'), sec = get('NAVER_CLIENT_SECRET');
  if (!id || !sec) return null;
  return { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': sec };
}
const decode = t => t.replace(/<[^>]+>/g, ' ').replace(/&(quot|amp|apos|lt|gt|#39|#x27);/g, ' ');
const cleanQuery = q => q.replace(/(.*?)/g, ' ').replace(/[/]/g, ' ').trim();
async function news(rawQuery) {
  const query = cleanQuery(rawQuery);
  const j = await getJson(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=100&sort=date`, naverHeaders);
  const items = (j.items || []).map(i => ({ t: decode(i.title), pub: Date.parse(i.pubDate) }));
  const freq = new Map();
  for (const it of items) for (const w of new Set(it.t.match(/[가-힣A-Za-z0-9]{2,}/g) || [])) {
    if (STOP.has(w) || query.split(/s+/).some(q => w.startsWith(q))) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return {
    total: j.total, sampled: items.length,
    newest: items.length ? new Date(Math.max(...items.map(i => i.pub))).toISOString() : null,
    keywords: [...freq].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
}

// ---------- 실행 ----------
const now = kst();
const asOf = new Date().toISOString();
const core = new Set((await readdir(CACHE_DIR)).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));

const byValue = await themeList('tradingValue'); await sleep(GAP_MS);
const byRate = await themeList('changeRate');
const picked = new Map();
for (const t of [...byValue.slice(0, N_THEMES), ...byRate.slice(0, Math.floor(N_THEMES / 2))]) picked.set(t.code, t);
console.log(`테마 ${byValue.length}개 중 구성종목 조회 ${picked.size}개`);

const failedThemes = [];
const stocks = new Map();            // code -> {snapshot, themes[]}
for (const t of picked.values()) {
  let rows;
  try { rows = await themeStocks(t.code); } catch (e) { console.log(`테마 ${t.code} 실패: ${e.message}`); failedThemes.push({ code: t.code, name: t.name, error: e.message }); continue; }
  for (const s of rows) {
    const e = stocks.get(s.itemcode) || { s, themes: [] };
    e.themes.push({ code: t.code, name: t.name });
    stocks.set(s.itemcode, e);
  }
  await sleep(GAP_MS);
}

const excluded = {}, candidates = [];
for (const [code, { s, themes }] of stocks) {
  const why = exclusion(s);
  if (why) { excluded[why] = (excluded[why] || 0) + 1; continue; }
  candidates.push({
    code, name: s.itemname, market: s.sosok === '0' ? 'KOSPI' : 'KOSDAQ', price: Number(s.nowPrice), changeRate: Number(s.prevChangeRate),
    tradeValue: Number(s.tradeAmount), marketCap: Number(s.marketSum), bucket: sizeBucket(Number(s.marketSum)),
    listedDate: s.listedDate, priceBand: Number(s.nowPrice) < 1000 ? '1천미만' : Number(s.nowPrice) < 2000 ? '1천~2천' : Number(s.nowPrice) < 5000 ? '2천~5천' : '5천+', tickPct: +(tickOf(Number(s.nowPrice)) / Number(s.nowPrice) * 100).toFixed(3), inCore: core.has(code), themes,
  });
}
candidates.sort((a, b) => b.tradeValue - a.tradeValue);
// 절대 거래대금 순으로만 뽑으면 대형주가 슬롯을 채운다(2026-10-13 시험 실행에서 확인). 시총 구간별 할당 후 남는 칸은 중형 -> 대형 순으로 채운다.
const pool = candidates.filter(c => !c.inCore);
const isSmall = c => c.bucket.startsWith('micro') || c.bucket.startsWith('small');
const picks = [];
const take = (list, n) => { for (const c of list) { if (n <= 0) break; if (!picks.includes(c)) { picks.push(c); n--; } } };
take(pool.filter(isSmall), Math.ceil(SLOTS * 2 / 3));
take(pool.filter(c => c.bucket.startsWith('mid')), SLOTS - picks.length);
take(pool.filter(c => c.bucket === 'large'), SLOTS - picks.length);
take(pool.filter(isSmall), SLOTS - picks.length);       // 중형·대형이 모자랄 때만 소형으로 다시 채움
picks.sort((a, b) => b.tradeValue - a.tradeValue);

let newsOut = null;
if (!NO_NEWS) {
  naverHeaders = await loadNaverHeaders();
  if (!naverHeaders) console.log('NAVER 키 없음 -> 뉴스 생략');
  else {
    newsOut = { themes: {}, stocks: {} };
    for (const t of byValue.slice(0, 15)) { try { newsOut.themes[t.name] = await news(t.name); } catch (e) { newsOut.themes[t.name] = { error: e.message }; } await sleep(GAP_MS); }
    for (const c of picks) { try { newsOut.stocks[c.code] = { name: c.name, ...(await news(c.name)) }; } catch (e) { newsOut.stocks[c.code] = { name: c.name, error: e.message }; } await sleep(GAP_MS); }
  }
}

const sessions = {};
for (const { s } of stocks.values()) { const k = `${s.marketStatus}/${s.tradingSessionType}`; sessions[k] = (sessions[k] || 0) + 1; }
const out = {
  builtAtKST: `${now.date} ${now.time}`, asOfUTC: asOf, snapshotSessions: sessions,
  params: { slots: SLOTS, minTradeValue: MIN_VALUE, minPrice: MIN_PRICE, themesByValue: N_THEMES, themesByRate: Math.floor(N_THEMES / 2) },
  note: '값은 호출 시점 스냅샷. 장 마감 뒤 호출이면 그날 하루치 값(다음 거래일용), 장중이면 당일 진행값(룩어헤드 주의), 장 시작 전이면 거래대금 0. 임계값은 근거 없는 시작값.',
  counts: { themesTotal: byValue.length, themesQueried: picked.size, themesFailed: failedThemes.length, stocksSeen: stocks.size, passed: candidates.length, coreAmongPassed: candidates.filter(c => c.inCore).length, picked: picks.length, shortfall: Math.max(0, SLOTS - picks.length), byBucket: Object.fromEntries([...new Set(picks.map(c => c.bucket))].map(b => [b, picks.filter(c => c.bucket === b).length])) },
  failedThemes,
  excludedByReason: excluded,
  picks,
  topThemes: byValue.slice(0, 15).map(t => ({ code: t.code, name: t.name, changeRate: Number(t.changeRate), tradeValue: Number(t.totalTradingValue), rising: Number(t.risingCount), falling: Number(t.fallingCount) })),
  news: newsOut,
};
await mkdir(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${now.date}_${now.time.replace(':', '')}.json`);   // 같은 날 재실행이 앞선 스냅샷을 덮어쓰지 않도록 시각 포함
await writeFile(file, JSON.stringify(out, null, 1));
console.log(`저장 ${file}`);
console.log(JSON.stringify({ counts: out.counts, excludedByReason: excluded, snapshotSessions: sessions }));
if (stocks.size === 0 || failedThemes.length > picked.size / 2) { console.error('수집 실패 비율이 높아 비정상 종료'); process.exitCode = 1; }
