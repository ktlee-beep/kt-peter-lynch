// 유니버스 구간 검증 — 가짜 PostgREST + 가짜 네이버 위에서 refreshUniverse 전 경로를 돌린다.
// 자격증명 없이 `node test/universe-segment.test.mjs`로 실행한다.
import * as fake from './fake_pgrst.mjs';

fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

const data = await import('../data.js');
const db   = await import('../db.js');
const cron = await import('../cron.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(48)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  good ? pass++ : fail++;
};

// ── 1. filterUniverse — 순수 함수 전수 ────────────────────────────
console.log('=== 1. filterUniverse ===');
const row = (o) => ({ code: '000010', name: '보통주', market: 'KOSPI',
  marketCap: 5000, tradingValue: 50, isEtf: false, isEtn: false, tyn: 'N', ...o });
const only = (rows, opt) => data.filterUniverse(rows, opt).kept.map(r => r.code);

ok('보통주 통과', only([row({})]), ['000010']);
ok('ETF 제외',    only([row({ isEtf: true })]), []);
ok('ETN 제외',    only([row({ isEtn: true })]), []);
// 우선주 코드 3형태: 숫자 5·7·9 끝, 영문 K 포함
ok('우선주(005935) 제외', only([row({ code: '005935' })]), []);
ok('우선주(005387) 제외', only([row({ code: '005387' })]), []);
ok('우선주(00680K) 제외', only([row({ code: '00680K' })]), []);
ok('스팩 제외',   only([row({ name: '엔에이치스팩29호' })]), []);
ok('기업인수목적 제외', only([row({ name: '대신기업인수목적1호' })]), []);
ok('시총 null 제외',   only([row({ marketCap: null })]), []);
ok('거래대금 null 제외', only([row({ tradingValue: null })]), []);
// 임계값은 이상(>=)이다 — 경계에서 한 칸 어긋나면 매달 종목이 들락거린다
ok('시총 경계 = 통과',  only([row({ marketCap: 1000 })], { minCapEok: 1000, minValueEok: 3 }), ['000010']);
ok('시총 경계-1 탈락',  only([row({ marketCap: 999 })],  { minCapEok: 1000, minValueEok: 3 }), []);
ok('거래대금 경계 = 통과', only([row({ tradingValue: 3 })], { minCapEok: 1000, minValueEok: 3 }), ['000010']);
ok('거래대금 경계-1 탈락', only([row({ tradingValue: 2.9 })], { minCapEok: 1000, minValueEok: 3 }), []);
// tyn은 의미가 확인되지 않아 필터에 쓰지 않는다 — 추정으로 종목을 떨어뜨리지 않았는지 확인
ok('tyn=Y여도 필터하지 않음', only([row({ tyn: 'Y' })]), ['000010']);
const st = data.filterUniverse([row({ isEtf: true }), row({ code: '005935' }),
  row({ name: '스팩' }), row({ marketCap: 10 }), row({ tradingValue: 0 }), row({})]).stats;
ok('탈락 사유 집계', [st.etfEtn, st.preferred, st.spac, st.belowCap, st.belowValue], [1, 1, 1, 1, 1]);

// ── 2. fetchNaverMarketSum — 페이지네이션·단위·이상응답 ───────────
console.log('\n=== 2. fetchNaverMarketSum ===');
fake.reset();
// 시장당 2,500종목 = pageSize 2000이라 2페이지씩
for (let i = 0; i < 2500; i++) fake.naver.items.push(fake.siseItem({ cd: String(100000 + i), nm: `K${i}`, sosok: 0 }));
for (let i = 0; i < 1800; i++) fake.naver.items.push(fake.siseItem({ cd: String(300000 + i), nm: `Q${i}`, sosok: 1 }));
const bulk = await data.fetchNaverMarketSum();
ok('전 종목 수집', bulk.length, 4300);
ok('시장 분리', [bulk.filter(r => r.market === 'KOSPI').length, bulk.filter(r => r.market === 'KOSDAQ').length], [2500, 1800]);
// marketSumRaw·aa는 백만원 단위 → 억원(÷100). 여기가 틀리면 임계값이 100배 어긋난다.
ok('시총 단위 억원', bulk[0].marketCap, 5000);
ok('거래대금 단위 억원', bulk[0].tradingValue, 50);

fake.naver.mode = 'truncated';
const trunc = await data.fetchNaverMarketSum().then(() => 'no-throw', e => e.message);
ok('총건수 미달 시 throw', /수집 부족/.test(trunc), true);
fake.naver.mode = 'malformed';
const malf = await data.fetchNaverMarketSum().then(() => 'no-throw', e => e.message);
ok('응답 형식 변경 시 throw', /형식 변경/.test(malf), true);
fake.naver.mode = 'down';
const down = await data.fetchNaverMarketSum().then(() => 'no-throw', e => e.message);
ok('원천 장애 시 throw', /HTTP 503/.test(down), true);
fake.naver.mode = 'ok';

// ── 3. getActiveStocks — 절단 결함 (이번에 고친 부분) ─────────────
console.log('\n=== 3. getActiveStocks 페이지네이션 ===');
fake.reset();
for (let i = 0; i < 2500; i++) {
  fake.stocks.rows.push({ code: String(100000 + i), name: `S${i}`, market: 'KOSPI', is_active: 1, yahoo_suffix: 'KS' });
}
fake.stocks.rows.push({ code: '999990', name: '비활성', market: 'KOSPI', is_active: 0, yahoo_suffix: 'KS' });
for (const cap of [300, 500, 1000, 5000]) {
  fake.cfg.maxRows = cap;
  ok(`maxRows=${cap}에서 활성 전수`, (await db.getActiveStocks()).length, 2500);
}
fake.cfg.maxRows = 1000;
ok('비활성은 제외', (await db.getActiveStocks()).some(s => s.code === '999990'), false);
// 조회 실패를 []로 삼키면 "종목 없음"과 구분되지 않는다 — 호출부가 폴백할 수 있게 던져야 한다
fake.cfg.onPageServed = () => { throw new Error('DB 장애'); };
ok('조회 실패 시 throw', await db.getActiveStocks().then(() => 'no-throw', () => 'threw'), 'threw');
fake.cfg.onPageServed = null;

// ── 4. refreshUniverse 통합 ───────────────────────────────────────
console.log('\n=== 4. refreshUniverse ===');
// 통과 900 + 시총미달 200 + 우선주 50 + ETF 100
const seedSource = () => {
  fake.naver.items.length = 0;
  for (let i = 0; i < 900; i++) fake.naver.items.push(fake.siseItem({ cd: String(100000 + i * 10), nm: `가${i}`, sosok: i % 2, capEok: 2000, valEok: 20 }));
  for (let i = 0; i < 200; i++) fake.naver.items.push(fake.siseItem({ cd: String(200000 + i * 10), nm: `소${i}`, sosok: 0, capEok: 300 }));
  for (let i = 0; i < 50; i++)  fake.naver.items.push(fake.siseItem({ cd: String(300005 + i * 10), nm: `우${i}`, sosok: 0, capEok: 9000 }));
  for (let i = 0; i < 100; i++) fake.naver.items.push(fake.siseItem({ cd: String(400000 + i * 10), nm: `ETF${i}`, sosok: 0, etf: true, capEok: 9000 }));
};
fake.reset(); seedSource();

const dry = await cron.refreshUniverse({ dryRun: true });
ok('dryRun 통과 수', dry.universe, 900);
ok('dryRun은 쓰지 않음', [fake.stats.pgUpserts, fake.stocks.rows.length], [0, 0]);

const r1 = await cron.refreshUniverse({});
ok('1회차 반영', [r1.ok, r1.universe, r1.upserted, r1.deactivated], [true, 900, 900, 0]);
ok('kt_stocks 적재', fake.stocks.rows.filter(r => r.is_active === 1).length, 900);
ok('yahoo_suffix 시장별 부여',
  [fake.stocks.rows.find(r => r.market === 'KOSPI')?.yahoo_suffix, fake.stocks.rows.find(r => r.market === 'KOSDAQ')?.yahoo_suffix],
  ['KS', 'KQ']);
// 시총은 kt_stocks에 컬럼이 없다 — KV 블롭에 남아야 Phase 4의 RS 백분위가 재조회 없이 돈다
const meta = await db.getUniverseMeta();
ok('유니버스 메타 저장', [meta?.stocks?.length, meta?.stocks?.[0]?.m], [900, 2000]);

// 사람이 채운 sector가 월간 갱신에 지워지면 안 된다 (payload에 없는 컬럼은 보존)
const target = fake.stocks.rows.find(r => r.is_active === 1);
target.sector = '반도체';
await cron.refreshUniverse({});
ok('sector 보존', fake.stocks.rows.find(r => r.code === target.code)?.sector, '반도체');

// ── 5. 이탈 처리 — 삭제가 아니라 비활성화 ─────────────────────────
console.log('\n=== 5. 이탈 종목 ===');
// 50종목이 시총 미달로 빠진 상황
for (let i = 0; i < 50; i++) fake.naver.items.find(x => x.cd === String(100000 + i * 10)).marketSumRaw = 300 * 100;
const r2 = await cron.refreshUniverse({});
ok('이탈 반영', [r2.ok, r2.universe, r2.deactivated], [true, 850, 50]);
ok('행은 남고 is_active만 0', fake.stocks.rows.length, 900);
ok('이탈 종목 is_active=0', fake.stocks.rows.find(r => r.code === '100000')?.is_active, 0);
ok('활성 집계', (await db.getActiveStocks()).length, 850);
// 다시 기준을 넘으면 되살아나야 한다 (재상장/시총 회복)
for (let i = 0; i < 50; i++) fake.naver.items.find(x => x.cd === String(100000 + i * 10)).marketSumRaw = 2000 * 100;
await cron.refreshUniverse({});
ok('복귀 종목 재활성', fake.stocks.rows.find(r => r.code === '100000')?.is_active, 1);

// ── 6. 안전장치 ───────────────────────────────────────────────────
console.log('\n=== 6. 안전장치 ===');
// 원천이 반쪽만 주면(=필터 통과가 비정상적으로 적으면) 나머지가 전부 이탈로 보인다
const before = fake.stocks.rows.filter(r => r.is_active === 1).length;
// 원천 표본은 항상 두 시장에 걸치고 ETF를 섞는다. 한 시장이 비면 totCnt 검사에,
// ETF 탈락이 0건이면 플래그 형식 검사에 먼저 걸려서 정작 보려던 안전장치를 못 본다.
const seedSet = (n, base) => {
  fake.naver.items.length = 0;
  for (let i = 0; i < n; i++) fake.naver.items.push(fake.siseItem({ cd: String(base + i * 10), nm: `타${i}`, sosok: i % 2, capEok: 2000 }));
  for (let i = 0; i < 20; i++) fake.naver.items.push(fake.siseItem({ cd: String(400000 + i * 10), nm: `ETF${i}`, sosok: 0, etf: true, capEok: 9000 }));
};
seedSet(400, 100000);
const r3 = await cron.refreshUniverse({});
ok('최소 종목수 미달 → 중단', [r3.ok, r3.changed], [false, false]);
ok('중단 시 기존 유니버스 유지', fake.stocks.rows.filter(r => r.is_active === 1).length, before);

// 최소치는 넘지만 절반 이상이 이탈하는 경우 (원천이 다른 집합을 준 상황)
seedSet(600, 500000);
const r4 = await cron.refreshUniverse({});
ok('대량 이탈 → 중단', [r4.ok, r4.changed], [false, false]);
ok('중단 시 무변경', fake.stocks.rows.filter(r => r.is_active === 1).length, before);
const r5 = await cron.refreshUniverse({ force: true });
ok('force면 반영', [r5.ok, r5.universe, r5.deactivated], [true, 600, before]);

// 원천 장애 시 아무것도 바꾸지 않는다 (계획서의 DART 폴백 대신 채택한 정책)
const activeNow = fake.stocks.rows.filter(r => r.is_active === 1).length;
fake.naver.mode = 'down';
const r6 = await cron.refreshUniverse({});
ok('원천 장애 → ok:false', [r6.ok, r6.changed], [false, false]);
ok('원천 장애 시 무변경', fake.stocks.rows.filter(r => r.is_active === 1).length, activeNow);
fake.naver.mode = 'ok';

// DB 조회가 죽었을 때 이탈 목록을 빈 배열로 오인해 전량 upsert만 하고 끝나면 안 된다
fake.cfg.onPageServed = () => { throw new Error('DB 장애'); };
const r7 = await cron.refreshUniverse({});
ok('기존 종목 조회 실패 → 중단', [r7.ok, r7.changed], [false, false]);
fake.cfg.onPageServed = null;

// ── 7. 원천 형식 드리프트 (검증에서 지적된 결함들) ─────────────────
console.log('\n=== 7. 원천 형식 드리프트 ===');
// totCnt 하나가 페이지네이션 종료 조건이자 완전성 검사의 기준값이라, 이 필드가 사라지면
// 두 가지가 동시에 무너진다 — 1페이지에서 탈출하고, "수집 부족" 검사가 공허해진다.
fake.reset(); seedSource();
const srcErr = async () => data.fetchNaverMarketSum().then(() => 'no-throw', e => e.message);
fake.naver.mode = 'noTotCnt';
ok('totCnt 부재 → throw', /totCnt/.test(await srcErr()), true);
// 서버가 pageSize를 무시하고 1000으로 자르면서 totCnt까지 빠진 경우 (부분 수집이 성공으로 보임)
fake.naver.mode = 'capped';
ok('pageSize 상한 + totCnt 부재 → throw', /totCnt/.test(await srcErr()), true);
// 한 시장만 정상 형식의 빈 응답을 주는 경우. itemList가 배열이라 형식 검사는 통과한다.
fake.naver.mode = 'emptyMarket';
ok('한 시장 빈 응답 → throw', /totCnt/.test(await srcErr()), true);
fake.naver.mode = 'ok';

// 시장 전멸이 무증상으로 반영되면 그 시장 종목이 전부 비활성화된다.
// 실측 구성에서 코스닥 전멸은 이탈 27.8%라 전체 30% 상한을 통과한다 — 합계 검사로는 못 잡는다.
fake.reset(); seedSource();
await cron.refreshUniverse({});
const activeBase = fake.stocks.rows.filter(r => r.is_active === 1).length;
const kqBase = fake.stocks.rows.filter(r => r.is_active === 1 && r.market === 'KOSDAQ').length;
ok('기준 상태 (전체/코스닥)', [activeBase, kqBase], [900, 450]);
// 코스닥만 빈 응답 → 원천 단계에서 먼저 걸린다
fake.naver.mode = 'emptyMarket';
const d1 = await cron.refreshUniverse({});
ok('한 시장 소실 → 반영 중단', [d1.ok, d1.changed], [false, false]);
ok('코스닥 활성 그대로', fake.stocks.rows.filter(r => r.is_active === 1 && r.market === 'KOSDAQ').length, kqBase);
fake.naver.mode = 'ok';

// 원천이 코스닥 종목을 아예 안 실어 보내는 경우(형식은 정상). 시장별 하한이 유일한 방어선이다.
fake.naver.items.length = 0;
for (let i = 0; i < 900; i++) fake.naver.items.push(fake.siseItem({ cd: String(100000 + i * 10), nm: `가${i}`, sosok: 0, capEok: 2000, valEok: 20 }));
for (let i = 0; i < 20; i++)  fake.naver.items.push(fake.siseItem({ cd: String(400000 + i * 10), nm: `ETF${i}`, sosok: 0, etf: true, capEok: 9000 }));
for (let i = 0; i < 5; i++)   fake.naver.items.push(fake.siseItem({ cd: String(600000 + i * 10), nm: `잔${i}`, sosok: 1, capEok: 2000, valEok: 20 }));
const d2 = await cron.refreshUniverse({});
ok('시장별 하한 미달 → 중단', [d2.ok, d2.changed], [false, false]);
ok('중단 사유가 시장별임을 명시', /KOSDAQ/.test(d2.error || ''), true);
ok('코스닥 활성 그대로', fake.stocks.rows.filter(r => r.is_active === 1 && r.market === 'KOSDAQ').length, kqBase);

// 시장별 하한(100)은 넘지만 그 시장이 크게 깎이는 경우. 여기가 시장별 이탈 상한의 존재 이유다 —
// 코스닥 450 중 200이 빠지면 전체 이탈은 200/900으로 상한 270 안이라 합계 검사는 통과하지만,
// 코스닥 기준으로는 200 > 135라 걸린다. 시장 재배정이 아니라 코드가 실제로 사라져야 이탈이다.
fake.naver.items.length = 0;
for (let i = 0; i < 900; i++) {
  if (i % 2 === 1 && i >= 500) continue; // 코스닥 200종목 소실
  fake.naver.items.push(fake.siseItem({ cd: String(100000 + i * 10), nm: `가${i}`, sosok: i % 2, capEok: 2000, valEok: 20 }));
}
for (let i = 0; i < 20; i++)  fake.naver.items.push(fake.siseItem({ cd: String(400000 + i * 10), nm: `ETF${i}`, sosok: 0, etf: true, capEok: 9000 }));
const d3 = await cron.refreshUniverse({});
ok('시장별 이탈 상한 → 중단', [d3.ok, d3.changed], [false, false]);
ok('중단 사유에 KOSDAQ 이탈 명시', /KOSDAQ 이탈/.test(d3.error || ''), true);
ok('전체 상한만 봤다면 통과했을 규모', /전체 이탈/.test(d3.error || ''), false);
ok('중단 시 무변경', fake.stocks.rows.filter(r => r.is_active === 1).length, activeBase);

// ETF 플래그 표현이 바뀌면 === true가 전부 통과시킨다. ETF 종목코드는 대부분 끝자리가 0이라
// 보통주 정규식이 백스톱이 되지 못한다 — 069500·102110·550010 전부 통과한다.
const etfRows = [
  { code: '069500', name: 'KODEX200', market: 'KOSPI', marketCap: 50000, tradingValue: 500, isEtf: true,  isEtn: false },
  { code: '102110', name: 'TIGER200', market: 'KOSPI', marketCap: 20000, tradingValue: 300, isEtf: 'true', isEtn: false },
  { code: '550010', name: 'ETN상품',  market: 'KOSPI', marketCap: 10000, tradingValue: 100, isEtf: false, isEtn: 1 },
];
// normalizeSiseRow를 거쳐야 문자열·숫자 플래그가 불리언으로 접힌다
const normalized = (await (async () => {
  fake.naver.items.length = 0;
  fake.naver.items.push(fake.siseItem({ cd: '069500', nm: 'KODEX200', sosok: 0, etf: true }));
  fake.naver.items.push({ ...fake.siseItem({ cd: '102110', nm: 'TIGER200', sosok: 0 }), etf: 'true' });
  fake.naver.items.push({ ...fake.siseItem({ cd: '550010', nm: 'ETN상품', sosok: 0 }), etn: 1 });
  fake.naver.items.push(fake.siseItem({ cd: '005930', nm: '삼성전자', sosok: 1, capEok: 5000 }));
  return data.fetchNaverMarketSum();
})());
ok('플래그가 문자열·숫자여도 ETF/ETN 인식', data.filterUniverse(normalized).stats.etfEtn, 3);
ok('보통주만 남음', data.filterUniverse(normalized).kept.map(r => r.code), ['005930']);
// 코드 정규식은 ETF를 못 거른다는 사실 자체를 못박아 둔다 (플래그가 유일한 방어선인 이유)
ok('ETF 코드도 끝자리 0', etfRows.every(r => /^\d{5}0$/.test(r.code)), true);

// 그래서 "ETF 탈락 0건"은 깨끗한 원천이 아니라 형식 변경의 신호로 취급한다.
fake.reset(); seedSource();
for (const it of fake.naver.items) if (it.etf) it.etf = 'yes'; // 인식 못 하는 표현
const d4 = await cron.refreshUniverse({});
ok('ETF 탈락 0건 → 중단', [d4.ok, d4.changed, d4.stats.etfEtn], [false, false, 0]);

// 원천 목록은 실시간 시총 순이라 페이지 사이에 순위가 바뀌면 같은 종목이 두 번 온다.
// 그대로 upsert하면 Postgres가 21000으로 청크를 통째로 거부한다.
fake.reset(); seedSource();
const dupSrc = [...fake.naver.items];
fake.naver.items.push(dupSrc[0], dupSrc[1]); // 경계에서 중복 유입
const d5 = await cron.refreshUniverse({});
ok('중복 제거 후 반영', [d5.ok, d5.universe, d5.stats.dup], [true, 900, 2]);
ok('upsert가 21000으로 거부되지 않음', fake.stocks.rows.filter(r => r.is_active === 1).length, 900);

// ── 8. 트리거 입력 정규화 ─────────────────────────────────────────
console.log('\n=== 8. 입력 정규화 ===');
// Number(null)·Number('')·Number([])·Number(false)는 전부 0이라 그대로 클램프하면
// 기본값이 아니라 하한값이 된다. 그 한 번의 실행이 유니버스를 부풀리고, 다음 달 기본값
// 실행은 이탈 상한에 걸려 force 없이는 매달 실패한다.
for (const [label, v] of [['null', null], ['빈문자열', ''], ['false', false], ['빈배열', []], ['미지정', undefined]]) {
  ok(`minCapEok ${label} → 기본값`, cron.normalizeUniverseOpts({ minCapEok: v }).minCapEok, 1000);
  ok(`minValueEok ${label} → 기본값`, cron.normalizeUniverseOpts({ minValueEok: v }).minValueEok, 3);
}
ok('숫자문자열은 허용', cron.normalizeUniverseOpts({ minCapEok: '2000' }).minCapEok, 2000);
ok('하한 클램프', cron.normalizeUniverseOpts({ minCapEok: 1 }).minCapEok, 100);
ok('상한 클램프', cron.normalizeUniverseOpts({ minCapEok: 999999 }).minCapEok, 100000);
ok('거래대금 0은 유효값', cron.normalizeUniverseOpts({ minValueEok: 0 }).minValueEok, 0);
ok('불리언 문자열 수용', [cron.normalizeUniverseOpts({ dryRun: 'true', force: true }).dryRun,
                          cron.normalizeUniverseOpts({ dryRun: 'true', force: true }).force], [true, true]);
ok('본문 없음도 기본값', [cron.normalizeUniverseOpts().minCapEok, cron.normalizeUniverseOpts().dryRun], [1000, false]);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
