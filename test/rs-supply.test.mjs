// RS(상대강도) · 수급 추세 · 선점 트리거 구간 검증 (Phase 4).
// 순수 함수 + KV 접근자만 다루므로 네트워크·자격증명 없이 돈다: `node test/rs-supply.test.mjs`
import * as fake from './fake_pgrst.mjs';

fake.install();
process.env.SUPABASE_URL = fake.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

const an = await import('../analysis.js');
const db = await import('../db.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(48)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  good ? pass++ : fail++;
};
const near = (name, got, want, tol = 1e-9) => {
  const good = got != null && Math.abs(got - want) <= tol;
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(48)} got=${got} want≈${want}`);
  good ? pass++ : fail++;
};

// 거래일 시계열 생성기. 주말을 건너뛰지 않아도 되는 이유는 RS가 '날짜 간격'이 아니라
// '몇 봉 전'으로 창을 잡기 때문이다 — 지수 조회만 날짜로 맞으면 된다.
const seq = (n, startYmd = '20250101') => {
  const out = [];
  const base = Date.UTC(+startYmd.slice(0, 4), +startYmd.slice(4, 6) - 1, +startYmd.slice(6, 8));
  for (let i = 0; i < n; i++) {
    const d = new Date(base + i * 86400000);
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return out;
};
const flat = (n, v) => Array.from({ length: n }, () => v);

// ── 1. normDate / indexCloseOnOrBefore ────────────────────────────
console.log('=== 1. 날짜 정규화·지수 조회 ===');
ok('YYYY-MM-DD → YYYYMMDD', an.normDate('2025-03-04'), '20250304');
ok('YYYYMMDD 통과', an.normDate('20250304'), '20250304');
ok('형식 불량 → null', an.normDate('2025-3-4'), null);
ok('빈 값 → null', an.normDate(null), null);

const idx = [
  { d: '20250101', c: 100 }, { d: '20250102', c: 101 },
  { d: '20250106', c: 105 }, { d: '20250107', c: 110 },
];
ok('정확히 일치', an.indexCloseOnOrBefore(idx, '20250106'), 105);
ok('휴장일 → 직전 거래일', an.indexCloseOnOrBefore(idx, '20250104'), 101);
ok('시계열 이전 날짜 → null', an.indexCloseOnOrBefore(idx, '20241231'), null);
ok('마지막 이후 → 마지막 값(허용 범위)', an.indexCloseOnOrBefore(idx, '20250109'), 110);
// tolerance를 넘기면 옛날 지수와 오늘 주가를 비교하게 되므로 값을 주지 않는다.
ok('허용 범위 초과 → null', an.indexCloseOnOrBefore(idx, '20250120'), null);
ok('하이픈 입력도 동일', an.indexCloseOnOrBefore(idx, '2025-01-06'), 105);
ok('빈 시계열 → null', an.indexCloseOnOrBefore([], '20250106'), null);
ok('음수·0 종가 → null', an.indexCloseOnOrBefore([{ d: '20250106', c: 0 }], '20250106'), null);

// ── 2. calcRsRatios ───────────────────────────────────────────────
console.log('\n=== 2. RS 비율 ===');
const dates200 = seq(200);
const idx200 = dates200.map((d, i) => ({ d, c: 100 + i * 0.5 }));   // 지수 꾸준히 상승

// 종목이 지수와 완전히 같은 궤적이면 RS는 정확히 1이어야 한다.
const same = dates200.map((_, i) => 100 + i * 0.5);
const rsSame = an.calcRsRatios(same, dates200, idx200);
near('종목=지수 → rs20 = 1', rsSame.rs20, 1);
near('종목=지수 → rs60 = 1', rsSame.rs60, 1);
near('종목=지수 → rs120 = 1', rsSame.rs120, 1);
near('종목=지수 → rsScore = 1', rsSame.rsScore, 1);
ok('세 창 모두 산출 → partial=false', rsSame.partial, false);
ok('windowsUsed', rsSame.windowsUsed, [20, 60, 120]);

// 지수가 하락하는 국면에서 종목도 하락 — 원식(수익률 비)이면 분모가 음수라 대소가 뒤집힌다.
// 가격비 방식은 "덜 빠진 종목"이 반드시 1보다 커야 한다.
const idxDown = dates200.map((d, i) => ({ d, c: 100 - i * 0.2 }));   // -0.2/일
const lessDown = dates200.map((_, i) => 100 - i * 0.1);              // 절반만 하락
const moreDown = dates200.map((_, i) => 100 - i * 0.4);
const rsLess = an.calcRsRatios(lessDown, dates200, idxDown);
const rsMore = an.calcRsRatios(moreDown, dates200, idxDown);
ok('하락장 — 덜 빠진 종목 RS > 1', rsLess.rs60 > 1, true);
ok('하락장 — 더 빠진 종목 RS < 1', rsMore.rs60 < 1, true);
ok('하락장 — 대소 유지(뒤집힘 없음)', rsLess.rs60 > rsMore.rs60, true);

// 지수 횡보(수익률 ≈ 0) — 원식이면 0으로 나눠 무한대가 된다.
const idxFlatSeries = dates200.map(d => ({ d, c: 100 }));
const rsFlat = an.calcRsRatios(dates200.map((_, i) => 100 + i * 0.5), dates200, idxFlatSeries);
ok('지수 횡보에서도 유한값', Number.isFinite(rsFlat.rs60), true);
near('지수 횡보 → RS = 종목 가격비', rsFlat.rs20, (100 + 199 * 0.5) / (100 + 179 * 0.5), 1e-12);

// 이력이 짧으면 가능한 창만 쓰고, 가중치는 그 창들로 재정규화된다.
const dates40 = seq(40);
const idx40 = dates40.map((d, i) => ({ d, c: 100 + i * 0.5 }));
const rsShort = an.calcRsRatios(dates40.map((_, i) => 100 + i * 1.0), dates40, idx40);
ok('40봉 → rs20만 산출', [rsShort.rs20 !== null, rsShort.rs60, rsShort.rs120], [true, null, null]);
ok('부분 산출 → partial=true', rsShort.partial, true);
// 재정규화가 없으면 rsScore = rs20 * 0.4 로 실제보다 낮게 나온다.
near('가중치 재정규화 → rsScore = rs20', rsShort.rsScore, rsShort.rs20, 1e-12);

ok('지수 없음 → 전부 null', an.calcRsRatios(same, dates200, null).rsScore, null);
ok('길이 불일치 → 전부 null', an.calcRsRatios(same, dates200.slice(1), idx200).rsScore, null);
ok('20봉 미만 → 전부 null', an.calcRsRatios(flat(10, 100), seq(10), idx200).rsScore, null);

// ── 3. 백분위 기준점 ──────────────────────────────────────────────
console.log('\n=== 3. RS 백분위 ===');
const samples = Array.from({ length: 1000 }, (_, i) => 0.5 + i / 1000);   // 0.500 ~ 1.499
const breaks = an.buildRsBreakpoints(samples);
ok('기준점 101개', breaks.length, 101);
ok('오름차순', breaks.every((v, i) => i === 0 || v >= breaks[i - 1]), true);
near('p0 = 최소', breaks[0], 0.5, 1e-9);
near('p100 = 최대', breaks[100], 1.499, 1e-9);
near('p50 ≈ 중앙값', breaks[50], 1.0, 5e-3);

ok('최소 미만 → 0', an.rsPercentile(0.1, breaks), 0);
ok('최대 초과 → 100', an.rsPercentile(9.9, breaks), 100);
ok('중앙값 근처 → 50 부근', Math.abs(an.rsPercentile(1.0, breaks) - 50) <= 1, true);
ok('하위 → 25 부근', Math.abs(an.rsPercentile(0.75, breaks) - 25) <= 1, true);
ok('값 없음 → null', an.rsPercentile(null, breaks), null);
ok('기준점 없음 → null', an.rsPercentile(1.0, null), null);
ok('기준점 길이 불량 → null', an.rsPercentile(1.0, [1, 2, 3]), null);
ok('표본 1개 → 기준점 null', an.buildRsBreakpoints([1.0]), null);
ok('표본 없음 → null', an.buildRsBreakpoints([]), null);
// 양수만 표본에 넣는다 — RS는 가격비의 비율이라 0 이하가 나올 수 없고, 나왔다면 오염이다.
ok('음수·0 표본 제외', an.buildRsBreakpoints([-1, 0, 1, 2])?.length, 101);

// ── 4. 수급 추세 ──────────────────────────────────────────────────
console.log('\n=== 4. 수급 추세 ===');
// 최신이 앞(내림차순). 네이버 응답 순서 그대로.
const supRows = [
  { date: '20250120', foreign:  100, inst:  50, indiv: -150 },
  { date: '20250119', foreign:  120, inst:  40, indiv: -160 },
  { date: '20250118', foreign:   80, inst:  30, indiv: -110 },
  { date: '20250117', foreign:  -50, inst: -20, indiv:   70 },
  { date: '20250116', foreign:  -60, inst: -30, indiv:   90 },
];
const t1 = an.calcSupplyTrend(supRows);
ok('최신일', t1.latestDate, '20250120');
ok('외국인 3일 연속 순매수', t1.foreignStreak, 3);
ok('기관 3일 연속 순매수', t1.instStreak, 3);
ok('외국인 전환 성립', t1.foreignTurn, true);
ok('기관 전환 성립', t1.instTurn, true);
ok('5일 합', t1.foreign5, 190);

// 순서를 뒤집어도 결과가 같아야 한다 — 원천이 오름차순으로 바뀌는 사고에 대한 방어.
const t2 = an.calcSupplyTrend([...supRows].reverse());
ok('오름차순 입력도 동일 결과', [t2.latestDate, t2.foreignStreak, t2.foreignTurn], ['20250120', 3, true]);

// 계속 사기만 한 종목은 '전환'이 아니다.
const alwaysBuy = seq(10).reverse().map(d => ({ date: d, foreign: 100, inst: 100, indiv: -200 }));
const t3 = an.calcSupplyTrend(alwaysBuy);
ok('연속 순매수 10일', t3.foreignStreak, 10);
ok('직전 순매도 없음 → 전환 아님', t3.foreignTurn, false);

// 스트릭이 데이터 끝에 닿으면 직전 날을 알 수 없다 → 모르는 것을 신호로 만들지 않는다.
const edge = [
  { date: '20250120', foreign: 10, inst: 10, indiv: -20 },
  { date: '20250119', foreign: 10, inst: 10, indiv: -20 },
  { date: '20250118', foreign: 10, inst: 10, indiv: -20 },
];
ok('스트릭이 데이터 끝에 닿음 → false', an.calcSupplyTrend(edge).foreignTurn, false);

// 2일 순매수는 최소 3일 요건 미달.
const twoDay = [
  { date: '20250120', foreign: 10, inst: 10, indiv: -20 },
  { date: '20250119', foreign: 10, inst: 10, indiv: -20 },
  { date: '20250118', foreign: -5, inst: -5, indiv: 10 },
  { date: '20250117', foreign: -5, inst: -5, indiv: 10 },
];
ok('순매수 2일 → 전환 아님', an.calcSupplyTrend(twoDay).foreignTurn, false);

// 가속도는 차분이다. 20일합이 음수여도 부호가 뒤집히지 않아야 한다.
const accelRows = seq(20).reverse().map((d, i) => ({ date: d, foreign: i < 5 ? 100 : -50, inst: 0, indiv: 0 }));
const t4 = an.calcSupplyTrend(accelRows);
ok('20일합 음수', t4.foreign20 < 0, true);
ok('최근 5일 매수 → 가속도 양수', t4.accelForeign > 0, true);
near('가속도 = 5일합 - 20일합/4', t4.accelForeign, t4.foreign5 - t4.foreign20 / 4, 1e-9);

// 단위 미확인이 기본. 시가총액만 줘도 정규화하지 않는다.
ok('단위 미지정 → 정규화 없음', [t1.netBuyToCapPct, t1.unitVerified], [null, false]);
const t5 = an.calcSupplyTrend(supRows, { marketCapWon: 1e12 });
ok('시총만 있어도 정규화 없음', [t5.netBuyToCapPct, t5.unitVerified], [null, false]);
const t6 = an.calcSupplyTrend(supRows, { marketCapWon: 1e12, unit: 'won' });
ok('unit=won → 정규화', t6.unitVerified, true);
const t7 = an.calcSupplyTrend(supRows, { marketCapWon: 1e12, unit: 'shares' });
ok('shares인데 종가 없음 → 정규화 없음', t7.unitVerified, false);
const t8 = an.calcSupplyTrend(supRows, { marketCapWon: 1e12, unit: 'shares', price: 50000 });
ok('shares + 종가 → 정규화', t8.unitVerified, true);

ok('빈 배열 → null', an.calcSupplyTrend([]), null);
ok('날짜 없는 행만 → null', an.calcSupplyTrend([{ foreign: 1 }]), null);

// ── 5. 선점 트리거 ────────────────────────────────────────────────
console.log('\n=== 5. 선점 트리거 ===');
const supTurn = an.calcSupplyTrend(supRows);   // 외국인·기관 모두 전환
const base = { parkScore: 70, rsPct: 55, rsPctPrev: 25, supply: supTurn, volRatio: 2.5, changeRate: 3.0 };

const all3 = an.seonjeomTriggers(base);
ok('3개 모두 발동', all3.hits, ['RS_TURN', 'SUPPLY_TURN', 'VOLUME_SURGE']);
ok('fired', all3.fired, true);

ok('박세익 59 → 게이트 탈락', an.seonjeomTriggers({ ...base, parkScore: 59 }).fired, false);
ok('게이트 탈락은 hits 비움', an.seonjeomTriggers({ ...base, parkScore: 59 }).hits, []);
ok('박세익 없음 → 탈락', an.seonjeomTriggers({ ...base, parkScore: null }).fired, false);
ok('박세익 정확히 60 → 통과', an.seonjeomTriggers({ ...base, parkScore: 60 }).fired, true);

// 1개만으로는 발동하지 않는다 — 단일 조건은 노이즈라는 설계.
const only1 = an.seonjeomTriggers({ parkScore: 70, rsPct: 55, rsPctPrev: 25, supply: null, volRatio: 1.0, changeRate: 3.0 });
ok('RS 전환 1개만 → 미발동', [only1.hits, only1.fired], [['RS_TURN'], false]);
const only2 = an.seonjeomTriggers({ parkScore: 70, rsPct: null, rsPctPrev: null, supply: supTurn, volRatio: 2.5, changeRate: 1.0 });
ok('수급+거래량 2개 → 발동', only2.fired, true);

// RS 전환 경계
ok('31 → 55 (하위권 아님) 미인정', an.seonjeomTriggers({ ...base, rsPctPrev: 31, supply: null, volRatio: 1 }).hits, []);
ok('30 → 50 경계 포함', an.seonjeomTriggers({ ...base, rsPctPrev: 30, rsPct: 50, supply: null, volRatio: 1 }).hits, ['RS_TURN']);
ok('30 → 49 (돌파 미달)', an.seonjeomTriggers({ ...base, rsPctPrev: 30, rsPct: 49, supply: null, volRatio: 1 }).hits, []);
ok('전일 백분위 없음 → 미인정', an.seonjeomTriggers({ ...base, rsPctPrev: null, supply: null, volRatio: 1 }).hits, []);

// 거래량 급등은 상승 동반이어야 한다 — 급락 시 거래량 폭증은 정반대 신호다.
ok('거래량 2배 + 하락 → 미인정', an.seonjeomTriggers({ parkScore: 70, volRatio: 3.0, changeRate: -5.0 }).hits, []);
ok('거래량 2.0 경계 + 상승 → 인정', an.seonjeomTriggers({ parkScore: 70, volRatio: 2.0, changeRate: 0.1 }).hits, ['VOLUME_SURGE']);
ok('거래량 1.99 → 미인정', an.seonjeomTriggers({ parkScore: 70, volRatio: 1.99, changeRate: 5 }).hits, []);

// ── 6. KV 접근자 ──────────────────────────────────────────────────
console.log('\n=== 6. Phase 4 KV 접근자 ===');
fake.reset();

ok('지수 시계열 초기값 빈 배열', await db.getIndexCloses('kospi'), []);
await db.mergeIndexCloses('kospi', [{ d: '2025-01-02', c: 2400 }, { d: '20250103', c: 2410 }]);
ok('하이픈·비하이픈 병합 후 정규화', await db.getIndexCloses('kospi'), [{ d: '20250102', c: 2400 }, { d: '20250103', c: 2410 }]);

// 누적 병합 — 새 조회분이 6개월치뿐이어도 과거분이 유지돼야 RS120이 경계에서 끊기지 않는다.
await db.mergeIndexCloses('kospi', [{ d: '20250104', c: 2420 }]);
ok('누적 병합(덮어쓰기 아님)', (await db.getIndexCloses('kospi')).length, 3);
// 같은 날짜는 새 값이 이긴다.
await db.mergeIndexCloses('kospi', [{ d: '20250103', c: 2999 }]);
const merged = await db.getIndexCloses('kospi');
ok('같은 날짜 → 새 값', merged.find(r => r.d === '20250103').c, 2999);
ok('병합 후에도 오름차순', merged.map(r => r.d), ['20250102', '20250103', '20250104']);
// 불량 입력은 버린다 — 0 이하 종가가 섞이면 indexCloseOnOrBefore가 null을 뱉어 RS가 통째로 빈다.
await db.mergeIndexCloses('kospi', [{ d: 'bad', c: 1 }, { d: '20250105', c: 0 }, { d: '20250105', c: -1 }]);
ok('불량 입력 무시', (await db.getIndexCloses('kospi')).length, 3);
// 시장별로 분리 저장되는지 — 섞이면 코스닥 종목을 코스피로 재게 된다.
ok('kosdaq은 독립', await db.getIndexCloses('kosdaq'), []);

await db.saveRsDist({ breaks, n: 1000, date: '2025-01-20' });
const dist = await db.getRsDist();
ok('RS 분포 왕복', [dist.n, dist.date, dist.breaks.length], [1000, '2025-01-20', 101]);

await db.setSupplyCache('005930', supRows);
ok('수급 캐시 왕복', (await db.getSupplyCache('005930'))?.length, 5);
ok('없는 종목 → undefined', await db.getSupplyCache('999999'), undefined);
// TTL 경과분은 미스로 떨어져 다음 수집이 다시 채운다.
fake.seed('__supply__000660', supRows, 10);
ok('10일 전 캐시 + TTL 3일 → 만료', await db.getSupplyCache('000660', 3), undefined);
ok('10일 전 캐시 + TTL 30일 → 적중', (await db.getSupplyCache('000660', 30))?.length, 5);
// null 저장은 무시 — 네이버 장애를 캐시에 굳히면 TTL 동안 재시도가 막힌다.
await db.setSupplyCache('035420', null);
ok('null 저장 무시', await db.getSupplyCache('035420'), undefined);

await db.saveSeonjeomAlerts({ date: '2025-01-20', count: 2, items: [{ code: '005930' }, { code: '000660' }] });
const alerts = await db.getSeonjeomAlerts();
ok('선점 알림 왕복', [alerts.date, alerts.items.length], ['2025-01-20', 2]);
ok('저장 전 조회 → null', await db.getUsScan(), null);

// ── 결과 ──────────────────────────────────────────────────────────
console.log(`\n검증 ${pass + fail}건 — 통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
