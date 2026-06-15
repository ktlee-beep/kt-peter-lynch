// KT Trading — 스케줄 작업 (node-cron)
// 매일 17:00 KST (UTC 08:00) — 전체 종목 스캔
// 6시간마다 — 매크로 갱신
import cron from 'node-cron';
import { calcRSI, calcMA, calcBollinger, calcMACD, calcLynchScore, calcLivermoreScore, calcPiotroski } from './analysis.js';
import { getFundamentalsCache, setFundamentalsCache, createScanBatch, updateScanBatch, completeScanBatch, batchSaveAnalysis, saveMacroSnapshot, getActiveStocks, getSupabase, getScanResults, saveMorningBrief, loadCorpCodeMap, upsertCorpCodes, getDartCache, setDartCache, saveUsScan } from './db.js';
import { KS_UNIVERSE, KQ_UNIVERSE, fetchNaverFundamentals, fetchKospiFutures, CORP_MAP, fetchCorpCodeMap, fetchDartFinancials, US_UNIVERSE, fetchUsStockDaily } from './data.js';

// ── 스캔 유니버스 (DB에 종목이 없으면 하드코딩된 유니버스 사용) ─
function getScanUniverse() {
  return [
    ...KS_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KS' })),
    ...KQ_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KQ' })),
  ];
}

// ── 경량 종목 분석 (Naver 일봉 기반) ────────────────────────────
// corpResolver(code)→corp_code, dartKey: DART 재무로 진짜 Piotroski 산출
async function analyzeStockLean(code, corpResolver = null, dartKey = '') {
  try {
    const naverUrl = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=120&requestType=0`;
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
    const high52w = Math.max(...closes.slice(-125));
    const near52wHigh = cur > 0 && high52w > 0 ? (cur / high52w) >= 0.95 : false;

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

    // 펀더멘털: 캐시 우선, 없으면 Naver에서 수집 후 캐시 (스크리너 PER/PBR/ROE 필터 데이터원)
    let fundamentals = await getFundamentalsCache(code).catch(() => null);
    if (!fundamentals) {
      fundamentals = await fetchNaverFundamentals(code).catch(() => null);
      if (fundamentals) await setFundamentalsCache(code, fundamentals).catch(() => {});
    }

    // DART 재무: 90일 캐시 우선 → 진짜 Piotroski F-Score 입력 (분기 데이터)
    let dart = await getDartCache(code).catch(() => undefined);
    if (dart === undefined) {
      const corp = corpResolver ? corpResolver(code) : null;
      dart = (corp && dartKey) ? await fetchDartFinancials(corp, dartKey).catch(() => null) : null;
      await setDartCache(code, dart).catch(() => {});
    }
    const fScore = calcPiotroski(dart, fundamentals);

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
      ma5, ma20, ma60, near52wHigh,
      combinedSignal: { signal, confidence, buyPts, sellPts },
      pScore,
      lScore,
      fScore,       // 진짜 Piotroski (DART 통합) — 기존 null에서 실제 산출로 교체
      dart,         // 스크리너/리포트에서 매출성장·영업이익률 활용
      fundamentals, // 스크리너 PER/PBR/ROE 필터용
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
  const high52 = Math.max(...closes.slice(-125));
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
