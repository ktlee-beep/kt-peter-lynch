// /api/screener ROE·부채비율 — DART 폴백 연결과 미계측 경고(filterWarning) 분리를 지킨다.
//
// 이 파일이 있는 이유: ROE·부채비율은 박세익·RS와 달리 null이 "통과"다. 그래서 미계측이어도
// 결과는 "이 조건 없이 거른 목록"으로 멀쩡히 나온다. 이것을 박세익·RS처럼 message로 내보내면
// 화면(ScreenerSection)이 목록을 숨겨, growth.ratios가 생기기 전(배포 직후 첫 야간 스캔 전)
// 린치·가치·성장 프리셋이 안내문만 남긴다. 미계측은 목록을 가리지 않는 filterWarning으로 낸다.
//
// screener-message와 같은 방식으로 실제 server.js를 fake PostgREST 위에 띄운다.
import * as fake from './fake_pgrst.mjs';
import { exitClean } from './exit_clean.mjs';
fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3995';
delete process.env.DATABASE_URL;   // 리슨 직후 autoMigrate가 실 DB에 DDL을 던지지 않도록
fake.cfg.honorOrder = true;

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const row = (code, json) => ({ code, analysis_date: day(1), analysis_json: JSON.stringify(json) });
const ratios = (year, roe, debtRatio, impaired = false) => ({ growth: { ratios: { year, roe, debtRatio, impaired } } });

// growth.ratios가 생기기 전 행 — 네이버 펀더멘털에는 roe·부채비율이 없다.
const OLD = { fundamentals: { per: 8, pbr: 0.7 } };

fake.table.rows.push(row('900101', OLD));

await import('../server.js');
await new Promise(r => setTimeout(r, 1500));

const jwt = (await import('jsonwebtoken')).default;
const token = jwt.sign({ email: 't@t.com', role: 'master' }, 'test-secret', { expiresIn: '1h' });

// 스크리너 캐시(TTL 1시간)의 키는 필터값 조합이다 — 시나리오마다 임계값을 어긋나게 둔다.
const get = async (q) => {
  const r = await fetch(`http://127.0.0.1:3995/api/screener?${q}&limit=5`,
    { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
};
const probe = async (q) => {
  const b = await get(q);
  return [b.total, b.message ?? null, b.filterWarning ?? null];
};

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK   ${name.padEnd(44)} ${g}`); }
  else { fail++; console.log(`  FAIL ${name.padEnd(44)} got=${g} want=${w}`); }
};
const tail = ' 조건은 아직 값이 없어 적용하지 않았습니다(아래 목록은 이 조건 없이 거른 결과). 다음 전체 스캔 이후 적용됩니다.';
const W_ROE  = 'ROE' + tail;
const W_DEBT = '부채비율' + tail;
const W_BOTH = 'ROE · 부채비율' + tail;
const M_PARK = '박세익 스코어가 아직 계산되지 않았습니다. 다음 전체 스캔 이후 사용 가능합니다.';

console.log('\n── 1. 폴백 이전 행 → 목록은 그대로, 경고만 ──');
ok('roe_min → ROE 경고, message 없음',  await probe('roe_min=10'),             [1, null, W_ROE]);
ok('debt_max → 부채비율 경고',           await probe('debt_max=150'),           [1, null, W_DEBT]);
ok('둘 다 → 병기',                      await probe('roe_min=11&debt_max=151'), [1, null, W_BOTH]);
// 프리셋도 ROE·부채를 건다(server.js preset=value). 목록이 숨겨지면 안 된다.
ok('preset=value → 목록 + 경고',         await probe('preset=value'),           [1, null, W_BOTH]);
// 캐시 경로에서도 경고가 실려야 한다 — 두 번째 호출은 fromCache다.
const again = await get('preset=value');
ok('캐시 응답에도 경고 유지', [again.fromCache === true, again.filterWarning ?? null], [true, W_BOTH]);
ok('비율 필터 없음 → 경고 없음',          await probe('per_max=20'),             [1, null, null]);
// 박세익 미계측과 겹치면 둘 다 나온다. 화면은 message가 있으면 목록 대신 안내를 보인다.
ok('park_min+roe_min → 둘 다',          await probe('park_min=60&roe_min=12'), [0, M_PARK, W_ROE]);

console.log('\n── 2. DART 폴백 연결됨 ──');
fake.table.rows.length = 0;
fake.table.rows.push(row('900102', { ...OLD, ...ratios(2025, 12.5, 80) }));
ok('roe_min=13 → 미달 0건, 경고 없음',    await probe('roe_min=13&debt_max=200'), [0, null, null]);
ok('roe_min=12 → 통과',                  await probe('roe_min=12'),              [1, null, null]);
// 계측은 됐는데 조건 미달인 진짜 0건 — 경고가 붙으면 반대 방향 오작동이다.
ok('debt_max=50 → 진짜 0건, 경고 없음',   await probe('debt_max=50'),             [0, null, null]);
const it = (await get('roe_min=5')).items?.[0];
ok('항목 필드: roe·debtRatio·ratioYear',
  [it?.roe, it?.debtRatio, it?.ratioYear, it?.equityImpaired, it?.debtExempt], [12.5, 80, 2025, false, null]);

console.log('\n── 3. 자본잠식 · 금융업 ──');
fake.table.rows.length = 0;
fake.table.rows.push(row('900103', { ...OLD, ...ratios(2025, null, null, true) }));
// 잠식은 값이 null이어도 "판정된" 행이다 — 미계측 경고 대상이 아니고, 비율 필터가 걸리면 제외.
ok('잠식 + roe_min → 제외, 경고 없음',     await probe('roe_min=1'),               [0, null, null]);
ok('잠식 + 비율 필터 없음 → 노출',         await probe('per_max=21'),              [1, null, null]);
const imp = (await get('per_max=22')).items?.[0];
ok('잠식 항목 표기', [imp?.equityImpaired, imp?.ratioYear, imp?.debtExempt], [true, 2025, null]);

fake.table.rows.length = 0;
fake.table.rows.push(row('900104', { ...OLD, induty: '64110', ...ratios(2025, 9, 1200) }));
ok('금융업 부채 1200% + debt_max=150 → 통과', await probe('debt_max=152'),         [1, null, null]);
const bank = (await get('debt_max=153')).items?.[0];
ok('금융업 면제 표기', [bank?.debtExempt, bank?.debtRatio], ['금융업', 1200]);
ok('금융업도 ROE 필터는 적용',              await probe('roe_min=14'),              [0, null, null]);

console.log(`\n통과 ${pass} / 실패 ${fail}\n`);
await exitClean(fail ? 1 : 0);
