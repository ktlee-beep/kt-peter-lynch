// KT Trading — 스케줄 작업 (node-cron)
// 매일 17:00 KST (UTC 08:00) — 전체 종목 스캔
// 6시간마다 — 매크로 갱신
import cron from 'node-cron';
import { calcRSI, calcMA, calcBollinger, calcMACD, calcLynchScore, calcLivermoreScore, calcPiotroski, calcGrowthStreak, hasNoLoss, calcTTM, calcParkScore, matrixZone, median, calcRsRatios, rsPercentile, buildRsBreakpoints, calcSupplyTrend, seonjeomTriggers, SEONJEOM_PARK_MIN } from './analysis.js';
import { getFundamentalsCache, setFundamentalsCache, createScanBatch, updateScanBatch, completeScanBatch, batchSaveAnalysis, saveMacroSnapshot, getActiveStocks, getSupabase, getScanResults, saveMorningBrief, loadCorpCodeMap, upsertCorpCodes, getDartCache, setDartCache, saveUsScan, getCompanyInfoCache, setCompanyInfoCache, setMultiYearCache, setQuarterlyCache, getGrowthCaches, countKvPrefix, listFreshKvCodes, listAllStocks, upsertStocks, deactivateStocks, saveUniverseMeta, savePerMedian, getPerMedian, getIndexCloses, mergeIndexCloses, saveRsDist, getRsDist, getSupplyCache, setSupplyCache, saveSeonjeomAlerts } from './db.js';
import { KS_UNIVERSE, KQ_UNIVERSE, fetchNaverFundamentals, fetchKospiFutures, CORP_MAP, fetchCorpCodeMap, fetchDartFinancials, US_UNIVERSE, fetchUsStockDaily, fetchDartCompanyInfo, fetchDartMultiYear, fetchDartQuarterly, hasYearData, dartCallStats, resetDartCallStats, snapshotDartCallStats, dartBlockedBy, fetchNaverMarketSum, filterUniverse, fetchIndexOHLCV, fetchNaverInvestor, KRX_INDICES } from './data.js';

const FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000; // PER/PBR/ROE는 주가 연동 — 1거래일 이상 지나면 재수집

// ── 스캔 유니버스 (DB에 종목이 없으면 하드코딩된 유니버스 사용) ─
function getScanUniverse() {
  return [
    ...KS_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KS' })),
    ...KQ_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KQ' })),
  ];
}

// ── 유니버스 갱신 (월 1회) ───────────────────────────────────────
// 하드코딩 199종목(KS 153 + KQ 46)을 시장 전체에서 걸러낸 목록으로 대체한다.
// 원천은 네이버 일괄 시세 1종뿐이다. 계획서의 폴백(DART corpCode.xml)은 채택하지 않았다 —
// corpCode.xml에는 시장구분도 시가총액도 없어서 아래 필터를 아예 적용할 수 없고, 보충하려면
// 종목별 조회 3,900회가 필요한데 그 경로 역시 네이버라 원천이 죽으면 같이 죽는다.
// 대신 "실패하면 아무것도 바꾸지 않는다"를 폴백으로 삼는다. 기존 kt_stocks가 그대로 남고,
// 그마저 비어 있으면 getScanUniverse()의 하드코딩 199종목이 여전히 바닥을 받친다.
const UNIVERSE_MIN_SANE = 500;        // 정상치는 1,100종목대(2026-08-28 실측)
const UNIVERSE_MIN_PER_MARKET = 100;  // 실측 KOSPI 441 / KOSDAQ 695 (2026-08-28)
const DEPART_RATIO = 0.3;

// 트리거 입력(JSON 본문) 정규화. HTTP 핸들러가 아니라 여기 두는 이유는 두 가지다 —
// 클램프 범위가 유니버스 로직의 일부이고, 여기 있어야 자격증명·서버 기동 없이 검증된다.
export function normalizeUniverseOpts(body = {}) {
  // Number(null)·Number('')·Number([])·Number(false)는 전부 0이고 Number.isFinite를 통과한다.
  // 그대로 클램프하면 {"minCapEok":null}이 기본값 1000이 아니라 하한 100이 되어 유니버스가
  // 2,000종목대로 부푼다. 더 나쁜 건 그 다음이다 — 팽창에는 상한 가드가 없고 축소에만 있어서,
  // 다음 달 기본값 실행이 이탈 상한에 걸려 force 없이는 매달 실패한다. 잘못된 수동 실행
  // 한 번이 정기 작업을 영구 정지시키지 않도록 숫자·숫자문자열만 받는다.
  const num = (v, def, min, max) => {
    if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    // 시총 하한을 0으로 두면 껍데기까지 들어와 백필 예산이 터진다 — 하한의 하한을 100억으로 강제.
    minCapEok:   num(body?.minCapEok, 1000, 100, 100000),
    minValueEok: num(body?.minValueEok, 3, 0, 1000),
    dryRun: body?.dryRun === true || body?.dryRun === 'true',
    force:  body?.force  === true || body?.force  === 'true',
  };
}

export async function refreshUniverse({ minCapEok = 1000, minValueEok = 3, dryRun = false, force = false } = {}) {
  const t0 = Date.now();
  let rows;
  try {
    rows = await fetchNaverMarketSum();
  } catch (e) {
    console.error('[Universe] 원천 조회 실패 — 기존 유니버스 유지:', e.message);
    return { ok: false, error: `원천 조회 실패: ${e.message}`, changed: false };
  }

  const { kept, stats } = filterUniverse(rows, { minCapEok, minValueEok });
  console.log(`[Universe] 원본 ${stats.total} → 통과 ${kept.length}`, JSON.stringify(stats));

  // 원천이 조용히 반쪽만 주면 나머지가 전부 "유니버스 이탈"로 보여 is_active가 통째로 꺼진다.
  // 그 상태로 일일 스캔이 돌면 분석 대상이 사라지고, 되돌리려면 다음 달까지 기다려야 한다.
  if (kept.length < UNIVERSE_MIN_SANE) {
    return { ok: false, error: `유니버스 ${kept.length}종목 — 최소 ${UNIVERSE_MIN_SANE} 미만이라 반영 중단`, changed: false, stats };
  }

  // 합계 하한만으로는 한 시장이 통째로 사라지는 사고를 못 잡는다. 실측 구성(KOSPI 441 +
  // KOSDAQ 695)에서 코스피가 전멸해도 남는 695종목은 위 검사를 여유롭게 통과한다.
  const byMarket = { KOSPI: 0, KOSDAQ: 0 };
  for (const r of kept) byMarket[r.market] = (byMarket[r.market] || 0) + 1;
  const thinMarket = Object.entries(byMarket).filter(([, n]) => n < UNIVERSE_MIN_PER_MARKET);
  if (thinMarket.length) {
    return { ok: false, changed: false, stats, byMarket,
      error: `${thinMarket.map(([m, n]) => `${m} ${n}종목`).join(', ')} — 시장별 최소 ${UNIVERSE_MIN_PER_MARKET} 미만이라 반영 중단` };
  }

  // ETF/ETN이 한 건도 안 걸러졌다면 걸러진 게 아니라 플래그 표현이 바뀐 것이다.
  // 이들 종목코드는 대부분 끝자리가 0이라 보통주 정규식이 백스톱이 되지 못한다 — 그대로
  // 반영하면 ETF가 유니버스에 섞여 DART 백필 예산이 새고 스캐너가 ETF를 종목으로 분석한다.
  // 실측 4,305행 중 1,536건이 ETF/ETN이었다. 0은 정상 범위가 아니다.
  if (stats.etfEtn === 0) {
    return { ok: false, changed: false, stats,
      error: 'ETF/ETN 탈락 0건 — 원천 플래그 형식 변경 의심, 반영 중단' };
  }

  let prev;
  try {
    prev = await listAllStocks();
  } catch (e) {
    return { ok: false, error: `기존 종목 조회 실패: ${e.message}`, changed: false, stats };
  }
  const nowSet = new Set(kept.map(r => r.code));
  const prevActiveRows = prev.filter(p => p.is_active === 1);
  const prevActive = prevActiveRows.length;
  const departed = prevActiveRows.filter(p => !nowSet.has(p.code)).map(p => p.code);

  // 이탈이 비정상적으로 많으면 원천이 다른 집합을 준 것으로 본다. 상장폐지·시총 미달로
  // 한 달에 수백 종목이 한꺼번에 빠지는 일은 없다. 의도한 대량 정리는 force로 명시한다.
  // 전체와 시장별을 함께 본다 — 한 시장의 대량 소실은 전체 비율로 희석돼(예: 300/1,136 = 26%)
  // 합계만 보면 통과한다. 활성 이력이 없는 시장은 건너뛴다(하드코딩 유니버스에서 넘어오는 첫 실행).
  const overLimit = [];
  const checkDepart = (label, departedN, activeN) => {
    const limit = Math.max(100, Math.floor(activeN * DEPART_RATIO));
    if (departedN > limit) overLimit.push(`${label} 이탈 ${departedN} > 상한 ${limit}(활성 ${activeN}의 ${DEPART_RATIO * 100}%)`);
  };
  checkDepart('전체', departed.length, prevActive);
  for (const mk of Object.keys(byMarket)) {
    const active = prevActiveRows.filter(p => p.market === mk);
    if (!active.length) continue;
    checkDepart(mk, active.filter(p => !nowSet.has(p.code)).length, active.length);
  }
  if (!force && overLimit.length) {
    return { ok: false, changed: false, stats, byMarket,
      error: `${overLimit.join(' / ')} — force 없이는 반영하지 않음` };
  }

  const toUpsert = kept.map(r => ({
    code: r.code, name: r.name, market: r.market, is_active: 1,
    yahoo_suffix: r.market === 'KOSPI' ? 'KS' : 'KQ',
  }));

  if (dryRun) {
    return { ok: true, dryRun: true, changed: false, universe: kept.length, prevActive, byMarket,
      departed: departed.length, stats, thresholds: { minCapEok, minValueEok },
      sample: kept.slice(0, 5).map(r => `${r.code} ${r.name} ${Math.round(r.marketCap)}억`) };
  }

  // 순서가 중요하다. kt_daily_analysis.code가 kt_stocks를 참조하므로 종목 마스터가 먼저다.
  const upserted = await upsertStocks(toUpsert);
  const deactivated = await deactivateStocks(departed);

  // 시총·거래대금은 kt_stocks에 컬럼이 없다(운영 DDL 권한 없음). Phase 4의 RS 백분위와
  // 유동성 재필터가 재조회 없이 쓰도록 KV 블롭에 같이 남긴다.
  await saveUniverseMeta({
    updatedAt: new Date().toISOString(),
    thresholds: { minCapEok, minValueEok },
    stats,
    stocks: kept.map(r => ({ c: r.code, m: Math.round(r.marketCap), v: Math.round(r.tradingValue) })),
  });

  const out = { ok: true, changed: true, universe: kept.length, prevActive, byMarket, upserted, deactivated,
    stats, thresholds: { minCapEok, minValueEok }, elapsedMs: Date.now() - t0 };
  console.log('[Universe] 갱신 완료', JSON.stringify(out));
  return out;
}

// ── 박세익 축 프로필 (연속성장·무적자·TTM) ──────────────────────
// 캐시에 적재된 DART 연간·분기 데이터를 스크리너가 바로 필터할 수 있는 형태로 접는다.
// 데이터가 없으면 0/false가 아니라 null을 반환한다 — "성장하지 않았다"와
// "아직 수집하지 않았다"를 같은 값으로 만들면 백필 중인 종목이 전부 탈락으로 보인다.
export function buildGrowthProfile(multiYear, quarterly) {
  if (!Array.isArray(multiYear) || multiYear.length === 0) return null;
  // 길이만 보면 안 된다. fetchDartMultiYear는 미확보 연도를 자리표시 객체로 채우므로
  // 5개년이 전부 비어도 length는 5다. 그대로 통과시키면 streak 0 / parkSeikPass false가 나와
  // "성장하지 않은 종목"과 구별되지 않는다 — 위 주석의 원칙이 정확히 깨지는 지점.
  if (!multiYear.some(hasYearData)) return null;
  const revSeries = multiYear.map(y => y?.revenue ?? null);
  const opSeries  = multiYear.map(y => y?.operatingProfit ?? null);
  const netSeries = multiYear.map(y => y?.netIncome ?? null);

  const rev = calcGrowthStreak(revSeries);
  const op  = calcGrowthStreak(opSeries);
  const noLossOp3y = hasNoLoss(opSeries, 3);

  // TTM은 분기 누적과 "그 전년" 연간을 짝지어야 한다. 연도 정합성은 calcTTM이 강제하므로
  // 여기서는 prevFullYearRef로 연간 행을 찾아 넘기기만 한다(못 찾으면 null → calcTTM이 null).
  const ttmOf = (cumKey, prevCumKey, annualKey) => {
    if (!quarterly) return null;
    const prevFull = multiYear.find(y => y?.year === quarterly.prevFullYearRef)?.[annualKey] ?? null;
    return calcTTM({
      cum: quarterly[cumKey], cumYear: quarterly.year,
      prevFullYear: prevFull, prevFullYearOf: quarterly.prevFullYearRef,
      prevCum: quarterly[prevCumKey],
    });
  };

  return {
    years: multiYear.map(y => y?.year ?? null),
    revenueStreak: rev.streak, revenueComparable: rev.comparable,
    opStreak:      op.streak,  opComparable:      op.comparable,
    noLossOp3y,
    noLossNet3y: hasNoLoss(netSeries, 3),
    // 박세익 1축: 3년 연속 매출·영업이익 성장 + 3년 무적자.
    // hasNoLoss는 판정 불가 시 null(falsy)을 돌려주므로 반드시 === true로 비교한다.
    parkSeikPass: rev.streak >= 3 && op.streak >= 3 && noLossOp3y === true,
    ttmRevenue:         ttmOf('cumRevenue',         'prevCumRevenue',         'revenue'),
    ttmOperatingProfit: ttmOf('cumOperatingProfit', 'prevCumOperatingProfit', 'operatingProfit'),
    latestQuarter: quarterly ? {
      label:      quarterly.label,
      revenueYoY: quarterly.revenueYoY,
      opYoY:      quarterly.opYoY,
      netYoY:     quarterly.netYoY,
    } : null,
  };
}

// ── PER 유니버스 중앙값 (박세익 저평가 가점 기준) ────────────────
// 스캔은 청크(30종목)마다 즉시 저장한다. 그래서 스캔 도중에는 전 종목 PER이 아직 모이지
// 않아 "유니버스 중앙값"을 그 자리에서 만들 수 없다. 선택지는 둘뿐이었다 —
//   (a) 전 종목을 메모리에 모았다가 마지막에 한 번에 저장
//   (b) 직전 스캔에서 구한 중앙값을 오늘 쓰고, 오늘 값은 내일을 위해 남기기
// (a)는 스캔이 중간에 죽으면 그날 결과가 통째로 사라져 지금의 스트리밍 저장 내구성을 버린다.
// 시장 전체 PER 중앙값은 하루 사이에 의미 있게 움직이지 않으므로 (b)의 1일 지연을 택한다.
const PER_MEDIAN_MIN_SAMPLE = 100;   // 표본이 이보다 적으면 그건 "유니버스 중앙값"이 아니다
const PER_MEDIAN_MAX_AGE_DAYS = 14;  // 그 이상 묵은 값은 다른 국면의 숫자다 — 없느니만 못하다
const PER_SANE_MAX = 1000;           // 적자 직전 기업의 PER 수천 배를 표본에서 제외

// ── Phase 4-1: RS 컨텍스트 ────────────────────────────────────────
// 종목은 자기 시장 지수와 비교한다. KOSDAQ 종목을 KOSPI로 재면 2026년처럼 두 지수가
// 갈라진 국면에서 코스닥 전체가 통째로 "시장 대비 약함"으로 찍힌다 — 종목 고유의
// 상대강도를 재려는 지표에서 시장 효과가 그대로 남는 셈이다.
const RS_INDEX_BY_SUFFIX = { KS: 'kospi', KQ: 'kosdaq' };
const RS_MIN_SAMPLE = 200;           // 이보다 적은 표본의 분위점은 "유니버스 백분위"가 아니다

// 지수 시계열을 누적 병합해 읽어온다. 야후는 6개월치만 주므로 매일 덮어쓰면 RS120이
// 경계에서 끊긴다(mergeIndexCloses 주석 참조). 야후가 죽어도 누적분으로 계속 산출한다 —
// 하루치 결측은 indexCloseOnOrBefore의 tolerance가 흡수한다.
async function loadRsContext() {
  const series = {};
  for (const [suffix, id] of Object.entries(RS_INDEX_BY_SUFFIX)) {
    const meta = KRX_INDICES.find(x => x.id === id);
    let rows = null;
    try {
      const fresh = await fetchIndexOHLCV(meta.yahooSymbol, '6mo');
      rows = await mergeIndexCloses(id, fresh.map(r => ({ d: r.date, c: r.close })));
    } catch (e) {
      console.error(`[Cron] 지수 ${id} 갱신 실패 — 누적분으로 진행:`, e.message);
      rows = await getIndexCloses(id).catch(() => []);
    }
    series[suffix] = rows || [];
  }
  // 백분위 기준은 직전 스캔의 분포다(db.js saveRsDist 주석). 없으면 rsPercentile이 null을
  // 돌려주고 선점 트리거의 RS 조건만 빠진다 — 나머지 두 조건은 그대로 돈다.
  const dist = await getRsDist().catch(() => null);
  const breaks = Array.isArray(dist?.breaks) && dist.breaks.length === 101 ? dist.breaks : null;
  console.log(`[Cron] RS 지수 KOSPI ${series.KS?.length ?? 0}봉 / KOSDAQ ${series.KQ?.length ?? 0}봉, 백분위 기준 ${breaks ? `${dist.n}종목(${dist.date})` : '없음'}`);
  return { series, breaks };
}

// 저장된 중앙값을 쓸 수 있는지 판정. 못 쓰면 null — 호출부는 저평가 가점을 건너뛴다.
export function pickPerMedian(meta, nowMs = Date.now()) {
  if (!meta || !Number.isFinite(meta.median) || meta.median <= 0) return null;
  if (!Number.isFinite(meta.n) || meta.n < PER_MEDIAN_MIN_SAMPLE) return null;
  const ts = Date.parse(meta.at ?? '');
  if (!Number.isFinite(ts)) return null;
  if (nowMs - ts > PER_MEDIAN_MAX_AGE_DAYS * 86400000) return null;
  return meta.median;
}

// ── 경량 종목 분석 (Naver 일봉 기반) ────────────────────────────
// corpResolver(code)→corp_code, dartKey: DART 재무로 진짜 Piotroski 산출
// ctx.perMedian: 박세익 스코어의 PER 저평가 가점 기준 (없으면 해당 항목 미반영)
async function analyzeStockLean(code, corpResolver = null, dartKey = '', ctx = {}) {
  try {
    // count=280: 52주(거래일 약 252일) + 휴장 버퍼. Phase 4 RS 12개월 산출도 동일 데이터를 재사용한다.
    const naverUrl = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=280&requestType=0`;
    const nr = await fetch(naverUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!nr.ok) throw new Error('naver fail');
    const xml = await nr.text();

    const items = [...xml.matchAll(/<item data="([^"]+)"/g)].map(m => {
      const [d, o, h, l, c, v] = m[1].split('|');
      return { d, o: +o, h: +h, l: +l, c: +c, v: +v };
    }).filter(i => i.c > 0);

    if (items.length < 20) throw new Error('insufficient data');

    const closes  = items.map(i => i.c);
    const volumes = items.map(i => i.v);
    const cur  = closes[closes.length - 1];
    const prev = closes[closes.length - 2] || cur;
    const changeRate = prev > 0 ? (cur - prev) / prev * 100 : 0;

    const rsiVal  = calcRSI(closes).at(-1);
    const macdVal = calcMACD(closes);
    const bb      = calcBollinger(closes);
    const ma5arr  = calcMA(closes, 5);
    const ma20arr = calcMA(closes, 20);
    const ma60arr = calcMA(closes, 60);
    const ma5  = ma5arr.at(-1),  ma20 = ma20arr.at(-1),  ma60 = ma60arr.at(-1);
    const volRatio = volumes.length >= 21
      ? (volumes[volumes.length - 1]) / (volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20)
      : null;
    // 52주 고저 — 상장 1년 미만이면 w52Partial로 표시해 하위 점수 로직이 신뢰 여부를 판단하게 한다
    const w52 = closes.slice(-252);
    const w52Partial = w52.length < 240; // 240봉 ≈ 11.4개월. 그 미만은 52주 고저로 볼 수 없다
    const high52w = Math.max(...w52);
    const low52w  = Math.min(...w52);
    const pctFrom52wHigh = high52w > 0 ? (cur / high52w - 1) * 100 : null; // 음수 = 고점 대비 하락률
    const pctFrom52wLow  = low52w  > 0 ? (cur / low52w  - 1) * 100 : null;
    // 신규 상장주는 짧은 기간의 고가가 곧 52주 고가가 되어 전 종목이 "신고가 근접"으로 잡힌다.
    // 점수에 들어가는 판정이므로 데이터가 부족하면 아예 false로 둔다.
    const near52wHigh = !w52Partial && cur > 0 && high52w > 0 ? (cur / high52w) >= 0.95 : false;
    const near52wLow  = !w52Partial && cur > 0 && low52w  > 0 ? (cur / low52w)  <= 1.05 : false;

    let buyPts = 0, sellPts = 0;
    // RSI
    if (rsiVal !== null) {
      if (rsiVal >= 50 && rsiVal <= 70) buyPts++;
      else if (rsiVal < 35)              buyPts++;
      if (rsiVal > 75)                   sellPts++;
    }
    // MACD 크로스
    if (macdVal?.lastCross === 'golden') buyPts += 2;
    if (macdVal?.lastCross === 'dead')   sellPts += 2;
    // 이동평균 정배열
    if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60) buyPts += 2;
    else if (ma5 && ma20 && ma5 < ma20)                    sellPts++;
    // 볼린저밴드
    if (bb) {
      if (bb.percentB < 15)  buyPts++;   // 하단 근접 — 반등 가능
      if (bb.percentB > 88)  sellPts++;  // 상단 돌파 — 과열
    }
    // 거래량 급등 (2배 이상)
    if (volRatio !== null && volRatio >= 2.0) buyPts++;
    // 52주 신고가 근접
    if (near52wHigh) buyPts++;

    let signal = 'HOLD', confidence = 50;
    if (buyPts >= 3)  { signal = 'BUY';  confidence = Math.min(35 + buyPts * 10, 95); }
    if (sellPts >= 3) { signal = 'SELL'; confidence = Math.min(35 + sellPts * 10, 95); }

    // 펀더멘털: 캐시 우선 (24h TTL) — 스테일이면 재수집, 실패 시 과거값 폴백
    // (스크리너 PER/PBR/ROE 필터 데이터원)
    const cachedFund = await getFundamentalsCache(code).catch(() => null);
    const isFresh = cachedFund && (Date.now() - new Date(cachedFund.updatedAt).getTime()) < FUNDAMENTALS_TTL_MS;
    let fundamentals = isFresh ? cachedFund.fundamentals : null;
    if (!fundamentals) {
      fundamentals = await fetchNaverFundamentals(code).catch(() => null);
      if (fundamentals) {
        await setFundamentalsCache(code, fundamentals).catch(() => {});
      } else if (cachedFund) {
        fundamentals = cachedFund.fundamentals; // 갱신 실패 시 과거값이라도 사용
      }
    }

    // DART 재무: 90일 캐시 우선 → 진짜 Piotroski F-Score 입력 (분기 데이터)
    let dart = await getDartCache(code).catch(() => undefined);
    if (dart === undefined) {
      const corp = corpResolver ? corpResolver(code) : null;
      dart = (corp && dartKey) ? await fetchDartFinancials(corp, dartKey).catch(() => null) : null;
      await setDartCache(code, dart).catch(() => {});
    }
    const fScore = calcPiotroski(dart, fundamentals);

    // 저평가 선점(박세익 축) 입력 — 캐시 읽기 전용. 여기서 DART를 직접 호출하지 않는 것이 핵심이다.
    // 일일 스캔은 매일 전 종목을 도는데 종목당 최대 12회(개황 1 + 연간 5 + 분기 6)를 호출하면
    // 그것만으로 DART 일일 쿼터 20,000회를 넘긴다. 수집은 월 1회 runFundamentalsBackfill이
    // 전담하고 스캔은 적재된 값을 읽기만 한다. 미적재 종목은 growth=null로 지나간다.
    // 3종을 .in() 한 번으로 읽는다 — 종목당 왕복 3회가 1회가 된다(db.js getGrowthCaches 주석 참조).
    const { company, multiYear, quarterly } = await getGrowthCaches(code);
    const growth = buildGrowthProfile(multiYear, quarterly);

    const { pScore } = calcLynchScore(
      cur, ma5, ma20, ma60, rsiVal ?? 50, volRatio ?? 1, changeRate, dart, fundamentals,
    );
    const { lScore } = calcLivermoreScore(
      cur, ma5, ma20, ma60, rsiVal ?? 50, volRatio ?? 1, changeRate, high52w,
      macdVal?.lastCross ?? null, bb,
    );

    // 박세익 축 스코어와 2축 매트릭스. 리버모어 점수가 나온 뒤라야 존을 판정할 수 있다.
    const park = calcParkScore(growth, { pctFrom52wHigh, w52Partial }, fundamentals, { perMedian: ctx?.perMedian ?? null });
    const zone = matrixZone(park.score, lScore, park.gated);

    // RS(시장 대비 상대강도) — Phase 4-1. 지수 시계열은 스캔 시작 시 한 번 읽어 ctx로 넘어온다.
    // 종목마다 야후를 때리면 3,900회가 되고, 그건 이 스캔에서 가장 비싼 항목이 된다.
    const rsRatios = calcRsRatios(closes, items.map(i => i.d), ctx?.indexSeries ?? null);
    const rs = {
      rs20: rsRatios.rs20, rs60: rsRatios.rs60, rs120: rsRatios.rs120,
      score: rsRatios.rsScore,
      pct: rsPercentile(rsRatios.rsScore, ctx?.rsBreaks ?? null),
      partial: rsRatios.partial,
    };

    return {
      code, close: cur, changeRate, volRatio, rsi: rsiVal, source: 'naver',
      macd: macdVal, bb,
      ma5, ma20, ma60,
      near52wHigh, near52wLow, high52w, low52w, pctFrom52wHigh, pctFrom52wLow, w52Partial,
      combinedSignal: { signal, confidence, buyPts, sellPts },
      pScore,
      lScore,
      fScore,       // 진짜 Piotroski (DART 통합) — 기존 null에서 실제 산출로 교체
      dart,         // 스크리너/리포트에서 매출성장·영업이익률 활용
      fundamentals, // 스크리너 PER/PBR/ROE 필터용
      // 아래 5종은 analysis_json에 실려 저장된다 — 별도 컬럼 추가(DDL) 없이 스크리너가 소비한다.
      growth,       // 박세익 축: 연속성장 스트릭·무적자·TTM
      park,         // 박세익 스코어 { score, grade, gated, reasons }
      matrixZone: zone,  // SEONJEOM / BREAKOUT / STORY_WARN / NEUTRAL / EXCLUDED / NO_DATA
      rs,           // 시장 대비 상대강도 { rs20, rs60, rs120, score, pct, partial }
      quarterly,    // 최근 분기 원본 (누적·YoY)
      induty: company?.indutyCode ?? null,  // 표준산업분류 — 업종 상대비교/섹터 필터용
      market: company?.market ?? null,
    };
  } catch {
    return null;
  }
}

// ── 미국 스캔 (다우30+나스닥100 핵심, Yahoo 기술점수) ──────────────
async function analyzeUsStock(ticker, name, sector) {
  const d = await fetchUsStockDaily(ticker).catch(() => null);
  if (!d) return null;
  const { closes, highs, lows, volumes } = d;
  const cur  = d.price ?? closes.at(-1);
  const prev = d.prevClose ?? closes.at(-2) ?? cur;
  const changeRate = prev > 0 ? (cur - prev) / prev * 100 : 0;
  const rsi  = calcRSI(closes).at(-1);
  const macd = calcMACD(closes);
  const bb   = calcBollinger(closes);
  const ma5  = calcMA(closes, 5).at(-1), ma20 = calcMA(closes, 20).at(-1), ma60 = calcMA(closes, 60).at(-1);
  const volRatio = volumes.length >= 21 ? volumes.at(-1) / (volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20) : 1;
  const high52 = Math.max(...closes.slice(-252));
  const near52 = cur > 0 && high52 > 0 ? cur / high52 >= 0.95 : false;
  const { lScore } = calcLivermoreScore(cur, ma5, ma20, ma60, rsi ?? 50, volRatio ?? 1, changeRate, high52, macd?.lastCross ?? null, bb);

  // 매수/매도 신호 — 한국 경량 스캔과 동일 규칙
  let buyPts = 0, sellPts = 0;
  if (rsi != null) { if (rsi >= 50 && rsi <= 70) buyPts++; else if (rsi < 35) buyPts++; if (rsi > 75) sellPts++; }
  if (macd?.lastCross === 'golden') buyPts += 2; if (macd?.lastCross === 'dead') sellPts += 2;
  if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60) buyPts += 2; else if (ma5 && ma20 && ma5 < ma20) sellPts++;
  if (bb) { if (bb.percentB < 15) buyPts++; if (bb.percentB > 88) sellPts++; }
  if (volRatio != null && volRatio >= 2) buyPts++;
  if (near52) buyPts++;
  let signal = 'HOLD', confidence = 50;
  if (buyPts >= 3) { signal = 'BUY';  confidence = Math.min(35 + buyPts * 10, 95); }
  if (sellPts >= 3) { signal = 'SELL'; confidence = Math.min(35 + sellPts * 10, 95); }

  return {
    ticker, name, sector, price: cur, changeRate,
    rsi: rsi ?? null, livermoreScore: lScore, signal, confidence,
    near52wHigh: near52, pos52w: high52 > 0 ? Math.round(cur / high52 * 100) : null,
    macdCross: macd?.lastCross ?? null,
  };
}

export async function runUsScan() {
  console.log('[Cron] 미국 스캔 시작');
  const out = [];
  const CHUNK = 15;
  for (let i = 0; i < US_UNIVERSE.length; i += CHUNK) {
    const chunk = US_UNIVERSE.slice(i, i + CHUNK);
    const res = await Promise.allSettled(chunk.map(([tk, nm, sec]) => analyzeUsStock(tk, nm, sec)));
    for (const r of res) if (r.status === 'fulfilled' && r.value) out.push(r.value);
    await new Promise(r => setTimeout(r, 400));
  }
  out.sort((a, b) => (b.livermoreScore - a.livermoreScore) || (b.confidence - a.confidence));
  const payload = { stocks: out, scannedAt: new Date().toISOString(), count: out.length };
  await saveUsScan(payload).catch(e => console.error('[Cron] 미국 스캔 저장 실패:', e.message));
  console.log(`[Cron] 미국 스캔 완료 — ${out.length}종목, BUY ${out.filter(s => s.signal === 'BUY').length}`);
  return payload;
}

// ── DART 기업코드 매핑 갱신 (전체 상장사 code→corp_code) ─────────
export async function refreshCorpCodes() {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) { console.log('[Cron] DART_API_KEY 없음 — corp_code 갱신 스킵'); return { ok: false, count: 0, error: 'DART_API_KEY 미설정' }; }
  console.log('[Cron] DART 기업코드 매핑 갱신 시작');
  const rows = await fetchCorpCodeMap(dartKey);
  const n = await upsertCorpCodes(rows);
  console.log(`[Cron] DART 기업코드 ${n}/${rows.length}개 저장`);
  return { ok: true, count: n, total: rows.length };
}

// ── 펀더멘털 백필 (기업개황 · 연간 5개년 · 분기) ──────────────────
// 한 종목을 채우는 데 최대 12회(개황 1 + 연간 5 + 분기 6)가 든다. 상장사 3,930개면
// 약 47,000회로 DART 일일 쿼터 20,000회를 훨씬 넘는다. 그래서 한 번에 끝내려 하지 않고,
// 호출 예산(maxDartCalls)에 걸리면 중단하고 다음 실행이 신선한 캐시를 건너뛰며 이어받는
// 재개형 구조로 만든다 — 기본 예산이면 3회 실행에 전 종목 1회전이 끝난다.
//
// 실제 호출 수를 계측하는 대신 함수별 상한으로 예산을 잡는다. 과소 추정하면 쿼터를 넘겨
// 그날 남은 모든 DART 작업이 막히므로, 남는 쪽으로 틀리는 편이 옳다.
const BACKFILL_COST = { company: 1, multi: 5, quarter: 6 };

async function backfillOne({ code, need }, corpResolver, dartKey) {
  const corp = corpResolver(code);

  let info = null;
  if (need.company) {
    info = await fetchDartCompanyInfo(corp, dartKey).catch(() => null);
    if (info) await setCompanyInfoCache(code, info).catch(() => {});
  } else {
    info = await getCompanyInfoCache(code).catch(() => null);
  }

  // 분기 제출월 추정에 결산월이 필요하다. 못 구했을 때 12를 넘기면 12월 결산으로 단정하고
  // 제출기한 최적화가 켜지는데, 3월 결산사에서는 존재하는 보고서를 영원히 건너뛴다.
  // 0을 넘겨 최적화를 끄면 호출 몇 번을 더 쓰는 대신 무증상 누락이 사라진다(COST에 이미 반영).
  const accMonth = Number.isFinite(info?.accMonth) ? info.accMonth : 0;

  const [multi, q] = await Promise.all([
    need.multi   ? fetchDartMultiYear(corp, dartKey).catch(() => null) : Promise.resolve(null),
    need.quarter ? fetchDartQuarterly(corp, dartKey, accMonth).catch(() => null) : Promise.resolve(null),
  ]);

  // 원소 존재가 아니라 필드 내용으로 판정한다 — hasYearData 주석 참조.
  // some(v => v != null)로 쓰면 DART 장애로 5개년이 전부 빈 응답이어도 true가 되어
  // 빈 껍데기가 100일 TTL로 적재되고, 그 종목은 100일간 재수집에서 제외된다.
  const multiHasData = Array.isArray(multi) && multi.some(hasYearData);
  if (need.multi   && multiHasData) await setMultiYearCache(code, multi).catch(() => {});
  if (need.quarter && q)            await setQuarterlyCache(code, q).catch(() => {});

  // 아무것도 못 받았으면 캐시에 null을 쓰지 않는다. null을 적재하면 TTL 동안 재시도가 막히는데,
  // DART 일시 장애와 "정말 자료가 없는 종목"은 응답만 봐서는 구별되지 않아 장애를 100일 굳힌다.
  // 대신 자료가 없는 종목은 매 실행 재시도되므로 empty 카운터로 드러난다.
  const got = (need.company && !!info) || multiHasData || (need.quarter && !!q);
  return { empty: !got };
}

export async function runFundamentalsBackfill({ limit = 0, maxDartCalls = 15000, full = false } = {}) {
  const dartKey = process.env.DART_API_KEY;
  // 조기반환에도 dartCallsBudgeted를 반드시 싣는다. server.js는 이 값이 없으면 "얼마나 썼는지
  // 모른다"고 보고 maxDartCalls 전액(기본 15,000)을 일일 예산에서 차감한다 — 실제로는 한 번도
  // 호출하지 않았는데 두 번 실패하면 하루치 19,000이 소진돼 종일 429로 잠긴다.
  if (!dartKey) { console.log('[Backfill] DART_API_KEY 없음 — 중단'); return { ok: false, error: 'DART_API_KEY 미설정', dartCallsBudgeted: 0 }; }

  // 신선도 사전조회를 가장 먼저 한다. 실패 시 빈 집합으로 폴백하면 "전부 미수집"으로 보여
  // 이미 채운 종목까지 다시 긁어 예산을 통째로 태운다 — 조회가 실패하면 수집 자체를 하지 않는다.
  // 순서도 중요하다. 아래 corp_code 부트스트랩은 DART에서 zip을 받고 그 결과를 DB에 쓰는데,
  // DB가 죽어 있으면 어차피 이 함수는 아무것도 못 한다. 먼저 확인해서 헛일을 하지 않는다.
  let freshCo, freshMy, freshQ;
  try {
    [freshCo, freshMy, freshQ] = await Promise.all([
      listFreshKvCodes('__company__',   180),
      listFreshKvCodes('__multiyear__', 100),
      listFreshKvCodes('__quarterly__',  45),
    ]);
  } catch (e) {
    console.error('[Backfill] 캐시 신선도 조회 실패 — 중단:', e.message);
    return { ok: false, error: `캐시 신선도 조회 실패: ${e.message}`, dartCallsBudgeted: 0 };
  }

  let corpMap = await loadCorpCodeMap().catch(() => ({}));
  if (Object.keys(corpMap).length === 0) {
    await refreshCorpCodes().catch(e => console.error('[Backfill] corp_code 부트스트랩 실패:', e.message));
    corpMap = await loadCorpCodeMap().catch(() => ({}));
  }
  const corpResolver = (code) => corpMap[code] || CORP_MAP[code] || null;

  // full=true는 corp_code 매핑에 있는 전 상장사(약 3,930), 기본은 일일 스캔과 같은 대상.
  // Phase 2(유니버스 확장) 전에도 데이터를 미리 쌓아둘 수 있도록 스위치로 열어둔다.
  // 비-full일 때 runDailyScan과 같은 순서(kt_stocks 우선 → 하드코딩 폴백)를 쓰는 게 중요하다.
  // getScanUniverse()만 보면 kt_stocks에만 있는 종목이 스캔 대상인데도 영원히 안 채워진다.
  let codes;
  if (full) {
    codes = Object.keys(corpMap);
  } else {
    // 폴백은 조용하면 안 된다. 유니버스 확장 후 낙차가 1,136 → 199라, DB 일시 장애로
    // 대상이 83% 줄어도 로그가 없으면 "그냥 그날 적게 돌았다"로 지나간다.
    const active = await getActiveStocks().catch(e => {
      console.error('[Backfill] kt_stocks 조회 실패 — 하드코딩 유니버스로 폴백:', e.message);
      return [];
    });
    if (!active.length) console.warn('[Backfill] 활성 종목 0건 — 하드코딩 유니버스 사용');
    codes = (active.length ? active : getScanUniverse()).map(s => s.code);
  }

  let skipped = 0, noCorp = 0;
  const pending = [];
  for (const code of codes) {
    const need = {
      company: !freshCo.has(code),
      multi:   !freshMy.has(code),
      quarter: !freshQ.has(code),
    };
    if (!need.company && !need.multi && !need.quarter) { skipped++; continue; }
    if (!corpResolver(code)) { noCorp++; continue; }
    pending.push({
      code, need,
      cost: (need.company ? BACKFILL_COST.company : 0)
          + (need.multi   ? BACKFILL_COST.multi   : 0)
          + (need.quarter ? BACKFILL_COST.quarter : 0),
    });
  }
  const truncatedByLimit = limit > 0 && pending.length > limit;
  if (truncatedByLimit) pending.length = limit;

  console.log(`[Backfill] 대상 ${codes.length}종목 — 수집필요 ${pending.length} / 신선 ${skipped} / corp_code없음 ${noCorp}`);

  const CHUNK = 8;
  let calls = 0, done = 0, empty = 0, stoppedBy = truncatedByLimit ? 'limit' : null;

  // DART가 호출원을 막으면 모든 종목이 동시에 실패하는데, 예전 루프는 그걸 종목별 "무자료"로
  // 세면서 예산을 끝까지 태웠다 — 2026-08-30 실행이 14,976회를 쓰고 152종목만 적재했다.
  // 예산은 일일 쿼터에서 차감되므로, 아무것도 못 받는 상태로 계속 도는 것은 그날 남은 DART
  // 작업(일일 스캔의 재무·공시)까지 함께 죽인다. 그래서 두 가지로 멈춘다.
  //   1) 차단을 뜻하는 status가 오면 즉시 — 더 돌아도 결과는 같다.
  //   2) 연속 전멸이 이어지면 — 네트워크 단에서 끊기면 status조차 없다.
  // 40종목(5청크)이 연달아 전부 무자료일 확률은 정상 상태에서 사실상 없다. 그보다 짧게 잡으면
  // 비상장 폐지 직전 종목이 몰린 구간에서 정상 실행을 오탐으로 끊을 수 있다.
  // 전멸한 청크가 "자료가 없어서"인지 "닿지 못해서"인지는 네트워크 실패 수로 갈린다.
  // 닿지 못하는 상태는 더 돌아도 결과가 달라지지 않으므로 훨씬 빨리 끊는다. 반대로 한 번의
  // 일시적 리셋으로 정상 실행을 죽이면 안 되니 연속 2청크는 본다.
  const DEAD_CHUNKS = 5, UNREACHABLE_CHUNKS = 2;
  let deadStreak = 0, netStreak = 0;
  resetDartCallStats();

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const chunkCost = chunk.reduce((s, p) => s + p.cost, 0);
    if (calls + chunkCost > maxDartCalls) { stoppedBy = 'quota'; break; }
    calls += chunkCost;

    const netBefore = dartCallStats.network;
    const res = await Promise.allSettled(chunk.map(p => backfillOne(p, corpResolver, dartKey)));
    const hit = res.filter(r => r.status === 'fulfilled' && r.value && !r.value.empty).length;
    done += hit;
    empty += chunk.length - hit;

    const blocked = dartBlockedBy();
    if (blocked.length) {
      stoppedBy = `dart-blocked:${blocked.join(',')}`;
      console.error(`[Backfill] DART 차단 status ${blocked.join(',')} — 중단 (적재 ${done}, 호출 ${calls})`);
      break;
    }
    const unreachable = dartCallStats.network > netBefore;
    if (hit) { deadStreak = 0; netStreak = 0; }
    else { deadStreak++; netStreak = unreachable ? netStreak + 1 : 0; }
    if (netStreak >= UNREACHABLE_CHUNKS) {
      stoppedBy = `dart-unreachable:${Object.keys(dartCallStats.netCause).join(',')}`;
      console.error(`[Backfill] DART 연결 실패 연속 — 중단 (적재 ${done}, 호출 ${calls}, 원인 ${JSON.stringify(dartCallStats.netCause)})`);
      break;
    }
    if (deadStreak >= DEAD_CHUNKS) {
      stoppedBy = 'dead-streak';
      console.error(`[Backfill] ${DEAD_CHUNKS * CHUNK}종목 연속 무자료 — 수집 불능으로 보고 중단 (적재 ${done}, 호출 ${calls})`);
      break;
    }

    if ((i / CHUNK) % 25 === 0) {
      console.log(`[Backfill] ${i + chunk.length}/${pending.length} — 적재 ${done}, 무자료 ${empty}, 호출 ${calls}/${maxDartCalls}`);
    }
    // 청크 간 고정 대기는 두지 않는다. 속도 제어는 dartGet의 전역 페이서가 담당하며,
    // 여기서 또 재우면 같은 목적의 지연이 두 겹으로 쌓여 실행 시간만 늘어난다.
  }

  const [nCo, nMy, nQ] = await Promise.all([
    countKvPrefix('__company__').catch(() => -1),
    countKvPrefix('__multiyear__').catch(() => -1),
    countKvPrefix('__quarterly__').catch(() => -1),
  ]);

  const result = {
    ok: true, universe: codes.length, targeted: pending.length,
    filled: done, empty, freshSkipped: skipped, noCorpCode: noCorp,
    dartCallsBudgeted: calls, maxDartCalls,
    // empty가 왜 컸는지 결과만 보고 판별할 수 있게 원인별 계수를 함께 싣는다.
    // status['013']이 크면 진짜 무자료, '020'·'012' 등이 있으면 우리가 막힌 것이다.
    dart: snapshotDartCallStats(),
    stoppedBy,                       // 'quota' | 'limit' | null(완주)
    truncatedByLimit,
    // 주의: limit로 자른 경우 pending이 이미 잘려 있어 이 값은 "전체 백로그"가 아니라
    // "이번 배치의 잔여"다. 전체 진행률은 아래 cached 건수로 볼 것.
    batchRemaining: pending.length - done - empty,
    cached: { company: nCo, multiYear: nMy, quarterly: nQ },
  };
  console.log(`[Backfill] 완료 — 적재 ${done}, 무자료 ${empty}, 배치잔여 ${result.batchRemaining}, 중단사유 ${stoppedBy ?? '없음(완주)'}`);
  return result;
}

// ── 전체 스캔 (청크 단위 처리) ───────────────────────────────────
export async function runDailyScan() {
  console.log('[Cron] 전체 종목 스캔 시작');
  const today = new Date().toISOString().slice(0, 10);

  let stocks;
  let fallbackUniverse = false;
  try {
    stocks = await getActiveStocks();
  } catch (e) {
    console.error('[Cron] kt_stocks 조회 실패 — 하드코딩 유니버스로 폴백:', e.message);
    stocks = [];
  }
  if (!stocks.length) {
    console.warn('[Cron] 활성 종목 0건 — 하드코딩 유니버스 사용');
    stocks = getScanUniverse();
    fallbackUniverse = true;
  }

  // corp_code 매핑 로드 — 비어 있으면 DART에서 1회 부트스트랩 (A: 전체 상장사 매핑)
  let corpMap = await loadCorpCodeMap().catch(() => ({}));
  if (Object.keys(corpMap).length === 0) {
    await refreshCorpCodes().catch(e => console.error('[Cron] corp_code 부트스트랩 실패:', e.message));
    corpMap = await loadCorpCodeMap().catch(() => ({}));
  }
  const dartKey = process.env.DART_API_KEY || '';
  // 최신 DART 맵 우선, 하드코딩 CORP_MAP 폴백 (하드코딩엔 오류·누락 존재)
  const corpResolver = (code) => corpMap[code] || CORP_MAP[code] || null;
  console.log(`[Cron] corp_code 매핑 ${Object.keys(corpMap).length}개, DART키 ${dartKey ? '있음' : '없음'}`);

  // 박세익 저평가 가점 기준 — 직전 스캔이 남긴 값(없으면 null → 해당 항목 미반영)
  const perMedian = pickPerMedian(await getPerMedian().catch(() => null));
  console.log(`[Cron] PER 중앙값 기준: ${perMedian ?? '없음 (저평가 가점 제외)'}`);

  // RS 지수 시계열 + 직전 스캔 백분위 기준. 실패해도 스캔은 계속한다 — RS는 부가 지표라
  // 여기서 던지면 그날 전 종목 분석이 통째로 날아간다.
  const rsCtx = await loadRsContext().catch(e => {
    console.error('[Cron] RS 컨텍스트 로드 실패 — RS 없이 진행:', e.message);
    return { series: {}, breaks: null };
  });

  const batchId = `${today}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await createScanBatch(batchId, stocks.length);
  } catch {}

  const CHUNK_SIZE = 30;
  let totalProcessed = 0, totalFailed = 0, totalBuy = 0;
  const perSample = [];
  const rsSample = [];
  const zoneTally = { SEONJEOM: 0, BREAKOUT: 0, STORY_WARN: 0, NEUTRAL: 0, EXCLUDED: 0, NO_DATA: 0 };
  const gateTally = { NO_DATA: 0, SHORT_HISTORY: 0, LOSS_3Y: 0 };

  for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
    const chunk = stocks.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((s) => analyzeStockLean(s.code, corpResolver, dartKey, {
      perMedian,
      // 지수 시계열이 없으면 undefined가 넘어가고 calcRsRatios가 전부 null을 돌려준다 —
      // 알 수 없는 지수로 대신 재느니 RS를 비우는 쪽이 맞다.
      indexSeries: rsCtx.series[s.yahoo_suffix],
      rsBreaks: rsCtx.breaks,
    })));

    const rows = [];
    let chunkBuy = 0, chunkFail = 0;

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'rejected' || !r.value) { chunkFail++; continue; }
      const a = r.value;
      const signal = a.combinedSignal?.signal ?? 'HOLD';
      if (signal === 'BUY') chunkBuy++;

      // 내일 쓸 PER 중앙값 표본. 적자 기업의 음수 PER과 적자 직전의 수천 배 PER은 뺀다 —
      // 중앙값이 극단값에 강하다고 해서 의미 없는 값을 표본에 넣을 이유는 없다.
      const perVal = Number(a.fundamentals?.per);
      if (Number.isFinite(perVal) && perVal > 0 && perVal < PER_SANE_MAX) perSample.push(perVal);
      // 내일 쓸 RS 분포 표본. partial(상장 6개월 미만 등)은 rs20만으로 계산된 값이라
      // 120일까지 다 채운 종목과 같은 분포에 넣으면 기준선이 단기 변동에 끌린다.
      if (Number.isFinite(a.rs?.score) && !a.rs.partial) rsSample.push(a.rs.score);
      // 존·게이트 분포는 스캔 로그에만 남긴다. NO_DATA/SHORT_HISTORY가 급증하면 백필이
      // 밀린 것이고, 그건 조용히 진행되면 "선점 후보가 없는 날"로 오독된다.
      zoneTally[a.matrixZone] = (zoneTally[a.matrixZone] ?? 0) + 1;
      if (a.park?.gated) gateTally[a.park.gated] = (gateTally[a.park.gated] ?? 0) + 1;

      rows.push({
        code:            chunk[j].code,
        analysis_date:   today,
        signal,
        confidence:      a.combinedSignal?.confidence ?? 0,
        lynch_score:     a.pScore  ?? 0,
        livermore_score: a.lScore  ?? 0,
        piotroski_score: a.fScore?.score ?? 0,
        combined_score:  Math.round(((a.pScore ?? 0) + (a.lScore ?? 0)) / 2),
        rsi:             a.rsi       ?? null,
        macd_cross:      a.macd?.lastCross ?? null,
        close_price:     a.close     ?? null,
        change_rate:     a.changeRate ?? null,
        vol_ratio:       a.volRatio   ?? null,
        analysis_json:   JSON.stringify(a),
        data_source:     'cron',
        scan_batch_id:   batchId,
      });
    }

    if (rows.length) {
      try { await batchSaveAnalysis(rows); } catch (e) { console.error('[Cron] DB 저장 실패:', e.message); }
    }

    totalProcessed += chunk.length - chunkFail;
    totalFailed    += chunkFail;
    totalBuy       += chunkBuy;

    try { await updateScanBatch(batchId, chunk.length - chunkFail, chunkFail, chunkBuy); } catch {}

    // 과부하 방지: 청크 사이 0.5초 대기
    await new Promise(r => setTimeout(r, 500));
  }

  try { await completeScanBatch(batchId); } catch {}

  // 다음 스캔이 쓸 PER 중앙값. 표본이 모자라면 갱신하지 않는다 — 덮어써 버리면
  // 어제의 정상값까지 잃고, 다음 날도 표본이 모자라면 가점이 영구히 죽는다.
  // 폴백 유니버스(199종목 대형주 하드코딩)에서도 갱신하지 않는다. 표본 수(약 170)는
  // 최소치를 넘기지만 구성이 대형주 편향이라, DB 일시 장애 하루가 이후 최대 14일간
  // 전 종목의 저평가 가점 기준을 대형주 중앙값으로 오염시킨다. 표본 "수"가 아니라
  // 표본 "대표성"이 깨지는 경우라 개수 게이트로는 걸러지지 않는다.
  const perMed = median(perSample);
  if (fallbackUniverse) {
    console.warn(`[Cron] 폴백 유니버스 스캔 — PER 중앙값 갱신 생략 (표본 ${perSample.length}건, 대형주 편향)`);
  } else if (perMed != null && perSample.length >= PER_MEDIAN_MIN_SAMPLE) {
    await savePerMedian({ median: perMed, n: perSample.length, at: new Date().toISOString() })
      .catch(e => console.error('[Cron] PER 중앙값 저장 실패:', e.message));
  } else {
    console.warn(`[Cron] PER 표본 ${perSample.length}건 — 중앙값 갱신 생략 (최소 ${PER_MEDIAN_MIN_SAMPLE})`);
  }

  // 다음 스캔이 쓸 RS 백분위 기준. 생략 조건은 PER 중앙값과 같은 이유다 — 폴백 유니버스의
  // 대형주 편향 분포로 덮어쓰면 이후 전 종목의 RS 백분위가 대형주 기준으로 매겨진다.
  const rsBreaksNew = buildRsBreakpoints(rsSample);
  if (fallbackUniverse) {
    console.warn(`[Cron] 폴백 유니버스 스캔 — RS 분포 갱신 생략 (표본 ${rsSample.length}건)`);
  } else if (rsBreaksNew && rsSample.length >= RS_MIN_SAMPLE) {
    await saveRsDist({ breaks: rsBreaksNew, n: rsSample.length, date: today, at: new Date().toISOString() })
      .catch(e => console.error('[Cron] RS 분포 저장 실패:', e.message));
  } else {
    console.warn(`[Cron] RS 표본 ${rsSample.length}건 — 분포 갱신 생략 (최소 ${RS_MIN_SAMPLE})`);
  }

  console.log(`[Cron] 스캔 완료 — 처리: ${totalProcessed}, 실패: ${totalFailed}, BUY: ${totalBuy}`);
  console.log(`[Cron] 매트릭스 ${JSON.stringify(zoneTally)} / 박세익 게이트 ${JSON.stringify(gateTally)} / PER중앙값 ${perMed ?? '-'}(표본 ${perSample.length})`);

  // Feature 3: 급등락(±5%) 종목 뉴스 펄스 분석 캐시 워밍 (최대 5개, 비동기)
  (async () => {
    try {
      const { data: bigMovers } = await getSupabase()
        .from('kt_daily_analysis')
        .select('code, change_rate, close_price, rsi, vol_ratio, analysis_json')
        .eq('analysis_date', today)
        .or('change_rate.gte.5,change_rate.lte.-5')
        .limit(5);
      if (!bigMovers?.length) return;
      const { analyzeNewsPulse } = await import('./gemini.js');
      for (const m of bigMovers) {
        const parsed = m.analysis_json
          ? (typeof m.analysis_json === 'string' ? JSON.parse(m.analysis_json) : m.analysis_json)
          : {};
        await analyzeNewsPulse({
          code: m.code, name: parsed.name || m.code,
          changeRate: m.change_rate, close: m.close_price,
          rsi: m.rsi, volRatio: m.vol_ratio, market: parsed.market,
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000)); // 2초 간격 (API 부하 방지)
      }
      console.log(`[Cron] 뉴스 펄스 캐시 워밍 완료 (${bigMovers.length}개)`);
    } catch (e) {
      console.error('[Cron] 뉴스 펄스 워밍 오류:', e.message);
    }
  })();
}

// ── 매크로 갱신 ──────────────────────────────────────────────────
async function runMacroUpdate() {
  console.log('[Cron] 매크로 갱신');
  const targets = [
    ['usdkrw', 'KRW=X'], ['kospi', '%5EKS11'], ['kosdaq', '%5EKQ11'],
    ['vix', '%5EVIX'], ['us10y', '%5ETNX'],
  ];
  const fetched = {};
  await Promise.allSettled(targets.map(async ([key, sym]) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return;
      const d = await r.json();
      const meta = d.chart?.result?.[0]?.meta;
      if (meta) fetched[key] = meta.regularMarketPrice ?? null;
    } catch {}
  }));
  try { await saveMacroSnapshot(fetched); } catch {}
  console.log('[Cron] 매크로 갱신 완료:', fetched);
}

// ── 아침 브리핑 (매 영업일 08:00 KST) ───────────────────────────
// 개장 전 밤사이 매크로를 경량 수집 (server.js /api/macro 규칙 축약판)
async function buildMorningMacro() {
  const targets = [
    ['usdkrw', 'KRW=X'], ['kospi', '%5EKS11'], ['vix', '%5EVIX'],
    ['us10y', '%5ETNX'], ['sp500', '%5EGSPC'], ['nasdaq', '%5EIXIC'],
  ];
  const data = {};
  await Promise.allSettled(targets.map(async ([k, sym]) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return;
      const meta = (await r.json()).chart?.result?.[0]?.meta;
      if (!meta) return;
      const cur = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose || cur;
      if (!cur || !prev) return;
      data[k] = { current: +cur.toFixed(2), changePct: +((cur - prev) / prev * 100).toFixed(2) };
    } catch {}
  }));

  let score = 0;
  const notes = [];
  const { usdkrw, kospi, vix, us10y, sp500, nasdaq } = data;
  if (sp500) {
    if (sp500.changePct > 1)       { score++; notes.push(`S&P500 +${sp500.changePct}% — 미국 증시 강세`); }
    else if (sp500.changePct < -1) { score--; notes.push(`S&P500 ${sp500.changePct}% — 미국 약세, 한국 연동 주의`); }
    else                            notes.push(`S&P500 ${sp500.changePct > 0 ? '+' : ''}${sp500.changePct}%`);
  }
  if (nasdaq) notes.push(`나스닥 ${nasdaq.changePct > 0 ? '+' : ''}${nasdaq.changePct}%`);
  if (vix) {
    if (vix.current > 25)      { score -= 2; notes.push(`VIX ${vix.current} — 공포 구간`); }
    else if (vix.current < 14) { score++;    notes.push(`VIX ${vix.current} — 시장 안정`); }
    else                        notes.push(`VIX ${vix.current}`);
  }
  if (usdkrw) {
    notes.push(`원/달러 ${usdkrw.current.toFixed(0)}원 (${usdkrw.changePct > 0 ? '+' : ''}${usdkrw.changePct}%)`);
    if (usdkrw.changePct > 0.5) score--;
    else if (usdkrw.changePct < -0.5) score++;
  }
  if (us10y) notes.push(`미국채10Y ${us10y.current}%`);
  if (kospi) notes.push(`전일 KOSPI ${kospi.changePct > 0 ? '+' : ''}${kospi.changePct}%`);
  const label = score >= 2 ? '긍정' : score <= -2 ? '부정' : '중립';
  return { label, score, notes };
}

export async function runMorningBrief() {
  console.log('[Cron] 아침 브리핑 생성 시작');
  try {
    const [macro, futures, picks] = await Promise.all([
      buildMorningMacro(),
      fetchKospiFutures().catch(() => null),
      getScanResults({ signal: 'BUY', limit: 5 }).catch(() => []),
    ]);
    const { generateMorningBrief } = await import('./gemini.js');
    const brief = await generateMorningBrief({ macro, futures, picks });
    brief.macro = macro; // 카드 표시용 매크로 노트
    brief.futures = futures && !futures.error
      ? { price: futures.price, changeRate: futures.changeRate }
      : null;
    await saveMorningBrief(brief);
    console.log('[Cron] 아침 브리핑 생성 완료:', brief.headline || '(headline 없음)');
  } catch (e) {
    console.error('[Cron] 아침 브리핑 오류:', e.message);
  }
}

// ── 알림 설정 조건 평가 ──────────────────────────────────────────
async function evaluateAlertSettings() {
  try {
    const { data: settings } = await getSupabase()
      .from('alert_settings')
      .select('user_email, code, target_price, stop_loss, rsi_high, rsi_low')
      .eq('is_active', true)
      .limit(5000);
    if (!settings?.length) return;

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const codes = [...new Set(settings.map(s => s.code))];
    const { data: recentAnalyses } = await getSupabase()
      .from('kt_daily_analysis')
      .select('code, rsi, close_price, analysis_date')
      .in('code', codes)
      .gte('analysis_date', yesterday)
      .order('analysis_date', { ascending: false });

    // code별 최신 분석만 사용 (전일 폴백 포함)
    const analysisMap = {};
    for (const a of recentAnalyses || []) {
      if (!analysisMap[a.code]) analysisMap[a.code] = a;
    }

    const triggered = [];
    for (const s of settings) {
      const a = analysisMap[s.code];
      if (!a) continue;
      const rsiHigh = s.rsi_high ?? 75;
      const rsiLow  = s.rsi_low  ?? 30;
      if (a.rsi != null && a.rsi > rsiHigh)
        triggered.push({ user_email: s.user_email, code: s.code, type: 'rsi_high', value: a.rsi });
      if (a.rsi != null && a.rsi < rsiLow)
        triggered.push({ user_email: s.user_email, code: s.code, type: 'rsi_low', value: a.rsi });
      if (s.target_price != null && a.close_price != null && a.close_price >= s.target_price)
        triggered.push({ user_email: s.user_email, code: s.code, type: 'target_hit', value: a.close_price });
      if (s.stop_loss != null && a.close_price != null && a.close_price <= s.stop_loss)
        triggered.push({ user_email: s.user_email, code: s.code, type: 'stop_loss_hit', value: a.close_price });
    }

    if (triggered.length) {
      console.log(`[Cron] 알림 조건 충족 ${triggered.length}건:`, triggered.map(t => `${t.code}:${t.type}`).join(', '));
    } else {
      console.log('[Cron] 알림 조건 충족 없음');
    }
  } catch (e) {
    console.error('[Cron] 알림 평가 오류:', e.message);
  }
}

// ── Phase 4-2: 수급 수집 ─────────────────────────────────────────
// 스캔 안에 넣지 않는다. 전 종목이면 네이버 호출이 3,900회 늘어 스캔 시간이 대략 두 배가
// 되는데, 수급은 스캔 결과를 즉시 바꾸지 않으므로 그 비용을 스캔에 물릴 이유가 없다.
// 스캔이 끝난 뒤 별도 예산으로 돈다.
//
// 대상은 박세익 축을 통과한 종목(parkScore >= 60)뿐이다. 선점 트리거의 게이트가 어차피
// 그 조건이라 나머지 종목의 수급은 지금 쓰이지 않는다 — 전 종목 수집은 하루 3,900회를
// 쓰고 그중 95%를 버리는 일이 된다. 게이트가 넓어지면 여기 필터만 풀면 된다.
const SUPPLY_MAX_FETCH = 400;      // 1.2초 간격 × 400 = 약 8분. Render 무료 티어에서 안전한 상한
const SUPPLY_DELAY_MS = 1200;
const SUPPLY_TTL_DAYS = 3;         // 주말·연휴에 같은 값을 다시 받아오지 않을 만큼만

export async function runSupplyCollect({ maxFetch = SUPPLY_MAX_FETCH } = {}) {
  console.log('[Cron] 수급 수집 시작');
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await getSupabase()
      .from('kt_daily_analysis')
      .select('code, analysis_json')
      .eq('analysis_date', today)
      .limit(5000);
    if (error) throw new Error(error.message);
    if (!data?.length) { console.warn('[Cron] 오늘 분석 결과 없음 — 수급 수집 생략'); return { fetched: 0, skipped: 0 }; }

    // 박세익 점수 내림차순 — 예산이 모자라면 후보성이 높은 종목부터 채운다.
    const targets = [];
    for (const row of data) {
      let a;
      try { a = typeof row.analysis_json === 'string' ? JSON.parse(row.analysis_json) : row.analysis_json; }
      catch { continue; }
      const score = Number(a?.park?.score);
      if (Number.isFinite(score) && score >= SEONJEOM_PARK_MIN) targets.push({ code: row.code, score });
    }
    targets.sort((a, b) => b.score - a.score);
    console.log(`[Cron] 수급 대상 ${targets.length}종목 (박세익 ${SEONJEOM_PARK_MIN}점 이상), 예산 ${maxFetch}회`);

    let fetched = 0, skipped = 0, failed = 0;
    for (const t of targets) {
      if (fetched >= maxFetch) {
        // 상한에 걸려 남긴 종목 수를 반드시 남긴다. 조용히 자르면 "수급 신호가 없는 날"과
        // "예산이 모자라 못 본 날"이 로그에서 구분되지 않는다.
        console.warn(`[Cron] 수급 예산 소진 — ${targets.length - fetched - skipped}종목 미수집`);
        break;
      }
      const cached = await getSupplyCache(t.code, SUPPLY_TTL_DAYS).catch(() => undefined);
      if (cached !== undefined) { skipped++; continue; }
      const rows = await fetchNaverInvestor(t.code).catch(() => null);
      if (rows?.length) { await setSupplyCache(t.code, rows).catch(() => {}); fetched++; }
      else failed++;
      await new Promise(r => setTimeout(r, SUPPLY_DELAY_MS));
    }
    console.log(`[Cron] 수급 수집 완료 — 신규 ${fetched}, 캐시 ${skipped}, 실패 ${failed}`);
    return { fetched, skipped, failed };
  } catch (e) {
    console.error('[Cron] 수급 수집 오류:', e.message);
    return { fetched: 0, skipped: 0, error: e.message };
  }
}

// ── Phase 4-3: 선점 트리거 평가 ──────────────────────────────────
// RS 백분위의 "상승 전환"은 오늘 값만으로는 알 수 없으므로 어제 저장분과 비교한다.
// analyzeStockLean 안에서 종목마다 전일 행을 읽으면 3,900회 왕복이 되니, 스캔이 끝난 뒤
// 이틀치를 한 번에 읽어 여기서 판정한다(evaluateAlertSettings와 같은 방식).
export async function evaluateSeonjeomTriggers() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await getSupabase()
      .from('kt_daily_analysis')
      .select('code, analysis_date, change_rate, vol_ratio, analysis_json')
      .gte('analysis_date', from)
      .order('analysis_date', { ascending: false })
      .limit(20000);
    if (error) throw new Error(error.message);
    if (!data?.length) { console.warn('[Cron] 선점 평가 — 분석 데이터 없음'); return []; }

    // code별로 최신 2개(오늘·직전 영업일). 주말·휴장으로 날짜가 건너뛰므로 고정 하루 전이
    // 아니라 "존재하는 직전 행"을 쓴다.
    const byCode = new Map();
    for (const r of data) {
      const arr = byCode.get(r.code) ?? [];
      if (arr.length < 2) { arr.push(r); byCode.set(r.code, arr); }
    }

    const parse = (r) => {
      try { return typeof r.analysis_json === 'string' ? JSON.parse(r.analysis_json) : r.analysis_json; }
      catch { return null; }
    };

    const fired = [];
    for (const [code, [cur, prev]] of byCode) {
      if (cur.analysis_date !== today) continue;   // 오늘 스캔이 안 된 종목은 판정하지 않는다
      const a = parse(cur);
      if (!Number.isFinite(Number(a?.park?.score)) || Number(a.park.score) < SEONJEOM_PARK_MIN) continue;

      const supplyRows = await getSupplyCache(code, SUPPLY_TTL_DAYS).catch(() => undefined);
      const supply = supplyRows ? calcSupplyTrend(supplyRows) : null;
      const t = seonjeomTriggers({
        parkScore: a.park.score,
        rsPct: a.rs?.pct ?? null,
        rsPctPrev: prev ? (parse(prev)?.rs?.pct ?? null) : null,
        supply,
        volRatio: cur.vol_ratio,
        changeRate: cur.change_rate,
      });
      if (t.fired) {
        fired.push({
          code, parkScore: a.park.score, zone: a.matrixZone,
          rsPct: a.rs?.pct ?? null, hits: t.hits, reasons: t.reasons,
        });
      }
    }

    fired.sort((x, y) => y.parkScore - x.parkScore);
    await saveSeonjeomAlerts({ date: today, count: fired.length, items: fired, at: new Date().toISOString() })
      .catch(e => console.error('[Cron] 선점 알림 저장 실패:', e.message));
    console.log(`[Cron] 선점 트리거 ${fired.length}건${fired.length ? ': ' + fired.slice(0, 10).map(f => `${f.code}(${f.hits.join('+')})`).join(', ') : ''}`);
    return fired;
  } catch (e) {
    console.error('[Cron] 선점 평가 오류:', e.message);
    return [];
  }
}

// ── cron 등록 ────────────────────────────────────────────────────
export function startCron() {
  // 매 영업일 20:00 KST = UTC 11:00
  cron.schedule('0 11 * * 1-5', async () => {
    await runDailyScan().catch(e => console.error('[Cron] 스캔 오류:', e));
    await evaluateAlertSettings().catch(e => console.error('[Cron] 알림 평가 오류:', e));
    // 수급 → 선점 순서를 지킨다. 선점 트리거의 수급 조건이 방금 채운 캐시를 읽으므로
    // 순서가 뒤집히면 첫날은 수급 조건이 통째로 빠진 채 판정된다.
    await runSupplyCollect().catch(e => console.error('[Cron] 수급 수집 오류:', e));
    await evaluateSeonjeomTriggers().catch(e => console.error('[Cron] 선점 평가 오류:', e));
  }, { timezone: 'UTC' });

  // 6시간마다 매크로 갱신
  cron.schedule('0 */6 * * *', () => {
    runMacroUpdate().catch(e => console.error('[Cron] 매크로 오류:', e));
  });

  // 매 영업일 08:00 KST = UTC 23:00 (전일) → UTC 요일 0-4(일~목) = KST 월~금
  cron.schedule('0 23 * * 0-4', () => {
    runMorningBrief().catch(e => console.error('[Cron] 아침 브리핑 오류:', e));
  }, { timezone: 'UTC' });

  // 미국 스캔 — 미 증시 마감(05~06시 KST) 후 07:00 KST = UTC 22:00(전일)
  cron.schedule('0 22 * * 0-4', () => {
    runUsScan().catch(e => console.error('[Cron] 미국 스캔 오류:', e));
  }, { timezone: 'UTC' });

  console.log('[Cron] 스케줄 등록 완료 (KR스캔 20:00 / 아침브리핑 08:00 / 미국스캔 07:00 KST, 매크로 6시간)');
}
