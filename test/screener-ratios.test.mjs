// ROE·부채비율 DART 폴백 · 금융업 면제 · 자본잠식 · 품질 스크린 등급 경계 검증.
// 전부 순수 함수라 서버를 띄우지 않는다: `node test/screener-ratios.test.mjs`
// cron.js는 import 시 db.js를 끌어오므로 park-segment와 같은 방식으로 가짜 환경을 먼저 깐다.
//
// 배경: 네이버 펀더멘털에는 roe도 부채비율도 없어서 스크리너의 ROE·부채 필터가 전 종목 null로
// 조용히 무력화돼 있었다(null 통과 규칙 때문에 "필터를 건 결과"가 "필터를 안 건 결과"와 같았다).
// 같은 실패가 다시 조용히 묻히지 않도록, 폴백이 고르는 연도·금융업 면제·자본잠식의 판정 순서를
// 값 단위로 고정한다. 스크리너 필터는 server.js 라우트에서 applyRatioFilter로 떼어낸 것을 본다.
import * as fake from './fake_pgrst.mjs';

fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

const an   = await import('../analysis.js');
const cron = await import('../cron.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(48)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  good ? pass++ : fail++;
};

// fetchDartMultiYear 행 형태(억원·%). 미확보 연도는 전 필드 null 자리표시다.
const yr = (year, equity, roe, debtRatio) => ({ year, equity, roe, debtRatio });
const ph = (year) => ({ year, revenue: null, operatingProfit: null, netIncome: null, equity: null, roe: null, debtRatio: null });
const ratios = (rows, opts = { refYear: 2026 }) => an.calcBalanceRatios(rows, opts);
const kstYearEarly = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();

// ── 1. calcBalanceRatios — 앵커 연도 ────────────────────────────────
console.log('=== 1. calcBalanceRatios: 앵커 연도 ===');
ok('오름차순 → 최신 연도',
  ratios([yr(2023, 900, 8, 120), yr(2024, 1000, 9, 110), yr(2025, 1100, 10.5, 95.5)]),
  { year: 2025, roe: 10.5, debtRatio: 95.5, impaired: false });
// 배열 위치가 아니라 year 값으로 고른다 — 마지막 원소가 최신이라는 가정에 기대지 않는다.
ok('순서 뒤섞임 → 여전히 최신 연도',
  ratios([yr(2025, 1100, 10.5, 95.5), yr(2023, 900, 8, 120), yr(2024, 1000, 9, 110)]).year, 2025);
// 최신 연도가 자리표시(미공시)면 자본총계가 있는 직전 연도가 앵커다.
ok('최신 연도 자리표시 → 직전 연도',
  ratios([yr(2023, 900, 8, 120), yr(2024, 1000, 9, 110), ph(2025)]),
  { year: 2024, roe: 9, debtRatio: 110, impaired: false });
ok('연도가 문자열이어도 숫자로 비교·반환',
  ratios([yr('2024', 1000, 9, 110), yr('2025', 1100, 10.5, 95.5)]).year, 2025);
// Number(null)·Number('')·Number(false)는 0(정수)이다 — 이런 행이 "0년"으로 끼면 안 된다.
// refYear를 크게 잡아도(래그 상한 무한대) 0년 행은 앵커가 되지 못해야 한다.
ok('연도 null·빈문자열·false 행 → 후보 아님',
  an.calcBalanceRatios([yr(null, 1, 1, 1), yr('', 1, 1, 1), yr(false, 1, 1, 1)], { refYear: 2026, maxLagYears: Infinity }), null);
ok('opts null → KST 기본으로 계산(터지지 않음)',
  an.calcBalanceRatios([yr(kstYearEarly, 1000, 9, 110)], null)?.year, kstYearEarly);

// ── 2. calcBalanceRatios — 차용 상한(래그) ──────────────────────────
console.log('\n=== 2. calcBalanceRatios: 래그 상한 ===');
ok('2026 기준 FY2024 → 사용 (경계)', ratios([yr(2024, 1000, 9, 110)])?.year, 2024);
ok('2026 기준 FY2023 → null', ratios([yr(2023, 1000, 9, 110)]), null);
ok('maxLagYears 0 → 같은 해만', ratios([yr(2025, 1000, 9, 110)], { refYear: 2026, maxLagYears: 0 }), null);
// refYear가 숫자가 아니면 lag가 NaN이다. "lag > max"로 쓰면 상한 검사가 꺼진다 — null로 닫혀야 한다.
ok('refYear NaN → null (fail-closed)', ratios([yr(2025, 1000, 9, 110)], { refYear: NaN }), null);
// ''·false·0을 그대로 빼면 기준 연도가 0년이 되어 2015년 자료도 통과했다(Round 2 실측).
ok('refYear 빈문자열·false·0 → null',
  ['', false, 0].map(r => ratios([yr(2015, 1000, 9, 110)], { refYear: r })), [null, null, null]);
ok('refYear 문자열 연도 → 숫자로 읽음', ratios([yr(2025, 1000, 9, 110)], { refYear: '2026' })?.year, 2025);
ok('앵커가 기준 연도보다 미래 → null', ratios([yr(2027, 1000, 9, 110)], { refYear: 2026 }), null);
// null은 빼기에서 0이 되어 같은 해만 남기던 것 — 숫자가 아니거나 음수면 기본 2년.
ok('maxLagYears null·음수·문자열 → 기본 2년',
  [null, -1, '5'].map(m => ratios([yr(2024, 1000, 9, 110)], { refYear: 2026, maxLagYears: m })?.year), [2024, 2024, 2024]);
ok('maxLagYears null·음수 → 3년 전은 여전히 null',
  [null, -1].map(m => ratios([yr(2023, 1000, 9, 110)], { refYear: 2026, maxLagYears: m })), [null, null]);
// 기본 기준 연도는 KST 올해다. 날짜에 묶이지 않도록 같은 식으로 기대값을 만든다.
const kstYear = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
ok('refYear 생략 → KST 올해 기준 2년 전 사용', an.calcBalanceRatios([yr(kstYear - 2, 1000, 9, 110)])?.year, kstYear - 2);
ok('refYear 생략 → KST 올해 기준 3년 전 null', an.calcBalanceRatios([yr(kstYear - 3, 1000, 9, 110)]), null);

// ── 3. calcBalanceRatios — 연도를 섞지 않음 ─────────────────────────
console.log('\n=== 3. calcBalanceRatios: 한 연도에서만 ===');
// 앵커 연도의 ROE가 비어 있어도 전년 ROE로 메우지 않는다 — 다른 시점의 두 값이 한 줄에 놓인다.
ok('앵커 ROE null → 전년 ROE로 안 메움',
  ratios([yr(2024, 1000, 12, 110), yr(2025, 1100, null, 85)]),
  { year: 2025, roe: null, debtRatio: 85, impaired: false });
ok('NaN·Infinity 비율 → null',
  ratios([yr(2025, 1100, NaN, Infinity)]),
  { year: 2025, roe: null, debtRatio: null, impaired: false });

// ── 4. calcBalanceRatios — 자본잠식 ─────────────────────────────────
console.log('\n=== 4. calcBalanceRatios: 자본잠식 ===');
ok('자본 음수 → 잠식, 비율 null',
  ratios([yr(2025, -50, null, null)]),
  { year: 2025, roe: null, debtRatio: null, impaired: true });
// 이전 흑자 연도로 넘어가면 잠식이 가려진다.
ok('잠식 연도에서 멈춤 (전년 흑자로 안 넘어감)',
  ratios([yr(2024, 300, 15, 90), yr(2025, -50, null, null)]),
  { year: 2025, roe: null, debtRatio: null, impaired: true });
// 원 단위 자본이 양수인데 억원 반올림으로 0이 된 경우. data.js는 이때도 비율을 계산해 둔다.
ok('자본 0(억원 반올림) → 잠식 아님, 비율 유지',
  ratios([yr(2025, 0, 35.2, 900)]),
  { year: 2025, roe: 35.2, debtRatio: 900, impaired: false });
// 원 단위 자본이 -0.3억처럼 0 이하인데 반올림으로 0이 된 경우. data.js는 이때 debtRatio를 null로 두고
// debt(억원)는 남긴다 — 이 조합이면 잠식이다. 비율이 null이라 필터를 통과하던 구멍(Round 2 실측).
ok('자본 0 + 부채 있음 + 부채비율 없음 → 잠식',
  ratios([{ year: 2025, equity: 0, debt: 120, roe: null, debtRatio: null }]),
  { year: 2025, roe: null, debtRatio: null, impaired: true });
ok('자본 0 + 부채 없음 → 잠식 아님(판정 불가)',
  ratios([{ year: 2025, equity: 0, debt: 0, roe: null, debtRatio: null }]),
  { year: 2025, roe: null, debtRatio: null, impaired: false });
ok('자본 0 + 부채 필드 없는 옛 캐시 → 잠식 아님',
  ratios([yr(2025, 0, null, null)]),
  { year: 2025, roe: null, debtRatio: null, impaired: false });
// 잠식인데 행에 비율이 남아 있어도(형태 이상) 내보내지 않는다.
ok('잠식 행에 비율이 있어도 null',
  ratios([yr(2025, -10, 40, 500)]),
  { year: 2025, roe: null, debtRatio: null, impaired: true });

// ── 5. calcBalanceRatios — 비정상 입력·불변성 ───────────────────────
console.log('\n=== 5. calcBalanceRatios: 비정상 입력 ===');
ok('null → null', ratios(null), null);
ok('객체 → null', ratios({ year: 2025, equity: 1 }), null);
ok('빈 배열 → null', ratios([]), null);
ok('자리표시만 → null', ratios([ph(2024), ph(2025)]), null);
ok('null 원소 섞임 → 건너뜀', ratios([null, undefined, yr(2025, 1100, 10, 90)])?.year, 2025);
ok('연도 소수 → 후보 아님', ratios([yr(2025.5, 1100, 10, 90)]), null);
ok('자본 문자열 → 후보 아님', ratios([yr(2025, '1100', 10, 90)]), null);
const frozenIn = [yr(2025, 1100, 10, 90), yr(2023, 900, 8, 120)];
const snapshot = JSON.stringify(frozenIn);
ratios(frozenIn);
ok('입력 배열 불변 (순서·값)', JSON.stringify(frozenIn), snapshot);

// ── 6. isFinancialCompany ───────────────────────────────────────────
console.log('\n=== 6. isFinancialCompany ===');
const fin = (o) => an.isFinancialCompany(o);
ok('64992 + 이름에 금융 (KB금융) → 금융', fin({ induty: '64992', name: 'KB금융' }), true);
ok('64992 + 하나금융지주 → 금융', fin({ induty: '64992', name: '하나금융지주' }), true);
// 신한지주는 이름에 '금융'이 없다 — 섹터로 잡는다.
ok('64992 + 신한지주(섹터 금융) → 금융', fin({ induty: '64992', name: '신한지주', sector: '금융' }), true);
ok('64992 + SK(비금융 지주) → 비금융', fin({ induty: '64992', name: 'SK', sector: '지주' }), false);
ok('64992 + LG(섹터 없음) → 비금융', fin({ induty: '64992', name: 'LG', sector: null }), false);
ok('64992 + 이름 없음 → 비금융', fin({ induty: '64992' }), false);
ok('64991 → 일반 64 규칙(금융) [확인 필요]', fin({ induty: '64991', name: '어느지주' }), true);
ok('64913 은행 → 금융', fin({ induty: '64913' }), true);
ok('65110 생명보험 → 금융', fin({ induty: '65110' }), true);
ok('65121 손해보험 → 금융', fin({ induty: '65121' }), true);
ok('66121 증권중개 → 금융', fin({ induty: '66121' }), true);
ok('숫자 induty 65110 → 금융', fin({ induty: 65110 }), true);
ok('공백 포함 " 64913 " → 금융', fin({ induty: ' 64913 ' }), true);
// induty가 있으면 그것이 우선이다 — 섹터 분류가 금융이어도 업종코드가 제조업이면 비금융.
ok('26110 제조 + 섹터 금융 → 비금융', fin({ induty: '26110', sector: '금융' }), false);
ok('induty 없음 + 섹터 금융 → 금융', fin({ induty: null, sector: '금융' }), true);
ok('induty 빈 문자열 + 섹터 금융 → 금융', fin({ induty: '  ', sector: '금융' }), true);
ok('induty 없음 + 섹터 반도체 → 비금융', fin({ induty: null, sector: '반도체' }), false);
ok('인자 없음 → 비금융', an.isFinancialCompany(), false);
ok('인자 null → 비금융(터지지 않음)', an.isFinancialCompany(null), false);

// ── 7. applyRatioFilter — 스크리너 행 판정 ──────────────────────────
console.log('\n=== 7. applyRatioFilter ===');
const rf = (row, f) => an.applyRatioFilter(row, f);
// 경계: ROE는 미만이면 제외(같으면 통과), 부채는 초과면 제외(같으면 통과) — 기존 라우트 비교 그대로.
ok('ROE = 하한 → 통과', rf({ roe: 10 }, { roeMin: 10 }), { keep: true, debtExempt: null });
ok('ROE 하한 미만 → 제외', rf({ roe: 9.99 }, { roeMin: 10 }), { keep: false, debtExempt: null });
ok('부채 = 상한 → 통과', rf({ debt: 150 }, { debtMax: 150 }), { keep: true, debtExempt: null });
ok('부채 상한 초과 → 제외', rf({ debt: 150.1 }, { debtMax: 150 }), { keep: false, debtExempt: null });
ok('ROE null + 하한 → 통과(기존 규칙)', rf({ roe: null }, { roeMin: 10 }), { keep: true, debtExempt: null });
ok('부채 null + 상한 → 통과(기존 규칙)', rf({ debt: null }, { debtMax: 150 }), { keep: true, debtExempt: null });
ok('필터 없음 → 통과', rf({ roe: -30, debt: 900 }, {}), { keep: true, debtExempt: null });
ok('인자 없음 → 통과', an.applyRatioFilter(), { keep: true, debtExempt: null });
// 금융업은 부채 상한만 면제된다.
ok('금융 부채 1200% + 상한 150 → 통과·면제', rf({ debt: 1200, financial: true }, { debtMax: 150 }), { keep: true, debtExempt: '금융업' });
ok('금융 ROE 5 + 하한 8 → 제외(ROE는 동일 잣대)', rf({ roe: 5, debt: 1200, financial: true }, { roeMin: 8, debtMax: 200 }), { keep: false, debtExempt: '금융업' });
ok('금융 필터 없음 → 면제 표시는 유지', rf({ debt: 1200, financial: true }, {}), { keep: true, debtExempt: '금융업' });
// 자본잠식: 비율 필터를 하나라도 걸면 제외, 아무 필터도 없으면 노출.
ok('잠식 + ROE 하한 → 제외', rf({ impaired: true }, { roeMin: 10 }), { keep: false, debtExempt: null });
ok('잠식 + 부채 상한 → 제외', rf({ impaired: true }, { debtMax: 150 }), { keep: false, debtExempt: null });
ok('잠식 + 필터 없음 → 노출', rf({ impaired: true }, {}), { keep: true, debtExempt: null });
// 잠식이 금융 면제보다 먼저다 — 자본이 음수면 면제할 부채비율조차 없다.
ok('잠식 + 금융 + 부채 상한 → 제외(잠식 우선)', rf({ impaired: true, financial: true }, { debtMax: 200 }), { keep: false, debtExempt: null });

// ── 8. calcQualityScreen — 등급 경계 전수 대조 ──────────────────────
console.log('\n=== 8. calcQualityScreen: 등급 경계 ===');
// 항목별 통과·탈락 값. 순서는 checks 순서와 같다.
const PASS = { op: 10, rev: 5, per: 10, debt: 50,  roe: 15, fs: 7, ps: 60 };
const FAIL = { op: 1,  rev: -5, per: 30, debt: 300, roe: 5,  fs: 2, ps: 10 };
const KEYS = ['op', 'rev', 'per', 'debt', 'roe', 'fs', 'ps'];
const screen = (v, ctx) => an.calcQualityScreen(
  { opMargin: v.op, revenueGrowth: v.rev },
  { per: v.per, debtToEquity: v.debt, roe: v.roe },
  v.ps ?? null, v.fs != null ? { score: v.fs } : null, ctx);
// 앞 p개 통과, 그다음 n-p개 탈락, 나머지 미측정(null).
const combo = (p, n) => Object.fromEntries(KEYS.map((k, i) => [k, i < p ? PASS[k] : i < n ? FAIL[k] : undefined]));
const ALL = combo(7, 7);
// 수정 전 경계(비율 소수 비교). 정수 경계로 바꾸면서 결과가 바뀌는 칸을 전수로 찾는다.
const oldGrade = (p, n) => { const r = p / n; return r >= 0.86 ? 'A' : r >= 0.71 ? 'B' : r >= 0.57 ? 'C' : 'F'; };
const changed = [];
let combosChecked = 0, countMismatch = 0;
for (let n = 1; n <= 7; n++) for (let p = 0; p <= n; p++) {
  const out = screen(combo(p, n));
  combosChecked++;
  if (out.passCount !== p || out.definedCount !== n) countMismatch++;
  if (out.grade !== oldGrade(p, n)) changed.push([p, n, oldGrade(p, n), out.grade]);
}
ok('전제: 조합 35개가 의도한 통과/측정 수', [combosChecked, countMismatch], [35, 0]);
ok('바뀌는 칸은 7중6(B→A) 하나뿐', changed, [[6, 7, 'B', 'A']]);
ok('7중7 → A/PASS', [screen(ALL).grade, screen(ALL).verdict], ['A', 'PASS']);
ok('7중6 → A', screen({ ...ALL, roe: FAIL.roe }).grade, 'A');
ok('7중5 → B', screen({ ...ALL, roe: FAIL.roe, per: FAIL.per }).grade, 'B');
ok('7중4 → C/WATCH', [screen(combo(4, 7)).grade, screen(combo(4, 7)).verdict], ['C', 'WATCH']);
ok('7중3 → F/FAIL', [screen(combo(3, 7)).grade, screen(combo(3, 7)).verdict], ['F', 'FAIL']);
ok('측정 0 → N/A/UNKNOWN', [screen({}).grade, screen({}).verdict, screen({}).definedCount], ['N/A', 'UNKNOWN', 0]);
ok('응답 필드: total 7 + definedCount', [screen(ALL).total, screen(ALL).definedCount], [7, 7]);

// ── 9. calcQualityScreen — 금융업 면제 ──────────────────────────────
console.log('\n=== 9. calcQualityScreen: 금융업 면제 ===');
const finAll = screen(ALL, { financial: true });
const debtOf = (out) => out.checks.find(c => c.key === 'debt');
const roeOf  = (out) => out.checks.find(c => c.key === 'roe');
ok('금융 부채 항목 → pass null, 금융업 면제', [debtOf(finAll).pass, debtOf(finAll).value], [null, '금융업 면제']);
ok('금융 분모에서 제외 → 6/6, A', [finAll.passCount, finAll.definedCount, finAll.total, finAll.grade], [6, 6, 7, 'A']);
// 의도된 비대칭: 금융 6중5는 B, 비금융 7중6은 A. 등급은 측정한 항목만으로 매긴다.
const finOneFail = screen({ ...ALL, roe: FAIL.roe }, { financial: true });
ok('금융 6중5 → B (비금융 7중6은 A)', [finOneFail.passCount, finOneFail.definedCount, finOneFail.grade], [5, 6, 'B']);
ok('금융이면 펀더멘털 부채 300%도 면제', debtOf(screen({ ...ALL, debt: FAIL.debt }, { financial: true })).pass, null);

// ── 10. calcQualityScreen — 자본잠식 ────────────────────────────────
console.log('\n=== 10. calcQualityScreen: 자본잠식 ===');
const IMP = { year: 2025, roe: null, debtRatio: null, impaired: true };
const imp = screen({ ...ALL, roe: undefined, debt: undefined }, { ratios: IMP });
ok('잠식 → 부채·ROE 탈락, 값 자본잠식',
  [debtOf(imp).pass, debtOf(imp).value, roeOf(imp).pass, roeOf(imp).value], [false, '자본잠식', false, '자본잠식']);
// 나머지 5개가 다 통과해도 5/7 = B가 아니라 F다.
ok('잠식 → F/FAIL 강제 (5/7이어도)', [imp.passCount, imp.definedCount, imp.grade, imp.verdict], [5, 7, 'F', 'FAIL']);
const impFin = screen({ ...ALL, roe: undefined, debt: undefined }, { ratios: IMP, financial: true });
ok('잠식 + 금융 → 잠식 우선', [debtOf(impFin).pass, debtOf(impFin).value, impFin.grade], [false, '자본잠식', 'F']);

// ── 11. calcQualityScreen — 폴백 값 표기 ────────────────────────────
console.log('\n=== 11. calcQualityScreen: 폴백 표기 ===');
const R = { year: 2025, roe: 12.34, debtRatio: 85.2, impaired: false };
const fb = screen({ ...ALL, roe: undefined, debt: undefined }, { ratios: R });
ok('폴백 ROE → 연도·기말자본 표기', [roeOf(fb).pass, roeOf(fb).value], [true, '12.3% (2025, 기말자본)']);
ok('폴백 부채 → 연도 표기', [debtOf(fb).pass, debtOf(fb).value], [true, '85% (2025)']);
ok('폴백 반영 시 7/7 → A', [fb.passCount, fb.definedCount, fb.grade], [7, 7, 'A']);
// 펀더멘털 값이 있으면 기존 표기 그대로 — 폴백 연도를 붙이지 않는다.
const fundFirst = screen(ALL, { ratios: { year: 2024, roe: 1, debtRatio: 999, impaired: false } });
ok('펀더멘털 우선 → 기존 표기', [roeOf(fundFirst).value, debtOf(fundFirst).value], ['15.0%', '50%']);
ok('펀더멘털·폴백 둘 다 없음 → N/A',
  [roeOf(screen({ ...ALL, roe: undefined, debt: undefined })).value, debtOf(screen({ ...ALL, roe: undefined, debt: undefined })).pass],
  ['N/A', null]);
ok('폴백 비율 null(래그 초과 등) → N/A', roeOf(screen({ ...ALL, roe: undefined }, { ratios: null })).value, 'N/A');
ok('ctx null → 예외 없이 기존 동작', screen(ALL, null).grade, 'A');

// ── 12. josaIGa — 미계측 안내 조사 ──────────────────────────────────
console.log('\n=== 12. josaIGa ===');
ok('부채비율 → 이', an.josaIGa('부채비율'), '이');
ok('ROE → 가 (약어)', an.josaIGa('ROE'), '가');
ok('박세익 스코어 → 가', an.josaIGa('박세익 스코어'), '가');
ok('RS 백분위 → 가', an.josaIGa('RS 백분위'), '가');
ok('자본 → 이', an.josaIGa('자본'), '이');
ok('빈 문자열 → 가', an.josaIGa(''), '가');
ok('undefined → 가', an.josaIGa(undefined), '가');

// ── 13. buildGrowthProfile — ratios 연결 ────────────────────────────
console.log('\n=== 13. buildGrowthProfile: ratios ===');
const full = (year, revenue, operatingProfit, netIncome, equity, roe, debtRatio) =>
  ({ year, revenue, operatingProfit, netIncome, equity, roe, debtRatio });
const rows5 = [
  full(2021, 100, 10, 8, 500, 1.6, 120), full(2022, 120, 12, 9, 520, 1.73, 115),
  full(2023, 140, 15, 11, 540, 2.04, 110), full(2024, 160, 18, 13, 560, 2.32, 105), ph(2025),
];
const gp = cron.buildGrowthProfile(rows5, null, 2026);
ok('ratios 포함 (자리표시 2025 건너뜀)', gp?.ratios, { year: 2024, roe: 2.32, debtRatio: 105, impaired: false });
ok('기존 필드 유지', [gp?.revenueStreak, gp?.opStreak, gp?.noLossOp3y], [3, 3, true]);
const gpOld = cron.buildGrowthProfile(rows5, null, 2028);
ok('래그 초과 → ratios null, 프로필은 유지', [gpOld?.ratios, gpOld?.revenueStreak], [null, 3]);
// 자본총계 필드가 없던 옛 캐시 형태 — 프로필은 나오고 ratios만 null.
const legacy = cron.buildGrowthProfile(
  [{ year: 2023, revenue: 140, operatingProfit: 15, netIncome: 11 }, { year: 2024, revenue: 160, operatingProfit: 18, netIncome: 13 }], null, 2026);
ok('equity 없는 옛 캐시 → ratios null', [legacy !== null, legacy?.ratios], [true, null]);
ok('자리표시만 → 프로필 null (기존 조건 유지)', cron.buildGrowthProfile([ph(2024), ph(2025)], null, 2026), null);
ok('refYear 생략 → 호출 가능(기본 KST 연도)', 'ratios' in (cron.buildGrowthProfile(rows5, null) || {}), true);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
