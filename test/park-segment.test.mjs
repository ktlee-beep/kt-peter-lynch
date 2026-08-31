// 박세익 스코어 · 2축 매트릭스 구간 검증 (Phase 3).
// 전부 순수 함수라 네트워크·자격증명 없이 돈다: `node test/park-segment.test.mjs`
// cron.js는 import 시 db.js를 끌어오므로 유니버스 테스트와 같은 방식으로 가짜 환경을 먼저 깐다.
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

// buildGrowthProfile이 내놓는 형태 그대로. 기본값은 "3년 연속 성장 + 무적자" 통과 케이스다.
const g = (o = {}) => ({
  revenueStreak: 3, revenueComparable: 3,
  opStreak: 3, opComparable: 3,
  noLossOp3y: true, ...o,
});
const score = (growth, price = {}, fund = {}, opts = {}) => an.calcParkScore(growth, price, fund, opts).score;

// ── 1. 게이트 — 점수가 아니라 탈락 ────────────────────────────────
console.log('=== 1. calcParkScore 게이트 ===');
const gNull = an.calcParkScore(null);
ok('성장 프로필 없음 → null/NO_DATA', [gNull.score, gNull.gated], [null, 'NO_DATA']);

const gLoss = an.calcParkScore(g({ noLossOp3y: false }));
ok('3년 내 적자 → 0점/LOSS_3Y', [gLoss.score, gLoss.gated], [0, 'LOSS_3Y']);
// 하드 컷의 요점은 "다른 항목 만점으로도 못 올라온다"는 것이다. 합산 방식이면 여기서 90점이 나온다.
ok('적자는 만점 조건으로도 상쇄 불가',
  score(g({ noLossOp3y: false }), { pctFrom52wHigh: -50 }, { per: 5 }, { perMedian: 15 }), 0);

// hasNoLoss는 판정 불가일 때 null을 준다. null을 false로 뭉개면 "적자 기업"으로 오분류된다.
const gUnk = an.calcParkScore(g({ noLossOp3y: null }));
ok('무적자 판정 불가 → null/NO_DATA', [gUnk.score, gUnk.gated], [null, 'NO_DATA']);

// 3년 연속을 확인하려면 전년 대비 비교가 3회 성립해야 한다(연간 4개년).
const gShortR = an.calcParkScore(g({ revenueComparable: 2 }));
ok('매출 비교 2회 → SHORT_HISTORY', [gShortR.score, gShortR.gated], [null, 'SHORT_HISTORY']);
const gShortO = an.calcParkScore(g({ opComparable: 2 }));
ok('영업이익 비교 2회 → SHORT_HISTORY', [gShortO.score, gShortO.gated], [null, 'SHORT_HISTORY']);
ok('비교 3회는 통과', an.calcParkScore(g()).gated, null);
// NO_DATA(백필 누락 신호)와 SHORT_HISTORY(종목 특성)를 나눠 세야 감시가 가능하다.
ok('두 사유는 다른 코드', gUnk.gated === gShortR.gated, false);
// 적자 확정은 데이터 부족보다 먼저 판정된다 — 확인된 배제 사유가 미확인 사유에 가려지면 안 된다.
const gBoth = an.calcParkScore(g({ noLossOp3y: false, revenueComparable: 0, opComparable: 0 }));
ok('적자 판정이 이력 부족보다 우선', [gBoth.score, gBoth.gated], [0, 'LOSS_3Y']);

// ── 2. 배점 — 성장 스트릭 ─────────────────────────────────────────
console.log('\n=== 2. 성장 스트릭 배점 ===');
ok('매출3+영업3+무적자 = 70', score(g()), 70);
ok('매출 스트릭 2 → 45',      score(g({ revenueStreak: 2 })), 45);
ok('영업이익 스트릭 2 → 45',  score(g({ opStreak: 2 })), 45);
ok('둘 다 2 → 20(무적자만)',  score(g({ revenueStreak: 2, opStreak: 2 })), 20);
ok('스트릭 4년도 3년과 동일 배점', score(g({ revenueStreak: 4, opStreak: 4 })), 70);

// ── 3. 배점 — 고점 대비 낙폭 ──────────────────────────────────────
console.log('\n=== 3. 낙폭 배점 ===');
const drop = (pctFrom52wHigh, extra = {}) => score(g(), { pctFrom52wHigh, ...extra });
// 임계값 경계에서 한 칸 어긋나면 후보 목록이 통째로 달라진다.
ok('-30.0% 경계 → +20',  drop(-30), 90);
ok('-30.1% → +20',       drop(-30.1), 90);
ok('-29.9% → +12',       drop(-29.9), 82);
ok('-20.0% 경계 → +12',  drop(-20), 82);
ok('-19.9% → 가점 없음', drop(-19.9), 70);
ok('보합 → 가점 없음',   drop(0), 70);
ok('상승 → 가점 없음',   drop(12.5), 70);
// 상장 1년 미만은 짧은 구간의 고가가 52주 고가가 되어 낙폭이 왜곡된다 — 아예 반영하지 않는다.
ok('w52Partial → 낙폭 미반영', drop(-50, { w52Partial: true }), 70);
ok('낙폭 null → 가점 없음',    drop(null), 70);
ok('낙폭 NaN → 가점 없음',     drop(NaN), 70);
const rPartial = an.calcParkScore(g(), { pctFrom52wHigh: -50, w52Partial: true }).reasons;
ok('w52Partial 사유 기록', rPartial.some(s => s.includes('52주 데이터 부족')), true);

// ── 4. 배점 — PER 저평가 ──────────────────────────────────────────
console.log('\n=== 4. PER 저평가 배점 ===');
const per = (p, perMedian) => score(g(), {}, { per: p }, { perMedian });
ok('PER 11 < 중앙값 12 → +10', per(11, 12), 80);
ok('PER == 중앙값 → 가점 없음', per(12, 12), 70);   // 미만(<)이지 이하가 아니다
ok('PER 13 > 중앙값 → 가점 없음', per(13, 12), 70);
ok('PER 없음 → 가점 없음',      per(null, 12), 70);
ok('PER 음수(적자) → 가점 없음', per(-5, 12), 70);
// 기준이 없으면 전 종목이 똑같이 못 받는다 — 상대 순위가 보존되므로 안전한 방향의 실패다.
ok('중앙값 없음 → 가점 없음',   per(11, null), 70);
ok('중앙값 0 → 가점 없음',      per(11, 0), 70);
const rNoMed = an.calcParkScore(g(), {}, { per: 11 }, { perMedian: null }).reasons;
ok('중앙값 없음 사유 기록', rNoMed.some(s => s.includes('PER 중앙값 없음')), true);

// ── 5. 합계·등급 ──────────────────────────────────────────────────
console.log('\n=== 5. 합계와 등급 ===');
const full = an.calcParkScore(g(), { pctFrom52wHigh: -40 }, { per: 8 }, { perMedian: 15 });
ok('전 항목 충족 = 100', full.score, 100);
ok('100점 등급 A', full.grade, 'A (선점 유력)');
ok('100점은 게이트 통과 상태', full.gated, null);
ok('70점 등급 B', an.calcParkScore(g()).grade, 'B (후보)');
ok('45점 등급 C', an.calcParkScore(g({ revenueStreak: 2 })).grade, 'C (관망)');
ok('20점 등급 D', an.calcParkScore(g({ revenueStreak: 2, opStreak: 2 })).grade, 'D (제외)');
ok('LOSS_3Y 등급 D', gLoss.grade, 'D (제외)');
ok('사유 목록 비어있지 않음', full.reasons.length > 0, true);

// ── 6. matrixZone ─────────────────────────────────────────────────
console.log('\n=== 6. matrixZone ===');
const z = an.matrixZone;
ok('실적 좋고 소외 → SEONJEOM',  z(70, 40), 'SEONJEOM');
ok('리버모어 44.9 → SEONJEOM',   z(60, 44.9), 'SEONJEOM');
ok('리버모어 45 경계 → NEUTRAL', z(60, 45), 'NEUTRAL');
ok('박세익 59.9 → NEUTRAL',      z(59.9, 40), 'NEUTRAL');
ok('실적·주가 동반 → BREAKOUT',  z(70, 60), 'BREAKOUT');
ok('리버모어 59.9 → NEUTRAL',    z(70, 59.9), 'NEUTRAL');
ok('실적 없이 급등 → STORY_WARN', z(0, 60), 'STORY_WARN');
ok('박세익 39.9 → STORY_WARN',   z(39.9, 60), 'STORY_WARN');
ok('박세익 40 경계 → NEUTRAL',   z(40, 60), 'NEUTRAL');
ok('중간 구간 → NEUTRAL',        z(50, 50), 'NEUTRAL');
// 점수 없음을 0으로 뭉개면 백필 미완 종목이 전부 STORY_WARN으로 몰려 경고가 신뢰를 잃는다.
ok('박세익 null → NO_DATA',      z(null, 70), 'NO_DATA');
ok('리버모어 null → NO_DATA',    z(70, null), 'NO_DATA');
ok('undefined → NO_DATA',        z(undefined, undefined), 'NO_DATA');
ok('NaN → NO_DATA',              z(NaN, 70), 'NO_DATA');
// 적자 게이트(0점) + 기술적 강세 = 정확히 박세익이 경고한 조합이다.
ok('적자 게이트 종목이 급등 → STORY_WARN', z(gLoss.score, 75, gLoss.gated), 'STORY_WARN');
// 급등하지 않은 적자 종목은 NEUTRAL이 아니라 EXCLUDED다. "확인해서 나쁜 것"과
// "확인해서 평범한 것"을 같은 칸에 두면 게이트를 통과한 종목의 NEUTRAL이 의미를 잃는다.
ok('적자 게이트 + 리버모어 20 → EXCLUDED', z(0, 20, 'LOSS_3Y'), 'EXCLUDED');
ok('적자 게이트 + 리버모어 59.9 → EXCLUDED', z(0, 59.9, 'LOSS_3Y'), 'EXCLUDED');
ok('적자 게이트 + 리버모어 60 경계 → STORY_WARN', z(0, 60, 'LOSS_3Y'), 'STORY_WARN');
ok('적자 게이트는 리버모어 없어도 판정', z(0, null, 'LOSS_3Y'), 'EXCLUDED');
// NO_DATA/SHORT_HISTORY는 "나쁘다"가 아니라 "모른다" — 제외 칸에 넣으면 안 된다.
ok('NO_DATA 게이트는 EXCLUDED 아님',      z(null, 30, 'NO_DATA'), 'NO_DATA');
ok('SHORT_HISTORY 게이트는 EXCLUDED 아님', z(null, 30, 'SHORT_HISTORY'), 'NO_DATA');
ok('게이트 인자 생략 시 기존 동작 유지', z(70, 40), 'SEONJEOM');

// ── 7. median ─────────────────────────────────────────────────────
console.log('\n=== 7. median ===');
ok('홀수 개',        an.median([3, 1, 2]), 2);
ok('짝수 개 = 평균', an.median([1, 2, 3, 4]), 2.5);
ok('빈 배열 → null', an.median([]), null);
ok('배열 아님 → null', an.median(null), null);
ok('NaN 제외',       an.median([1, NaN, 3]), 2);
ok('문자열 제외',    an.median(['a', 2, 4]), 3);
ok('Infinity 제외',  an.median([1, Infinity, 3]), 2);
// 숫자 정렬을 안 하면 [10, 9, 8]의 중앙값이 사전순으로 뒤집힌다.
ok('사전순 아닌 숫자 정렬', an.median([10, 9, 8]), 9);
const src = [5, 1, 3];
an.median(src);
ok('입력 배열 미변형', src, [5, 1, 3]);

// ── 8. pickPerMedian — 저장값 사용 가부 ───────────────────────────
console.log('\n=== 8. pickPerMedian ===');
const NOW = Date.parse('2026-08-28T12:00:00Z');
const meta = (o = {}) => ({ median: 12.5, n: 900, at: '2026-08-27T11:00:00Z', ...o });
ok('정상 → 값 반환',   cron.pickPerMedian(meta(), NOW), 12.5);
ok('null → null',      cron.pickPerMedian(null, NOW), null);
ok('표본 99 → null',   cron.pickPerMedian(meta({ n: 99 }), NOW), null);
ok('표본 100 경계 통과', cron.pickPerMedian(meta({ n: 100 }), NOW), 12.5);
ok('중앙값 0 → null',  cron.pickPerMedian(meta({ median: 0 }), NOW), null);
ok('중앙값 없음 → null', cron.pickPerMedian(meta({ median: undefined }), NOW), null);
ok('표본 수 없음 → null', cron.pickPerMedian(meta({ n: undefined }), NOW), null);
ok('타임스탬프 없음 → null', cron.pickPerMedian(meta({ at: undefined }), NOW), null);
ok('타임스탬프 형식 오류 → null', cron.pickPerMedian(meta({ at: '어제' }), NOW), null);
// 다른 국면의 중앙값으로 오늘을 채점하면 저평가 판정이 통째로 어긋난다.
ok('13일 전 → 사용',   cron.pickPerMedian(meta({ at: '2026-08-15T12:00:00Z' }), NOW), 12.5);
ok('15일 전 → null',   cron.pickPerMedian(meta({ at: '2026-08-13T11:00:00Z' }), NOW), null);

// ── 9. buildGrowthProfile → calcParkScore 연결 ────────────────────
console.log('\n=== 9. 실제 DART 형태로 연결 ===');
const yr = (year, revenue, operatingProfit, netIncome) => ({ year, revenue, operatingProfit, netIncome });
// 매출·영업이익 3년 연속 증가 + 무적자. 연간 4개년이라 비교가 정확히 3회 성립한다.
const grown = cron.buildGrowthProfile(
  [yr(2021, 100, 10, 8), yr(2022, 120, 12, 9), yr(2023, 140, 15, 11), yr(2024, 160, 18, 13)], null);
ok('스트릭 산출', [grown.revenueStreak, grown.opStreak, grown.noLossOp3y], [3, 3, true]);
ok('연결 기본 점수 70', score(grown), 70);
ok('연결 만점 100', score(grown, { pctFrom52wHigh: -35 }, { per: 10 }, { perMedian: 15 }), 100);
ok('연결 존 = SEONJEOM', an.matrixZone(score(grown, { pctFrom52wHigh: -35 }), 30), 'SEONJEOM');

// 최근 연도 영업적자 — 다른 조건이 아무리 좋아도 하드 컷.
const lossy = cron.buildGrowthProfile(
  [yr(2021, 100, 10, 8), yr(2022, 120, 12, 9), yr(2023, 140, 15, 11), yr(2024, 160, -5, -7)], null);
const lossyOut = an.calcParkScore(lossy, { pctFrom52wHigh: -45 }, { per: 5 }, { perMedian: 20 });
ok('적자 연도 → 0점/LOSS_3Y', [lossyOut.score, lossyOut.gated], [0, 'LOSS_3Y']);

// 연간 3개년 — 두 게이트의 실제 경계다. 무적자 3년은 확인되지만(직전 3개 값이 다 있음)
// 전년 대비 비교는 2회뿐이라 "3년 연속 증가"는 확인할 수 없다. 0점이 아니라 판정 보류.
const shorty = cron.buildGrowthProfile(
  [yr(2022, 120, 12, 9), yr(2023, 140, 15, 11), yr(2024, 160, 18, 13)], null);
ok('3개년: 무적자는 확인, 비교는 2회', [shorty.noLossOp3y, shorty.revenueComparable], [true, 2]);
const shortyOut = an.calcParkScore(shorty, { pctFrom52wHigh: -45 });
ok('3개년 → SHORT_HISTORY', [shortyOut.score, shortyOut.gated], [null, 'SHORT_HISTORY']);

// 2개년이면 무적자 3년조차 판정할 수 없다 — SHORT_HISTORY가 아니라 NO_DATA가 맞다.
const tiny = cron.buildGrowthProfile([yr(2023, 140, 15, 11), yr(2024, 160, 18, 13)], null);
ok('2개년 → NO_DATA', an.calcParkScore(tiny).gated, 'NO_DATA');

// 백필 미완(자리표시 객체만) — buildGrowthProfile이 null을 주고 NO_DATA로 이어져야 한다.
const emptyProfile = cron.buildGrowthProfile([{ year: 2023 }, { year: 2024 }], null);
ok('빈 연도만 → 프로필 null', emptyProfile, null);
ok('프로필 null → NO_DATA', an.calcParkScore(emptyProfile).gated, 'NO_DATA');

// ── 10. 억원 반올림 0 처리 (hasNoLoss) ────────────────────────────
// DART 값은 toEok = Math.round(v/1e8)로 억원 단위가 되어, ±5천만원 영업이익이 전부 0이 된다.
// 0을 적자로 읽으면 "부호를 모르는 것"이 "적자 확정"으로 둔갑해 하드 컷에 걸린다.
console.log('\n=== 10. 억원 반올림 0 ===');
ok('전부 양수 → true',        an.hasNoLoss([5, 10, 12, 15], 3), true);
ok('음수 포함 → false',       an.hasNoLoss([5, 10, -3, 15], 3), false);
ok('0 포함 → null(판정 보류)', an.hasNoLoss([5, 0, 12, 15], 3), null);
ok('전부 0 → null',           an.hasNoLoss([0, 0, 0, 0], 3), null);
// 음수와 0이 함께 있으면 음수가 이긴다 — 확인된 적자는 판정 보류보다 우선한다.
ok('음수+0 → false',          an.hasNoLoss([0, -3, 0, 5], 3), false);
ok('길이 부족 → null',        an.hasNoLoss([5, 10], 3), null);

const zeroOp = cron.buildGrowthProfile(
  [yr(2021, 100, 0, 8), yr(2022, 120, 0, 9), yr(2023, 140, 0, 11), yr(2024, 160, 0, 13)], null);
ok('영업이익 전부 0 → LOSS_3Y 아님', an.calcParkScore(zeroOp).gated, 'NO_DATA');
ok('영업이익 전부 0 → 0점 아님',     an.calcParkScore(zeroOp).score, null);

// ── 11. 입력 타입 강제 (숫자문자열) ───────────────────────────────
// 세 입력(스트릭·낙폭·PER)에 같은 정책을 적용한다. 필드마다 규칙이 다르면 그 자체가 결함이다.
console.log('\n=== 11. 입력 타입 강제 ===');
ok('스트릭 문자열 → 배점 반영', score(g({ revenueStreak: '3', opStreak: '3' })), 70);
ok('낙폭 문자열 → 배점 반영',   score(g(), { pctFrom52wHigh: '-40' }), 90);
ok('PER·중앙값 문자열 → 배점 반영', score(g(), {}, { per: '8' }, { perMedian: '15' }), 80);
// 빈 문자열·배열은 Number()가 0으로 만든다 — "데이터 없음"이 "낙폭 0%"·"PER 0"이 되면 안 된다.
ok('낙폭 빈 문자열 → 가점 없음', score(g(), { pctFrom52wHigh: '' }), 70);
ok('낙폭 배열 → 가점 없음',      score(g(), { pctFrom52wHigh: [] }), 70);
ok('PER 빈 문자열 → 가점 없음',  score(g(), {}, { per: '' }, { perMedian: 15 }), 70);
ok('중앙값 빈 문자열 → 가점 없음', score(g(), {}, { per: 8 }, { perMedian: '' }), 70);
ok('낙폭 숫자 아닌 문자열 → 가점 없음', score(g(), { pctFrom52wHigh: '많이빠짐' }), 70);
const rBadType = an.calcParkScore(g(), { pctFrom52wHigh: '많이빠짐' }).reasons;
ok('타입 불량도 산출 불가로 기록', rBadType.some(s => s.includes('산출 불가')), true);
// matrixZone은 문자열에 fail-closed다 — 여기서 관대해지면 필터 임계값이 무의미해진다.
ok('matrixZone 문자열 점수 → NO_DATA', z('70', 40), 'NO_DATA');

// ── 12. 저평가 비교 기준 선택 (섹터 우선) ─────────────────────────
// 절대 PER로는 저평가를 판정할 수 없다 — 반도체 15와 유틸리티 15는 의미가 정반대다.
// 여기가 무너지면 저PER 업종 전체가 저평가로, 고PER 업종 전체가 고평가로 쏠린다.
console.log('\n=== 12. resolvePerMedian ===');
const meds = (o = {}) => ({ universe: 12.5, n: 900, sectors: { 반도체: { median: 18, n: 30 } }, ...o });
const rp = (m, s) => { const r = cron.resolvePerMedian(m, s); return [r.median, r.basis]; };

ok('섹터 표본 충분 → 섹터 기준', rp(meds(), '반도체'), [18, '반도체 중앙값']);
ok('섹터 미지정 → 유니버스',      rp(meds(), null), [12.5, '유니버스 중앙값']);
ok('모르는 섹터 → 유니버스',      rp(meds(), '없는섹터'), [12.5, '유니버스 중앙값']);
ok('표본 5 경계 → 섹터 사용',     rp(meds({ sectors: { 반도체: { median: 18, n: 5 } } }), '반도체'), [18, '반도체 중앙값']);
// 실측 회귀(2026-08-30): 83종목 유니버스에서 2차전지 표본 4건에 중앙값 139.6이 나왔다.
// 이런 값을 기준으로 삼으면 같은 섹터 전 종목이 무조건 저평가 가점을 받는다.
ok('표본 4 → 유니버스로 폴백',    rp(meds({ sectors: { 이차전지: { median: 139.6, n: 4 } } }), '이차전지'), [12.5, '유니버스 중앙값']);
ok('섹터 중앙값 0 → 유니버스',    rp(meds({ sectors: { 반도체: { median: 0, n: 30 } } }), '반도체'), [12.5, '유니버스 중앙값']);
ok('섹터만 있고 유니버스 없음',   rp(meds({ universe: null }), '반도체'), [18, '반도체 중앙값']);
ok('둘 다 없음 → 미적용',         rp(meds({ universe: null, sectors: {} }), '반도체'), [null, null]);
ok('meds null → 미적용',          rp(null, '반도체'), [null, null]);

console.log('\n=== 12-1. pickPerMedians ===');
const stored = (o = {}) => ({ median: 12.5, n: 900, at: '2026-08-27T11:00:00Z',
  sectors: { 반도체: { median: 18, n: 30 } }, ...o });
// 핵심 설계: 폴백(대형주 하드코딩) 스캔 산출물은 유니버스 기준만 죽이고 섹터는 살린다.
// 대형주를 같은 섹터 대형주와 비교하는 것은 편향이 상쇄되지만, 시장 전체 중앙값은 아니다.
const pm = cron.pickPerMedians(stored({ fallback: true }), NOW);
ok('폴백 스캔 → 유니버스만 무효', [pm.universe, pm.sectors.반도체?.median], [null, 18]);
ok('폴백 스캔에서도 섹터 기준 채택', cron.resolvePerMedian(pm, '반도체').basis, '반도체 중앙값');
ok('폴백 + 섹터 미지정 → 미적용',   cron.resolvePerMedian(pm, null).median, null);
const pmOld = cron.pickPerMedians(stored({ at: '2026-08-13T11:00:00Z' }), NOW);
ok('15일 경과 → 섹터까지 전부 무효', [pmOld.universe, Object.keys(pmOld.sectors)], [null, []]);
ok('정상 저장값 → 둘 다 유효', (() => {
  const p = cron.pickPerMedians(stored(), NOW);
  return [p.universe, p.sectors.반도체?.n];
})(), [12.5, 30]);
ok('불량 섹터 항목 제외', Object.keys(cron.pickPerMedians(
  stored({ sectors: { 반도체: { median: 18, n: 30 }, 잡음: { median: 0, n: 9 }, 무표본: { median: 5 } } }), NOW).sectors), ['반도체']);
ok('저장값 null → 빈 기준', (() => {
  const p = cron.pickPerMedians(null, NOW);
  return [p.universe, p.sectors];
})(), [null, {}]);
// 폴백 표시는 pickPerMedian 단독 호출에서도 걸러야 한다 — 나머지 조건이 다 정상이어도.
ok('pickPerMedian 폴백 표시 → null', cron.pickPerMedian(meta({ fallback: true }), NOW), null);
ok('pickPerMedian fallback:false → 정상', cron.pickPerMedian(meta({ fallback: false }), NOW), 12.5);

console.log('\n=== 12-2. 사유 문자열에 기준 표기 ===');
// 같은 80점이라도 무엇과 비교해 저평가였는지가 사유에 남지 않으면 점수를 읽을 수 없다.
const rSec = an.calcParkScore(g(), {}, { per: 8 }, { perMedian: 15, perBasis: '반도체 중앙값' }).reasons;
ok('섹터 기준이 사유에 표기', rSec.some(s => s.includes('PER 8.0 < 반도체 중앙값 15.0')), true);
ok('기준 표기해도 배점 동일', score(g(), {}, { per: 8 }, { perMedian: 15, perBasis: '반도체 중앙값' }), 80);
const rDef = an.calcParkScore(g(), {}, { per: 8 }, { perMedian: 15 }).reasons;
ok('basis 없으면 중앙값으로 표기', rDef.some(s => s.includes('PER 8.0 < 중앙값 15.0')), true);
const rBlank = an.calcParkScore(g(), {}, { per: 8 }, { perMedian: 15, perBasis: '  ' }).reasons;
ok('공백 basis → 기본 표기로 대체', rBlank.some(s => s.includes('< 중앙값 15.0')), true);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
