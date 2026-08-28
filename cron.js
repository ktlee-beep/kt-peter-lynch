// KT Trading — 스케줄 작업 (node-cron)
// 매일 17:00 KST (UTC 08:00) — 전체 종목 스캔
// 6시간마다 — 매크로 갱신
import cron from 'node-cron';
import { calcRSI, calcMA, calcBollinger, calcMACD, calcLynchScore, calcLivermoreScore, calcPiotroski, calcGrowthStreak, hasNoLoss, calcTTM } from './analysis.js';
import { getFundamentalsCache, setFundamentalsCache, createScanBatch, updateScanBatch, completeScanBatch, batchSaveAnalysis, saveMacroSnapshot, getActiveStocks, getSupabase, getScanResults, saveMorningBrief, loadCorpCodeMap, upsertCorpCodes, getDartCache, setDartCache, saveUsScan, getCompanyInfoCache, setCompanyInfoCache, getMultiYearCache, setMultiYearCache, getQuarterlyCache, setQuarterlyCache, countKvPrefix, listFreshKvCodes } from './db.js';
import { KS_UNIVERSE, KQ_UNIVERSE, fetchNaverFundamentals, fetchKospiFutures, CORP_MAP, fetchCorpCodeMap, fetchDartFinancials, US_UNIVERSE, fetchUsStockDaily, fetchDartCompanyInfo, fetchDartMultiYear, fetchDartQuarterly, hasYearData } from './data.js';

const FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000; // PER/PBR/ROE는 주가 연동 — 1거래일 이상 지나면 재수집

// ── 스캔 유니버스 (DB에 종목이 없으면 하드코딩된 유니버스 사용) ─
function getScanUniverse() {
  return [
    ...KS_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KS' })),
    ...KQ_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KQ' })),
  ];
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

// ── 경량 종목 분석 (Naver 일봉 기반) ────────────────────────────
// corpResolver(code)→corp_code, dartKey: DART 재무로 진짜 Piotroski 산출
async function analyzeStockLean(code, corpResolver = null, dartKey = '') {
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
    const [company, multiYear, quarterly] = await Promise.all([
      getCompanyInfoCache(code).catch(() => undefined),
      getMultiYearCache(code).catch(() => undefined),
      getQuarterlyCache(code).catch(() => undefined),
    ]);
    const growth = buildGrowthProfile(multiYear, quarterly);

    const { pScore } = calcLynchScore(
      cur, ma5, ma20, ma60, rsiVal ?? 50, volRatio ?? 1, changeRate, dart, fundamentals,
    );
    const { lScore } = calcLivermoreScore(
      cur, ma5, ma20, ma60, rsiVal ?? 50, volRatio ?? 1, changeRate, high52w,
      macdVal?.lastCross ?? null, bb,
    );

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
      // 아래 3종은 analysis_json에 실려 저장된다 — 별도 컬럼 추가(DDL) 없이 스크리너가 소비한다.
      growth,       // 박세익 축: 연속성장 스트릭·무적자·TTM
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
    const active = await getActiveStocks().catch(() => []);
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

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const chunkCost = chunk.reduce((s, p) => s + p.cost, 0);
    if (calls + chunkCost > maxDartCalls) { stoppedBy = 'quota'; break; }
    calls += chunkCost;

    const res = await Promise.allSettled(chunk.map(p => backfillOne(p, corpResolver, dartKey)));
    for (const r of res) {
      if (r.status === 'fulfilled' && r.value && !r.value.empty) done++;
      else empty++;
    }

    if ((i / CHUNK) % 25 === 0) {
      console.log(`[Backfill] ${i + chunk.length}/${pending.length} — 적재 ${done}, 무자료 ${empty}, 호출 ${calls}/${maxDartCalls}`);
    }
    await new Promise(r => setTimeout(r, 300)); // DART 과부하 방지
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
  try {
    stocks = await getActiveStocks();
  } catch {
    stocks = [];
  }
  if (!stocks.length) stocks = getScanUniverse();

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

  const batchId = `${today}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await createScanBatch(batchId, stocks.length);
  } catch {}

  const CHUNK_SIZE = 30;
  let totalProcessed = 0, totalFailed = 0, totalBuy = 0;

  for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
    const chunk = stocks.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map(({ code }) => analyzeStockLean(code, corpResolver, dartKey)));

    const rows = [];
    let chunkBuy = 0, chunkFail = 0;

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'rejected' || !r.value) { chunkFail++; continue; }
      const a = r.value;
      const signal = a.combinedSignal?.signal ?? 'HOLD';
      if (signal === 'BUY') chunkBuy++;
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
  console.log(`[Cron] 스캔 완료 — 처리: ${totalProcessed}, 실패: ${totalFailed}, BUY: ${totalBuy}`);

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

// ── cron 등록 ────────────────────────────────────────────────────
export function startCron() {
  // 매 영업일 20:00 KST = UTC 11:00
  cron.schedule('0 11 * * 1-5', async () => {
    await runDailyScan().catch(e => console.error('[Cron] 스캔 오류:', e));
    await evaluateAlertSettings().catch(e => console.error('[Cron] 알림 평가 오류:', e));
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
