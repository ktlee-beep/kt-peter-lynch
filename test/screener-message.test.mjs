// /api/screener 미계측 안내 — "후보 0건"과 "아직 계산 안 됨"이 화면에서 갈리는지 지킨다.
//
// 이 파일이 있는 이유: 안내문 게이트가 박세익 축만 보고 RS 축을 빠뜨린 채 배포된 적이 있다
// (server.js parkFiltered에 fRsMin 누락). 두 축 모두 야간 스캔이 만드는 값이라 같은 실패를
// 공유하는데, 한쪽만 안내가 붙으면 RS 필터로는 백필 누락이 조용히 0건으로 묻힌다.
// 축이 늘어날 때 같은 누락이 반복되지 않도록 축별 조합을 전수로 고정한다.
//
// 다른 테스트와 달리 실제 server.js를 fake PostgREST 위에 띄운다 — 안내문 판정이 라우트
// 안에 있어서 함수 단위로 떼어낼 수 없다.
import * as fake from './fake_pgrst.mjs';
fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3997';
delete process.env.DATABASE_URL;   // 리슨 직후 autoMigrate가 실 DB에 DDL을 던지지 않도록
fake.cfg.honorOrder = true;

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const row = (code, json) => ({ code, analysis_date: day(1), analysis_json: JSON.stringify(json) });

const FULL      = { park: { score: 72, grade: 'B (후보)' }, matrixZone: 'SEONJEOM', pctFrom52wHigh: -23.4,
                    rs: { score: 1.03, pct: 41, partial: false } };
// rs 객체는 있는데 백분위만 없는 상태 — RS 분포 기준선이 아직 없으면 실제로 이렇게 된다.
// 필터가 보는 값이 pct이므로 카운터도 pct 기준이어야 이 케이스가 미계측으로 잡힌다.
const PARK_ONLY = { park: { score: 72, grade: 'B (후보)' }, matrixZone: 'SEONJEOM',
                    rs: { score: 1.03, pct: null, partial: true } };
const NEITHER   = { fundamentals: { per: 8, pbr: 0.7 } };

fake.table.rows.push(row('900001', FULL));

await import('../server.js');
await new Promise(r => setTimeout(r, 1500));

const jwt = (await import('jsonwebtoken')).default;
const token = jwt.sign({ email: 't@t.com', role: 'master' }, 'test-secret', { expiresIn: '1h' });

// 스크리너 캐시(TTL 1시간)의 키는 필터값 조합이다. 시나리오마다 임계값을 1씩 어긋나게 두어
// 같은 키가 재사용되지 않게 한다 — 안 그러면 행을 갈아끼워도 이전 응답이 그대로 나온다.
const probe = async (q) => {
  const r = await fetch(`http://127.0.0.1:3997/api/screener?${q}&limit=5`,
    { headers: { Authorization: `Bearer ${token}` } });
  const b = await r.json();
  return [b.total, b.message ?? null];
};

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK   ${name.padEnd(44)} ${g}`); }
  else { fail++; console.log(`  FAIL ${name.padEnd(44)} got=${g} want=${w}`); }
};
const M_PARK = '박세익 스코어가 아직 계산되지 않았습니다. 다음 전체 스캔 이후 사용 가능합니다.';
const M_RS   = 'RS 백분위가 아직 계산되지 않았습니다. 다음 전체 스캔 이후 사용 가능합니다.';
const M_BOTH = '박세익 스코어 · RS 백분위가 아직 계산되지 않았습니다. 다음 전체 스캔 이후 사용 가능합니다.';

console.log('\n── 1. 두 축 모두 계측됨 → 안내 없이 정상 필터링 ──');
ok('park_min=60',                await probe('park_min=60'),   [1, null]);
ok('rs_min=30',                  await probe('rs_min=30'),     [1, null]);
// 계측은 됐는데 조건에 미달한 진짜 0건. 여기에 안내가 붙으면 반대 방향 오작동이다.
ok('rs_min=90 → 진짜 0건, 안내 없음', await probe('rs_min=90'),     [0, null]);
ok('zone=SEONJEOM',              await probe('zone=SEONJEOM'), [1, null]);

console.log('\n── 2. 두 축 모두 미계측 ──');
fake.table.rows.length = 0;
fake.table.rows.push(row('900002', NEITHER));
ok('park_min → 박세익 안내',        await probe('park_min=61'),           [0, M_PARK]);
ok('rs_min → RS 안내',            await probe('rs_min=31'),             [0, M_RS]);
ok('park_min+rs_min → 두 축 병기',  await probe('park_min=62&rs_min=32'), [0, M_BOTH]);
ok('zone 단독 → 박세익 안내',        await probe('zone=BREAKOUT'),         [0, M_PARK]);
// 야간 스캔 값을 안 쓰는 필터에는 안내가 붙지 않아야 한다.
ok('lynch_min 단독 → 안내 없음',     await probe('lynch_min=0'),           [1, null]);

console.log('\n── 3. 박세익만 계측, RS 백분위 없음 (한쪽만 빈 정상 상태) ──');
fake.table.rows.length = 0;
fake.table.rows.push(row('900003', PARK_ONLY));
ok('park_min → 안내 없음',         await probe('park_min=63'),           [1, null]);
ok('rs_min → RS 안내',            await probe('rs_min=33'),             [0, M_RS]);
ok('둘 다 → 비어 있는 축만 안내',      await probe('park_min=64&rs_min=34'), [0, M_RS]);

console.log('\n── 4. 스캔 자체가 없음 (기존 경로 회귀) ──');
fake.table.rows.length = 0;
const [total, msg] = await probe('park_min=65');
ok('행 0건 → 스캔없음 안내', [total, /스캔 데이터 없음/.test(msg ?? '')], [0, true]);

console.log(`\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
