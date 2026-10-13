// /api/screener 섹터 축 — 필드·필터·집계·캐시를 HTTP 레벨에서 고정한다.
//
// 이 파일이 있는 이유: 섹터는 "좁히기만 하는" 필터라 오작동 방향이 위험한 쪽이다.
// 필터가 조용히 사라지면 결과가 넓어지고, 화면에는 "이 섹터에 5종목"이 아니라
// "전 유니버스가 이 섹터"로 보인다. 오타 거절(400)과 캐시 키에 섹터가 실리는지를
// 함께 지키지 않으면 두 경로 중 하나로 반드시 새어 나온다.
//
// screener-message.test.mjs와 같은 이유로 실제 server.js를 fake PostgREST 위에 띄운다 —
// 섹터 폴백(analysis_json 우선, 없으면 SECTOR_MAP)과 집계가 라우트 안에 있어 함수로 떼어낼 수 없다.
import * as fake from './fake_pgrst.mjs';
import { exitClean } from './exit_clean.mjs';
fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '3996';
delete process.env.DATABASE_URL;   // 리슨 직후 autoMigrate가 실 DB에 DDL을 던지지 않도록
fake.cfg.honorOrder = true;

const { SECTOR_NAMES } = await import('../sector_map.js');

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const row = (code, json) => ({ code, analysis_date: day(1), analysis_json: JSON.stringify(json) });

// 005930/000660=반도체, 373220=2차전지, 005380=자동차 (SECTOR_MAP 실값).
// 000660은 analysis_json에 sector가 없다 — 구 스캔 행의 SECTOR_MAP 폴백 경로다.
// 900099는 어느 섹터에도 없는 코드 — 집계에서 '미분류'로 떨어져야 한다.
fake.table.rows.push(
  row('005930', { sector: '반도체', park: { score: 80, grade: 'A (선점)' }, matrixZone: 'SEONJEOM',
                  fundamentals: { per: 10 }, perBasis: '반도체 중앙값', perBasisMedian: 18 }),
  row('000660', { park: { score: 60, grade: 'B (후보)' }, matrixZone: 'NEUTRAL',
                  fundamentals: { per: 20 } }),
  row('373220', { sector: '2차전지', park: { score: 40, grade: 'C (관찰)' }, matrixZone: 'SEONJEOM',
                  fundamentals: { per: 30 }, perBasis: '유니버스 중앙값', perBasisMedian: 12.5 }),
  row('005380', { fundamentals: { per: 5 } }),
  row('900099', { park: { score: 70, grade: 'B (후보)' }, matrixZone: 'SEONJEOM', fundamentals: {} }),
);

await import('../server.js');
await new Promise(r => setTimeout(r, 1500));

const jwt = (await import('jsonwebtoken')).default;
const token = jwt.sign({ email: 't@t.com', role: 'master' }, 'test-secret', { expiresIn: '1h' });

// 스크리너 캐시(TTL 1시간)의 키는 필터값 조합이다. 시나리오마다 per_max를 1씩 어긋나게 두어
// 같은 키가 재사용되지 않게 한다. per_max 900대는 표본의 PER(최대 30)을 전혀 거르지 않는다.
const get = async (q) => {
  const r = await fetch(`http://127.0.0.1:3996/api/screener?${q}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK   ${name.padEnd(46)} ${g}`); }
  else { fail++; console.log(`  FAIL ${name.padEnd(46)} got=${g} want=${w}`); }
};
const byCode = (items) => Object.fromEntries(items.map(i => [i.code, i]));

console.log('\n── 1. 종목별 섹터 필드 ──');
const base = await get('per_max=901&limit=50');
const it = byCode(base.body.items);
ok('전체 건수', base.body.total, 5);
ok('analysis_json의 sector 사용', it['005930'].sector, '반도체');
// 구 스캔 행에는 sector 키가 없다. 폴백이 죽으면 이 행만 조용히 '미분류'로 빠진다.
ok('sector 없는 행 → SECTOR_MAP 폴백', it['000660'].sector, '반도체');
ok('매핑 없는 코드 → null', it['900099'].sector, null);
ok('저평가 기준 라벨 전달', [it['005930'].perBasis, it['005930'].perBasisMedian], ['반도체 중앙값', 18]);
ok('기준 없는 행은 null', [it['000660'].perBasis, it['000660'].perBasisMedian], [null, null]);

console.log('\n── 2. 섹터 집계 ──');
const sum = base.body.sectorSummary;
ok('집계 합계 == 전체 건수', sum.reduce((a, s) => a + s.count, 0), base.body.total);
// 정렬: 선점 수 desc → 중앙점수 desc → 종목 수 desc.
// 반도체와 미분류는 선점 1·중앙 70으로 동률이라 종목 수가 가른다.
ok('정렬 순서', sum.map(s => s.sector), ['반도체', '미분류', '2차전지', '자동차']);
// 평균이면 (80+60)/2=70으로 같지만, 중앙값이어야 하는 이유는 표본이 짝수가 아닐 때 갈린다.
ok('반도체 집계', sum[0], { sector: '반도체', count: 2, seonjeom: 1, medPark: 70, scored: 2, medPer: 15 });
// park이 없는 행(005380)은 채점 모수에서 빠진다 — count 1인데 scored 0.
ok('자동차 집계(미채점)', sum[3], { sector: '자동차', count: 1, seonjeom: 0, medPark: null, scored: 0, medPer: 5 });
// PER이 없는 행은 medPer 모수에서만 빠지고 count에는 남는다.
ok('미분류 집계(PER 없음)', sum[1], { sector: '미분류', count: 1, seonjeom: 1, medPark: 70, scored: 1, medPer: null });
ok('허용 섹터 목록 = 서버 상수', base.body.sectorOptions, SECTOR_NAMES);
// '미분류'는 집계 라벨이지 필터 값이 아니다. 드롭다운에 섞이면 고르는 순간 400이 난다.
ok("'미분류'는 필터 옵션이 아님", base.body.sectorOptions.includes('미분류'), false);

console.log('\n── 3. 섹터 필터 ──');
const semi = await get('per_max=902&sector=' + encodeURIComponent('반도체') + '&limit=50');
ok('sector=반도체 → 2건', semi.body.total, 2);
ok('결과가 전부 해당 섹터', semi.body.items.every(i => i.sector === '반도체'), true);
ok('폴백 행도 필터에 잡힘', semi.body.items.map(i => i.code).sort(), ['000660', '005930']);
ok('집계도 필터 후 기준', semi.body.sectorSummary.map(s => [s.sector, s.count]), [['반도체', 2]]);

console.log('\n── 4. 오타 거절 ──');
const bad = await get('sector=' + encodeURIComponent('반도체류'));
ok('잘못된 섹터 → 400', bad.status, 400);
ok('허용 목록 안내', /허용/.test(bad.body.error || ''), true);
// 좁히기 필터가 조용히 무시되면 전 유니버스가 그 섹터로 보인다. 200으로 새는지 확인.
ok('거절 응답에 items 없음', 'items' in bad.body, false);

console.log('\n── 5. 프리셋 + 섹터 조합 ──');
// preset은 filters 객체를 통째로 갈아끼운다. 섹터가 그 뒤에 실리지 않으면 여기서 드러난다.
const park = await get('preset=park&limit=50');
ok('preset=park 단독', park.body.items.map(i => i.code).sort(), ['005930', '900099']);
const combo = await get('preset=park&sector=' + encodeURIComponent('반도체') + '&limit=50');
ok('preset=park + sector=반도체', combo.body.items.map(i => i.code), ['005930']);
ok('프리셋이 섹터를 덮어쓰지 않음', combo.body.total < park.body.total, true);

console.log('\n── 6. 캐시 경로 ──');
const again = await get('per_max=901&limit=50');
ok('같은 질의 → 캐시 응답', again.body.fromCache, true);
ok('캐시에도 sectorSummary', again.body.sectorSummary, sum);
ok('캐시에도 sectorOptions', again.body.sectorOptions, SECTOR_NAMES);
// 캐시 키에 섹터가 안 실리면 아래 두 질의가 같은 키를 공유해 5건이 그대로 돌아온다.
const c1 = await get('per_max=903&limit=50');
const c2 = await get('per_max=903&sector=' + encodeURIComponent('2차전지') + '&limit=50');
ok('캐시 키가 섹터를 구분함', [c1.body.total, c2.body.total], [5, 1]);

console.log('\n── 7. 페이지네이션 ──');
// 집계는 현재 페이지가 아니라 필터 결과 전체 기준이어야 한다 — 아니면 페이지를 넘길 때마다
// "어느 섹터가 저평가인가"의 답이 바뀐다.
const pg = await get('per_max=904&limit=2');
ok('페이지 크기', pg.body.items.length, 2);
ok('total은 전체', pg.body.total, 5);
ok('집계는 페이지와 무관', pg.body.sectorSummary.reduce((a, s) => a + s.count, 0), 5);

console.log('\n── 8. 스캔 데이터 없음 ──');
// 화면은 sectorOptions로 드롭다운을 만든다. 이 경로에서 목록이 빠지면 스캔이 밀린 동안
// 섹터를 고를 방법이 사라지고, 데이터가 돌아와도 한 번 더 조회하기 전까지 빈 채로 남는다.
fake.table.rows.length = 0;
const empty = await get('per_max=905&limit=50');
ok('데이터 없음 → 0건', empty.body.total, 0);
ok('안내문', /스캔 데이터 없음/.test(empty.body.message || ''), true);
ok('그래도 sectorOptions는 실림', empty.body.sectorOptions, SECTOR_NAMES);

console.log(`\n통과 ${pass} / 실패 ${fail}\n`);
await exitClean(fail ? 1 : 0);
