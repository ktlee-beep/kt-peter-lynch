// KT Trading — 스케줄 작업 (node-cron)
// 매일 17:00 KST (UTC 08:00) — 전체 종목 스캔
// 6시간마다 — 매크로 갱신
import cron from 'node-cron';
import { calcRSI, calcMA, calcBollinger, calcMACD } from './analysis.js';
import { getFundamentalsCache, createScanBatch, updateScanBatch, completeScanBatch, batchSaveAnalysis, saveMacroSnapshot, getActiveStocks, getSupabase } from './db.js';
import { KS_UNIVERSE, KQ_UNIVERSE } from './data.js';

// ── 스캔 유니버스 (DB에 종목이 없으면 하드코딩된 유니버스 사용) ─
function getScanUniverse() {
  return [
    ...KS_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KS' })),
    ...KQ_UNIVERSE.map(code => ({ code, yahoo_suffix: 'KQ' })),
  ];
}

// ── 경량 종목 분석 (Naver 일봉 기반) ────────────────────────────
async function analyzeStockLean(code) {
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

    const fundamentals = await getFundamentalsCache(code).catch(() => null);
    const pScore = fundamentals ? calcLynchScoreSimple(fundamentals) : 0;

    return {
      code, close: cur, changeRate, volRatio, rsi: rsiVal, source: 'naver',
      macd: macdVal, bb,
      ma5, ma20, ma60, near52wHigh,
      combinedSignal: { signal, confidence, buyPts, sellPts },
      pScore,
      lScore: 0,
      fScore: null,
    };
  } catch {
    return null;
  }
}

function calcLynchScoreSimple(fund) {
  let score = 0;
  if (fund.peg !== null && fund.peg < 1)          score += 15;
  if (fund.roe !== null && fund.roe > 10)          score += 10;
  if (fund.per !== null && fund.per < 20)          score += 10;
  if (fund.pbr !== null && fund.pbr < 3)           score += 5;
  if (fund.revenueGrowth !== null && fund.revenueGrowth > 10) score += 10;
  return Math.min(score, 100);
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

  const batchId = `${today}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await createScanBatch(batchId, stocks.length);
  } catch {}

  const CHUNK_SIZE = 30;
  let totalProcessed = 0, totalFailed = 0, totalBuy = 0;

  for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
    const chunk = stocks.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map(({ code }) => analyzeStockLean(code)));

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
        piotroski_score: 0,
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

  console.log('[Cron] 스케줄 등록 완료 (스캔: 매 영업일 20:00 KST, 매크로: 6시간마다)');
}
