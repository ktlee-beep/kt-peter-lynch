// detectFreshSignals · calcCandlePatterns의 null/0 가드 회귀 검증.
// analysis.js는 순수 함수 모듈이라 가짜 환경 없이 그대로 import된다: `node test/analysis-guards.test.mjs`
//
// 배경: 이 프로젝트의 null 보존 원칙("데이터 없음을 0이나 false로 뭉개지 않는다")은
// JS의 `숫자 > null`이 null을 0으로 강제변환하면서 언어 차원에서 뚫렸다. 이평이 아직
// 형성되지 않은 종목이 근거 없이 freshnessScore를 받아 스크리너 상위로 올라오던 실제
// 오적재 경로다.
//
// 주의: 아래 데이터는 전부 "수정 전 코드에서 실제로 오발화하는" 경로로 골랐다. 단조 상승
// 같은 순한 데이터는 curAligned와 oldAligned가 똑같이 뚫려 서로 상쇄되므로 가드가 없어도
// 통과한다 — 그런 케이스는 아무것도 검증하지 못한다.
const an = await import('../analysis.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(52)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  good ? pass++ : fail++;
};
const vols = (n) => new Array(n).fill(100000);

// ── 1. detectFreshSignals — ma60 미형성(신규 상장) ────────────────────
console.log('=== 1. detectFreshSignals: ma60 미형성 ===');

// 상장 30봉 종목이 22봉 하락 후 8봉 반등. ma5 > ma20은 최근에 실제로 전환됐지만
// ma60은 전 구간 null이다. 수정 전에는 `m20(-1) > m60(-1)`이 `1209 > 0`으로 통과해
// 60일선이 존재하지도 않는데 "정배열 신규 전환"으로 +3이 붙었다.
const newbie = [
  ...Array.from({ length: 22 }, (_, i) => 1500 - i * 20),
  ...Array.from({ length: 8 }, (_, i) => 1080 + i * 45),
];
const nb5 = an.calcMA(newbie, 5), nb20 = an.calcMA(newbie, 20), nb60 = an.calcMA(newbie, 60);

ok('전제: ma60 전 구간 null', nb60.every(v => v === null), true);
ok('전제: ma5 > ma20은 실제 성립', nb5.at(-1) > nb20.at(-1), true);
ok('전제: -8 시점엔 미성립(신규 전환 형태)', nb5.at(-8) > nb20.at(-8), false);

const fNb = an.detectFreshSignals(newbie, nb5, nb20, nb60, vols(newbie.length));
ok('freshAlignment — ma60 없으면 false', fNb.freshAlignment, false);
ok('freshnessScore — 근거 없는 +3 미발생', fNb.freshnessScore, 0);

// ── 2. detectFreshSignals — 이평 배열 중간 구멍 ───────────────────────
console.log('=== 2. detectFreshSignals: 이평 중간 null 구멍 ===');

// calcMA(:207)는 윈도우에 null 종가가 섞이면 그 자리만 null로 비운다. 따라서 "과거
// 시점은 값이 있는데 현재 시점이 null"인 조합이 성립한다. 과거시점만 가드하던 기존
// 방식은 이 경우 `종가 > null`로 다시 뚫린다.
// 70봉 하락 후 급반등 — 이평 돌파가 실제로 성립하는 구간이라야 결함이 드러난다.
const rebound = [...Array.from({ length: 70 }, (_, i) => 2000 - i * 10), 1320, 1340, 1250, 1500, 1750, 2050];
const rb5 = an.calcMA(rebound, 5), rb20 = an.calcMA(rebound, 20), rb60 = an.calcMA(rebound, 60);
const last = rebound.length - 1;
const hole60 = rb60.slice(); hole60[last] = null;
const hole20 = rb20.slice(); hole20[last] = null;

const fBase = an.detectFreshSignals(rebound, rb5, rb20, rb60, vols(rebound.length));
ok('전제: 정상 배열이면 60선 돌파 검출', fBase.freshMa60Break, true);
ok('전제: 정상 배열이면 20선 돌파 검출', fBase.freshMa20Break, true);
ok('전제: 구멍은 현재시점에만(과거시점 값 유지)', hole60.at(-6) !== null && hole60.at(-1) === null, true);

const fH60 = an.detectFreshSignals(rebound, rb5, rb20, hole60, vols(rebound.length));
ok('freshMa60Break — 현재 ma60이 null이면 false', fH60.freshMa60Break, false);

const fH20 = an.detectFreshSignals(rebound, rb5, hole20, rb60, vols(rebound.length));
ok('freshMa20Break — 현재 ma20이 null이면 false', fH20.freshMa20Break, false);

// ── 3. detectFreshSignals — 정상 경로 회귀 ────────────────────────────
console.log('=== 3. detectFreshSignals: 정상 경로 (가드가 참을 죽이지 않는지) ===');

// 70봉 하락 후 20봉 급반등: 이평 3개 모두 형성되고 정배열이 실제로 신규 전환되는 구간.
const turn = [
  ...Array.from({ length: 70 }, (_, i) => 2000 - i * 10),
  ...Array.from({ length: 20 }, (_, i) => 1300 + i * 40),
];
const t5 = an.calcMA(turn, 5), t20 = an.calcMA(turn, 20), t60 = an.calcMA(turn, 60);
ok('전제: 이평 3개 모두 형성', [t5.at(-1), t20.at(-1), t60.at(-1)].every(v => v !== null), true);

const fT = an.detectFreshSignals(turn, t5, t20, t60, vols(turn.length));
ok('freshAlignment — 실제 정배열 전환은 여전히 true', fT.freshAlignment, true);
ok('freshnessScore — 정상 가점 살아있음', fT.freshnessScore > 0, true);

// ── 4. calcCandlePatterns — 점상한가 ─────────────────────────────────
console.log('=== 4. calcCandlePatterns: 점상한가(o=h=l=c) ===');

// 시가·고가·저가·종가가 전부 같으면 몸통·위꼬리·아래꼬리가 모두 0이다. `u >= b*1.8`이
// `0 >= 0`, `l <= b*0.3`이 `0 <= 0`으로 통과해 역망치(bullish)가 오발화했다. 거래가
// 사실상 없는 봉을 매수 신호로 읽던 자리다. 도지는 `r > 0`, 망치형은 5일 이평 가격
// 필터, 유성형은 `!isGrn`에 각각 막히고 역망치만 무방비였다.
const limitUp = { o: [1000, 1000, 1300], h: [1010, 1010, 1300], l: [990, 990, 1300], c: [1000, 995, 1300] };
const pLimit = an.calcCandlePatterns(limitUp.o, limitUp.h, limitUp.l, limitUp.c);
ok('전제: 직전 봉이 음봉(역망치 선행조건 충족)', limitUp.c[1] < limitUp.o[1], true);
ok('역망치 — 점상한가에서 미발생', pLimit.some(p => p.name === '역망치'), false);
ok('bullish 패턴 — 점상한가에서 없음', pLimit.some(p => p.signal === 'bullish'), false);

// ── 5. calcCandlePatterns — 진짜 역망치 회귀 ──────────────────────────
console.log('=== 5. calcCandlePatterns: 정상 역망치 (가드가 참을 죽이지 않는지) ===');

// 직전 음봉 + 작은 몸통 + 긴 위꼬리 + 짧은 아래꼬리.
const invH = { o: [1000, 1000, 1000], h: [1010, 1010, 1100], l: [990, 990, 998], c: [1000, 995, 1010] };
const pInv = an.calcCandlePatterns(invH.o, invH.h, invH.l, invH.c);
ok('역망치 — 정상 케이스는 여전히 검출', pInv.some(p => p.name === '역망치'), true);

console.log(`\n총 ${pass + fail}건 — 통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
