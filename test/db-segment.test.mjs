// DB 구간 검증 (실행: node test/db-segment.test.mjs) — 가짜 PostgREST 위에서 db.js의 KV 계층과 cron.js 백필을 실행한다.
import * as fake from './fake_pgrst.mjs';

fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.DART_API_KEY = 'fake-dart-key';

const db = await import('../db.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(46)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  good ? pass++ : fail++;
};

// ── 0. 가짜 서버 자체가 맞는지 (이게 틀리면 이후 결과는 전부 무의미) ──
console.log('=== 0. 하네스 스모크 ===');
fake.reset();
fake.seed('__company__005930', { indutyCode: '264', accMonth: 12 }, 1);
ok('kvGetFresh 신선', await db.getCompanyInfoCache('005930'), { indutyCode: '264', accMonth: 12 });
fake.reset();
fake.seed('__company__005930', { indutyCode: '264' }, 200);
ok('kvGetFresh 만료 → undefined', await db.getCompanyInfoCache('005930'), undefined);
ok('kvGetFresh 미스 → undefined', await db.getCompanyInfoCache('999999'), undefined);

// ── 1. 페이지네이션 전수 (M4/L2) ──
console.log('\n=== 1. listFreshKvCodes 페이지네이션 ===');
fake.reset();
fake.cfg.maxRows = 1000; fake.cfg.honorOrder = true; fake.cfg.onPageServed = null;
const N = 2500;
for (let i = 0; i < N; i++) fake.seed(`__multiyear__${String(i).padStart(6, '0')}`, [{ year: 2025 }], 1);
ok(`${N}건 전수 수집`, (await db.listFreshKvCodes('__multiyear__', 100)).size, N);

// ── 2. 페이지 사이 쓰기 — ORDER BY가 실제로 방어하는지 ──
console.log('\n=== 2. 페이지네이션 중 upsert 발생 ===');
const midWrite = () => {
  // keyset 순회는 offset이 항상 0이라 "첫 페이지"를 offset으로 판별할 수 없다 — 플래그로 한 번만 건다.
  let fired = false;
  fake.cfg.onPageServed = () => {
    if (fired) return;
    fired = true;
    // 첫 페이지 직후 앞쪽 행 30건을 갱신 → 물리적으로 배열 끝으로 이동
    const moved = fake.table.rows.splice(0, 30);
    for (const r of moved) fake.table.rows.push({ ...r, updated_at: new Date().toISOString() });
  };
};
fake.cfg.honorOrder = true; midWrite();
ok('ORDER BY 있음 → 누락 없음', (await db.listFreshKvCodes('__multiyear__', 100)).size, N);
fake.cfg.honorOrder = false; midWrite();
const unordered = (await db.listFreshKvCodes('__multiyear__', 100)).size;
console.log(`  참고 ORDER BY 무시 서버에서는 ${unordered}건 (${N - unordered}건 누락) — M4 수정이 실효적임을 보임`);
fake.cfg.onPageServed = null; fake.cfg.honorOrder = true;

// ── 2b. 페이지 사이 삭제 — keyset(L-1)이 OFFSET과 갈리는 지점 ──
// ORDER BY만으로는 삭제를 막지 못한다. 이미 서빙된 앞쪽 행이 사라지면 뒤쪽 행이 그만큼
// 당겨져 다음 OFFSET이 그 구간을 통째로 건너뛴다. 커서(code > 마지막값)는 영향받지 않는다.
console.log('\n=== 2b. 페이지네이션 중 삭제 발생 ===');
let deleted = false;
fake.cfg.onPageServed = () => {
  if (deleted) return;
  deleted = true;
  const doomed = [...fake.table.rows].sort((a, b) => (a.code < b.code ? -1 : 1)).slice(0, 30);
  for (const d of doomed) {
    const i = fake.table.rows.findIndex(r => r.code === d.code);
    if (i >= 0) fake.table.rows.splice(i, 1);
  }
};
// 첫 페이지에서 이미 받아둔 30건이므로 결과 집합은 여전히 N이어야 한다.
ok('페이지 사이 삭제에도 전수', (await db.listFreshKvCodes('__multiyear__', 100)).size, N);
fake.cfg.onPageServed = null;

// ── 2c. 페이지 단위 재시도/백오프 ──
// 백필은 페이지를 수십 장 넘긴다. 그중 한 장이 502로 튀는 것만으로 이미 받은 수천 행을
// 버리고 처음부터 다시 도는 구조였다.
//
// 실패를 예외(=fetch 거절)로 주입하면 postgrest-js가 자체 재시도 3회(1s/2s/4s)로 먼저
// 흡수한다 — 2회짜리 장애로는 db.js 계층이 있든 없든 통과해서 아무것도 검증하지 못한다.
// 그래서 기본 케이스는 라이브러리가 재시도하지 않는 상태(500)로 주입하고, 라이브러리
// 재시도를 소진시키는 경로는 아래에서 따로 한 번만 확인한다.
console.log('\n=== 2c. 페이지 단위 재시도 ===');
fake.reset();
for (let i = 0; i < 1200; i++) fake.seed(`__multiyear__${String(i).padStart(6, '0')}`, [{ y: 1 }], 1);
const err500 = () => Response.json({ message: '일시 장애', code: 'XX000' }, { status: 500 });
let hard = 1;
fake.cfg.onPageServed = () => (hard-- > 0 ? err500() : undefined);
ok('500 1회 → 계층 재시도로 완주', (await db.listFreshKvCodes('__multiyear__', 100)).size, 1200);
fake.cfg.onPageServed = () => err500();
const permErr = await db.listFreshKvCodes('__multiyear__', 100).then(() => null, e => e.message);
// 무한 재시도로 조용히 매달리면 크론이 통째로 멈춘다 — 유한 횟수 뒤에는 소리 내며 실패해야 한다.
ok('영구 장애 → 재시도 소진 후 throw', /재시도/.test(permErr || ''), true);

// 재시도는 같은 페이지를 다시 요청한다 — keyset 커서가 실패한 페이지에서 이미 전진해 있으면
// 구간이 빠지고, 성공분을 되감으면 그 페이지가 두 번 쌓인다. Set을 돌려주는
// listFreshKvCodes로는 중복이 보이지 않으므로 배열을 돌려주는 경로로 확인한다.
fake.reset();
for (let i = 0; i < 1200; i++) {
  fake.stocks.rows.push({ code: String(i).padStart(6, '0'), market: 'KOSPI', is_active: 1 });
}
let midFail = 1;
fake.cfg.onPageServed = ({ cursor }) => (cursor && midFail-- > 0 ? err500() : undefined);
const retried = await db.listAllStocks();
ok('중간 페이지 재시도 후 행 수 정확', retried.length, 1200);
ok('중간 페이지 재시도 후 중복 없음', new Set(retried.map(r => r.code)).size, 1200);

// 라이브러리 재시도를 넘기는 연속 실패에서만 db.js 계층이 실제로 일한다.
// 4연속 fetch 거절 = postgrest-js의 4회 시도 소진 → db.js가 한 번 더 받아 완주.
// 라이브러리 백오프(1+2+4초) 때문에 이 한 줄만 7초 남짓 걸린다.
fake.reset();
for (let i = 0; i < 600; i++) fake.seed(`__multiyear__${String(i).padStart(6, '0')}`, [{ y: 1 }], 1);
let boom = 4;
fake.cfg.onPageServed = () => { if (boom-- > 0) throw new Error('일시 장애'); };
ok('fetch 거절 4연속 → 계층 재시도로 완주', (await db.listFreshKvCodes('__multiyear__', 100)).size, 600);
fake.cfg.onPageServed = null;

// 이후 검증들이 2500건 데이터셋을 전제하므로 원복한다.
fake.reset();
for (let i = 0; i < N; i++) fake.seed(`__multiyear__${String(i).padStart(6, '0')}`, [{ year: 2025 }], 1);

// ── 3. 서버 db-max-rows가 PAGE(500)보다 작을 때 (L2가 실제로 막아주는가) ──
console.log('\n=== 3. db-max-rows 상한이 낮은 서버 ===');
for (const cap of [7, 300, 499, 500, 1000, 5000]) {
  fake.cfg.maxRows = cap;
  ok(`maxRows=${cap}에서도 전수`, (await db.listFreshKvCodes('__multiyear__', 100)).size, N);
}
// 상한이 병적으로 낮으면 조용히 느려지는 대신 소리 내며 실패해야 한다
fake.cfg.maxRows = 1;
const capErr = await db.listFreshKvCodes('__multiyear__', 100).then(() => null, e => e.message);
ok('maxRows=1 → 페이지 상한 초과로 throw', /페이지 상한/.test(capErr || ''), true);
fake.cfg.maxRows = 1000;

// ── 4. 접두사 LIKE 오탐 (L1) ──
console.log('\n=== 4. 접두사 충돌 ===');
fake.reset();
fake.seed('__company__005930', { a: 1 }, 1);
fake.seed('XXcompanyYY111111', { a: 1 }, 1);   // '_'가 단일문자 와일드카드라 LIKE에는 걸린다
const co = await db.listFreshKvCodes('__company__', 180);
ok('정상 키만 포함', [...co].sort(), ['005930']);

// ── 4b. 손상된 raw_json의 자가치유 (L-3) ──
// 깨진 행은 kvGetFresh에선 미스지만 listFreshKvCodes는 updated_at만 보므로 "신선"으로 센다.
// 백필은 영원히 건너뛰고 읽기는 영원히 실패하는 영구 구멍 — TTL이 180일이면 반년간 무증상이다.
console.log('\n=== 4b. 손상 행 자가치유 ===');
fake.reset();
fake.table.rows.push({ code: '__multiyear__000001', raw_json: '{깨진 JSON',
  updated_at: new Date().toISOString() });
fake.seed('__multiyear__000002', [{ year: 2025 }], 1);
ok('치유 전 — 손상 행이 신선으로 집계됨', (await db.listFreshKvCodes('__multiyear__', 100)).has('000001'), true);
ok('손상 행 읽기 → undefined', await db.getMultiYearCache('000001'), undefined);
await new Promise(r => setTimeout(r, 50));  // markKvStale은 읽기를 막지 않도록 fire-and-forget이다
const healed = await db.listFreshKvCodes('__multiyear__', 100);
ok('읽은 뒤 — 신선 목록에서 빠짐(백필 대상 복귀)', healed.has('000001'), false);
ok('정상 행은 영향 없음', healed.has('000002'), true);
// 행을 지우지 않는다 — 다음 수집이 덮어쓰므로 원인 추적용 원본을 남겨도 손해가 없다.
ok('손상 행 자체는 보존', fake.table.rows.some(r => r.code === '__multiyear__000001'), true);

// 순차 읽기는 TTL 검사가 파싱보다 앞이라 두 번째부터 저절로 수렴하지만, 동시 읽기는 전부
// 아직 옛 updated_at을 보고 각자 PATCH를 쏜다 — 쓰기 횟수가 "행당 1회"가 아니라 "동시성만큼"이 된다.
fake.reset();
fake.table.rows.push({ code: '__multiyear__000003', raw_json: '{깨진', updated_at: new Date().toISOString() });
fake.stats.pgUpdates = 0;
await Promise.all(Array.from({ length: 20 }, () => db.getMultiYearCache('000003')));
await new Promise(r => setTimeout(r, 50));
ok('동시 20회 읽기 → 치유 PATCH 1회', fake.stats.pgUpdates, 1);

// ── 5. TTL 경계 ──
console.log('\n=== 5. TTL 필터 ===');
fake.reset();
fake.seed('__quarterly__000001', { q: 1 }, 10);
fake.seed('__quarterly__000002', { q: 1 }, 50);  // 45일 TTL 초과
ok('신선한 것만', [...(await db.listFreshKvCodes('__quarterly__', 45))].sort(), ['000001']);

// ── 6. setter의 null 거부 (L4) ──
console.log('\n=== 6. null 적재 거부 ===');
fake.reset();
await db.setCompanyInfoCache('005930', null);
await db.setMultiYearCache('005930', null);
await db.setQuarterlyCache('005930', null);
ok('null은 행을 만들지 않음', fake.table.rows.length, 0);
await db.setMultiYearCache('005930', [{ year: 2025, revenue: 100 }]);
ok('정상값은 적재됨', fake.table.rows.length, 1);

// ── 7. countKvPrefix ──
console.log('\n=== 7. countKvPrefix ===');
fake.reset();
for (let i = 0; i < 1234; i++) fake.seed(`__multiyear__${String(i).padStart(6, '0')}`, [], 1);
ok('exact count (1000행 상한 무관)', await db.countKvPrefix('__multiyear__'), 1234);

// ── 8. 백필 통합 — 예산·재개·집계 ──
console.log('\n=== 8. runFundamentalsBackfill 통합 ===');
const cron = await import('../cron.js');
fake.reset();
const CODES = Array.from({ length: 20 }, (_, i) => String(100000 + i));
fake.seed('__corpmap__', Object.fromEntries(CODES.map(c => [c, `corp${c}`])), 0);

const r1 = await cron.runFundamentalsBackfill({ full: true, maxDartCalls: 10000 });
console.log('  1회차:', JSON.stringify({ universe: r1.universe, targeted: r1.targeted, filled: r1.filled,
  empty: r1.empty, freshSkipped: r1.freshSkipped, calls: r1.dartCallsBudgeted, stoppedBy: r1.stoppedBy }));
ok('전 종목 적재', r1.filled, 20);
ok('무자료 0', r1.empty, 0);
ok('예산 = 20종목 × 12회', r1.dartCallsBudgeted, 240);
ok('실제 DART 호출 ≤ 예산', fake.stats.dartCalls <= 240, true);

const r2 = await cron.runFundamentalsBackfill({ full: true, maxDartCalls: 10000 });
console.log('  2회차:', JSON.stringify({ targeted: r2.targeted, freshSkipped: r2.freshSkipped, calls: r2.dartCallsBudgeted }));
ok('재개형 — 전부 신선 스킵', r2.freshSkipped, 20);
ok('재개형 — 추가 호출 0', r2.dartCallsBudgeted, 0);

// 예산 부족 시 조기 중단
fake.reset();
fake.seed('__corpmap__', Object.fromEntries(CODES.map(c => [c, `corp${c}`])), 0);
const r3 = await cron.runFundamentalsBackfill({ full: true, maxDartCalls: 100 });
console.log('  예산100:', JSON.stringify({ filled: r3.filled, calls: r3.dartCallsBudgeted,
  stoppedBy: r3.stoppedBy, batchRemaining: r3.batchRemaining }));
ok('예산 초과 전에 중단', r3.dartCallsBudgeted <= 100, true);
ok('중단 사유 quota', r3.stoppedBy, 'quota');

// 신선도 조회 실패 시 예산을 태우지 않는가.
// corp_code 맵을 미리 넣어 둔다 — 없으면 refreshCorpCodes가 zip 1회를 받으러 가고,
// 그 1회가 "종목별 수집"과 섞여 무엇이 절약됐는지 알 수 없게 된다.
fake.reset();
fake.seed('__corpmap__', Object.fromEntries(CODES.map(c => [c, `corp${c}`])), 0);
const before = fake.stats.dartCalls;
fake.cfg.onPageServed = () => { throw new Error('DB 장애'); };
const r4 = await cron.runFundamentalsBackfill({ full: true, maxDartCalls: 10000 }).catch(e => ({ ok: false, error: e.message }));
fake.cfg.onPageServed = null;
ok('신선도 조회 실패 → ok:false', r4.ok, false);
ok('실패 시 종목별 DART 호출 0', fake.stats.dartCalls - before, 0);
// 조기반환이 예산 사용량을 명시하지 않으면 server.js가 maxDartCalls 전액을 차감한다 —
// 0회 호출로 하루치 예산이 소진돼 429로 잠기는 경로(M-1).
ok('조기반환도 예산 사용량 0을 명시', r4.dartCallsBudgeted, 0);

// ── 9. saveAnalysisToDB 병합 — 온디맨드가 크론 결과를 지우지 않는가 ──
// analysis_json은 통 blob이고 PK가 (code, analysis_date)라 upsert 한 번이면 통째로 교체된다.
// 온디맨드 경로는 park·matrixZone·growth를 만들지 않으므로, 관심종목 화면을 여는 것만으로
// 그날의 박세익 데이터가 사라진다 — 화면 조회가 스크리너 결과를 지우는 셈이다.
console.log('\n=== 9. saveAnalysisToDB 병합 ===');
fake.cfg.honorOrder = true; fake.cfg.onPageServed = null;
const readJson = (code) => {
  const row = fake.table.rows.find(r => r.code === code);
  return row ? JSON.parse(row.analysis_json) : null;
};

fake.reset();
// 크론이 먼저 저장한 상태
await db.saveAnalysisToDB('005930', {
  close: 70000, pScore: 60, lScore: 30,
  park: { score: 82, grade: 'A (선점 유력)', gated: null, reasons: ['매출 3년 연속 증가'] },
  matrixZone: 'SEONJEOM', growth: { revenueStreak: 3 },
});
// 이어서 온디맨드가 같은 날 같은 종목을 저장 — park/matrixZone/growth 없음
await db.saveAnalysisToDB('005930', { close: 71000, pScore: 62, lScore: 33 });

const merged = readJson('005930');
ok('행은 하나로 유지', fake.table.rows.length, 1);
ok('park 보존', merged.park?.score, 82);
ok('matrixZone 보존', merged.matrixZone, 'SEONJEOM');
ok('growth 보존', merged.growth?.revenueStreak, 3);
// 온디맨드가 실제로 계산한 값은 최신이므로 그대로 이겨야 한다 — 병합이 "되돌리기"가 되면 안 된다.
ok('최신 종가는 덮어씀', merged.close, 71000);
ok('최신 점수는 덮어씀', [merged.pScore, merged.lScore], [62, 33]);

// 온디맨드가 park를 명시적으로 담아 오면 그 값이 이긴다(undefined일 때만 이어받는다).
fake.reset();
await db.saveAnalysisToDB('000660', { close: 100, park: { score: 10 } });
await db.saveAnalysisToDB('000660', { close: 110, park: { score: 90 } });
ok('명시된 park는 최신값 우선', readJson('000660').park.score, 90);

// 기존 행이 깨진 JSON이어도 저장 자체는 막히면 안 된다 — 최신 지표를 잃는 쪽이 더 나쁘다.
fake.reset();
fake.table.rows.push({ code: '035420', analysis_date: new Date().toISOString().slice(0, 10),
  analysis_json: '{깨진 JSON', updated_at: new Date().toISOString() });
await db.saveAnalysisToDB('035420', { close: 200, pScore: 55 });
ok('깨진 기존 JSON → 저장 성공', readJson('035420')?.close, 200);

// ── 10. getGrowthCaches 배치 조회 (L-6) ──
// 종목당 3회 왕복 × 3,900종목 = 11,700회. 같은 테이블의 다른 키일 뿐이라 .in()으로 묶는다.
console.log('\n=== 10. getGrowthCaches 배치 조회 ===');
fake.reset();
fake.seed('__company__005930', { indutyCode: '264' }, 1);
fake.seed('__multiyear__005930', [{ year: 2025, revenue: 100 }], 90);   // 100일 TTL 이내
fake.seed('__quarterly__005930', { rev: 10 }, 60);                       // 45일 TTL 초과
const sel0 = fake.stats.pgSelects;
const gc = await db.getGrowthCaches('005930');
ok('왕복 1회로 3종', fake.stats.pgSelects - sel0, 1);
ok('개황 적중', gc.company, { indutyCode: '264' });
ok('연간 적중', gc.multiYear, [{ year: 2025, revenue: 100 }]);
// TTL은 키마다 다르다(개황 180 / 연간 100 / 분기 45) — 한 번에 읽어도 행별로 따로 판정해야 한다.
ok('분기는 자기 TTL로 만료', gc.quarterly, undefined);

fake.reset();
fake.seed('__company__000660', { indutyCode: '261' }, 170);  // 180일 TTL 이내
fake.seed('__multiyear__000660', [{ year: 2024 }], 170);     // 100일 TTL 초과
const gc2 = await db.getGrowthCaches('000660');
ok('개황 170일 → 신선', gc2.company, { indutyCode: '261' });
ok('연간 170일 → 만료', gc2.multiYear, undefined);
ok('없는 키 → undefined', gc2.quarterly, undefined);

const gcNone = await db.getGrowthCaches('999999');
ok('전부 미스', [gcNone.company, gcNone.multiYear, gcNone.quarterly], [null, null, null]);

// 배치 조회도 손상 행을 자가치유해야 한다 — 개별 조회에만 있으면 스캔 경로에서 구멍이 남는다.
fake.reset();
fake.table.rows.push({ code: '__multiyear__035420', raw_json: '{깨진', updated_at: new Date().toISOString() });
const gcBad = await db.getGrowthCaches('035420');
ok('손상 행 → undefined', gcBad.multiYear, undefined);
await new Promise(r => setTimeout(r, 50));
ok('배치 경로도 신선도 하향', (await db.listFreshKvCodes('__multiyear__', 100)).has('035420'), false);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
