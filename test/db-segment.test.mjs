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
  fake.cfg.onPageServed = ({ offset }) => {
    if (offset !== 0) return;
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

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
