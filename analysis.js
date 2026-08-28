// KT Trading — 기술 지표 계산 (순수 함수, 외부 의존 없음)

export function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  result[period - 1] = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

export function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => (v != null && ema26[i] != null) ? v - ema26[i] : null);
  const validIdx = macdLine.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
  const validVals = validIdx.map(i => macdLine[i]);
  const ema9 = calcEMA(validVals, 9);
  const signalLine = new Array(closes.length).fill(null);
  validIdx.forEach((origI, j) => { signalLine[origI] = ema9[j]; });
  const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  let lastCross = null;
  for (let i = macdLine.length - 1; i >= 1; i--) {
    const m = macdLine[i], mP = macdLine[i-1], s = signalLine[i], sP = signalLine[i-1];
    if (m != null && mP != null && s != null && sP != null) {
      if (m > s && mP <= sP) { lastCross = 'golden'; break; }
      if (m < s && mP >= sP) { lastCross = 'dead';   break; }
    }
  }
  return {
    macdArr:    macdLine.slice(-30),
    signalArr:  signalLine.slice(-30),
    histArr:    histogram.slice(-30),
    lastMacd:   macdLine.at(-1),
    lastSignal: signalLine.at(-1),
    lastHist:   histogram.at(-1),
    lastCross,
  };
}

export function calcBollinger(closes, period = 20, mult = 2) {
  const last = closes.slice(-period);
  if (last.length < period) return null;
  const mean = last.reduce((s, v) => s + v, 0) / period;
  const variance = last.reduce((s, v) => s + (v - mean) ** 2, 0) / (period - 1); // 표본분산(N-1) — John Bollinger 원본 공식
  const std = Math.sqrt(variance);
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const cur = closes.at(-1);
  const bandwidth = std > 0 ? (upper - lower) / mean * 100 : 0;
  const percentB  = (upper - lower) > 0 ? (cur - lower) / (upper - lower) * 100 : 50;
  return { upper, middle: mean, lower, bandwidth, percentB };
}

export function calcATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

export function calcMDD(closes) {
  let peak = closes[0], maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

export function findKeyLevels(closes, volumes = []) {
  const n = closes.length;
  if (n < 10) return { support: null, resistance: null, keyLevels: { supports: [], resistances: [] } };
  const cur = closes.at(-1);
  const avgVol = volumes.length
    ? volumes.slice(-60).reduce((s, v) => s + (v || 0), 0) / Math.min(60, volumes.length)
    : 1;
  const swingHighs = [], swingLows = [];
  for (const lb of [3, 5, 8, 13]) {
    for (let i = lb; i < n - lb; i++) {
      const sl = closes.slice(i - lb, i + lb + 1);
      const volBonus = volumes[i] > avgVol * 1.5 ? 1.5 : 1;
      const recency  = 0.5 + (i / n) * 0.5;
      if (closes[i] === Math.min(...sl)) swingLows.push({ price: closes[i],  s: volBonus * recency });
      if (closes[i] === Math.max(...sl)) swingHighs.push({ price: closes[i], s: volBonus * recency });
    }
  }
  function cluster(pts) {
    if (!pts.length) return [];
    pts.sort((a, b) => a.price - b.price);
    const groups = [];
    let g = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].price / g[0].price - 1 < 0.02) g.push(pts[i]);
      else { groups.push(g); g = [pts[i]]; }
    }
    groups.push(g);
    return groups.map(grp => ({
      price:    Math.round(grp.reduce((s, p) => s + p.price, 0) / grp.length),
      strength: grp.length,
      score:    grp.reduce((s, p) => s + p.s, 0),
    })).sort((a, b) => b.score - a.score);
  }
  const suppC = cluster(swingLows.filter(p  => p.price < cur * 0.995));
  const resiC = cluster(swingHighs.filter(p => p.price > cur * 1.005));
  const nearSupp = suppC.filter(c => c.price > cur * 0.80).sort((a, b) => b.price - a.price);
  const nearResi = resiC.filter(c => c.price < cur * 1.25).sort((a, b) => a.price - b.price);
  return {
    support:    nearSupp[0]?.price || null,
    resistance: nearResi[0]?.price || null,
    keyLevels: {
      supports:    nearSupp.slice(0, 3).map(c => ({ price: c.price, strength: c.strength })),
      resistances: nearResi.slice(0, 3).map(c => ({ price: c.price, strength: c.strength })),
    },
  };
}

export function detectFreshSignals(closes, ma5arr, ma20arr, ma60arr, volumes) {
  const n = closes.length;
  if (n < 12) return {};
  // Array.at()으로 음수 인덱스 정상 처리 (arr[-1] = undefined → arr.at(-1) = 마지막 요소)
  const m5  = v => ma5arr.at(v)  ?? null;
  const m20 = v => ma20arr.at(v) ?? null;
  const m60 = v => ma60arr.at(v) ?? null;
  const c   = v => closes.at(v)  ?? null;
  const curAligned = m5(-1) > m20(-1) && m20(-1) > m60(-1);
  const oldAligned = m5(-8) != null && m5(-8) > m20(-8) && m20(-8) > m60(-8);
  const freshAlignment = curAligned && !oldAligned;
  const aboveMa60now  = c(-1) > m60(-1);
  const belowMa60prev = m60(-6) != null && c(-6) < m60(-6);
  const freshMa60Break = aboveMa60now && belowMa60prev;
  const aboveMa20now  = c(-1) > m20(-1);
  const belowMa20prev = m20(-4) != null && c(-4) < m20(-4);
  const freshMa20Break = aboveMa20now && belowMa20prev;
  const lastVols = volumes.slice(-21, -1);
  const avgVol   = lastVols.reduce((s, v) => s + v, 0) / (lastVols.length || 1);
  const todayVol = volumes.at(-1) || 0;
  const freshVolumeSpike = avgVol > 0 && todayVol / avgVol >= 2.5;
  const freshnessScore =
    (freshAlignment   ? 3 : 0) +
    (freshMa60Break   ? 2 : 0) +
    (freshMa20Break   ? 1 : 0) +
    (freshVolumeSpike ? 2 : 0);
  return { freshAlignment, freshMa60Break, freshMa20Break, freshVolumeSpike, freshnessScore };
}

export function combinedSignal(lScore, pScore, macdCross, bb, extras = {}, adx = null) {
  const avg = (lScore + pScore) / 2;
  const { ichimoku, stochastic, obv, candlePatterns = [], rsiDivergence, williamsR } = extras;
  const buyPoints = [
    avg >= 65,
    lScore >= 60,
    pScore >= 60,
    macdCross === 'golden',
    bb && bb.percentB < 20,
    ichimoku?.priceVsCloud === 'above',
    ichimoku?.tkKjCross === 'golden',
    stochastic?.signal === 'oversold' || stochastic?.signal === 'bullish_cross',
    obv?.trend === 'accumulating',
    candlePatterns.some(p => p.signal === 'bullish'),
    rsiDivergence?.bullish === true,
    williamsR?.signal === 'oversold',
  ].filter(Boolean).length;
  const sellPoints = [
    avg < 35,
    lScore < 30,
    macdCross === 'dead',
    bb && bb.percentB > 85,
    ichimoku?.priceVsCloud === 'below',
    ichimoku?.tkKjCross === 'dead',
    stochastic?.signal === 'overbought' || stochastic?.signal === 'bearish_cross',
    obv?.trend === 'distributing',
    candlePatterns.some(p => p.signal === 'bearish'),
    rsiDivergence?.bearish === true,
  ].filter(Boolean).length;
  let signal = 'HOLD', confidence = 0;
  if (buyPoints >= 4)  { signal = 'BUY';  confidence = Math.min(95, Math.round(40 + buyPoints * 4.5)); }
  else if (sellPoints >= 4) { signal = 'SELL'; confidence = Math.min(95, Math.round(35 + sellPoints * 5)); } // 매수와 동일 기준(4점)으로 대칭
  else { confidence = Math.round(avg); }
  if (adx !== null) {
    if (adx.adx < 20) confidence = Math.round(confidence * 0.7);
    else if (adx.adx >= 50) confidence = Math.min(100, Math.round(confidence * 1.15));
    if (signal === 'BUY'  && adx.direction === 'down' && adx.adx > 25) confidence = Math.round(confidence * 0.8);
    if (signal === 'SELL' && adx.direction === 'up'   && adx.adx > 25) confidence = Math.round(confidence * 0.8);
  }
  return { signal, confidence, buyPoints, sellPoints, totalBuyCriteria: 12, totalSellCriteria: 10 };
}

export function calcMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const sl = closes.slice(i - period + 1, i + 1).filter(v => v != null);
    return sl.length < period ? null : sl.reduce((s, v) => s + v, 0) / period;
  });
}

// Wilder EMA 방식 RSI (업계 표준: TradingView, Bloomberg, Naver 동일)
export function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function calcScore(close, ma5, ma20, ma60, rsi, volRatio, change) {
  let score = 0;
  const reasons = [];
  if (rsi >= 50 && rsi <= 65)      { score += 25; reasons.push(`RSI ${rsi.toFixed(0)} 건강 +25`); }
  else if (rsi > 65 && rsi <= 75)  { score += 15; reasons.push(`RSI ${rsi.toFixed(0)} 강세 +15`); }
  else if (rsi > 80)               { score -= 20; reasons.push(`RSI ${rsi.toFixed(0)} 과열 -20`); }
  else if (rsi < 40)               { score += 10; reasons.push(`RSI ${rsi.toFixed(0)} 저점 +10`); }
  if (ma5 > ma20 && ma20 > ma60)   { score += 25; reasons.push('정배열 +25'); }
  else if (ma5 < ma20)             { score -= 10; reasons.push('5일선 이탈 -10'); }
  const dev = (close / ma20 - 1) * 100;
  if (dev >= 3 && dev <= 15)       { score += 20; reasons.push(`이격 ${dev.toFixed(1)}% 적정 +20`); }
  else if (dev > 30)               { score -= 25; reasons.push(`이격 ${dev.toFixed(1)}% 과열 -25`); }
  else if (dev > 15)               { score -= 5;  reasons.push(`이격 ${dev.toFixed(1)}% 주의 -5`); }
  if (volRatio >= 5)               { score += 20; reasons.push(`거래량 ${volRatio.toFixed(1)}배 +20`); }
  else if (volRatio >= 3)          { score += 15; reasons.push(`거래량 ${volRatio.toFixed(1)}배 +15`); }
  else if (volRatio >= 2)          { score += 10; reasons.push(`거래량 ${volRatio.toFixed(1)}배 +10`); }
  if (change >= 5 && change <= 15) { score += 15; reasons.push(`등락 +${change.toFixed(1)}% +15`); }
  else if (change > 15 && change <= 25) { score += 5; }
  else if (change > 25)            { score -= 5; }
  const grade = score >= 90 ? '🏆 추천' : score >= 70 ? '🟢 후보' : score >= 50 ? '🟡 관찰'
              : score >= 30 ? '🟠 보류' : score >= 0  ? '🔴 위험' : '❌ 제외';
  return { score, grade, reasons };
}

export function calcLivermoreScore(close, ma5, ma20, ma60, rsi, volRatio, changeRate, high52w, macdCross = null, bb = null) {
  let score = 0; const r = [];
  if (ma5 > ma20 && ma20 > ma60)    { score += 30; r.push('정배열'); }
  else if (ma5 < ma20 && ma20 < ma60){ score -= 20; r.push('역배열'); }
  else if (ma5 < ma20)              { score -= 10; r.push('5MA이탈'); }
  if (high52w > 0) {
    const pos = (close / high52w) * 100;
    if (pos >= 95)       { score += 25; r.push(`신고가${pos.toFixed(0)}%`); }
    else if (pos >= 85)  { score += 15; r.push(`고점근접${pos.toFixed(0)}%`); }
    else if (pos >= 70)  { score += 5;  r.push(`고점회복`); }
  }
  if (rsi >= 55 && rsi <= 72)       { score += 20; r.push(`RSI강세${rsi.toFixed(0)}`); }
  else if (rsi > 72 && rsi <= 82)   { score += 8;  r.push(`RSI고점${rsi.toFixed(0)}`); }
  else if (rsi > 82)                { score -= 15; r.push(`RSI과열`); }
  else if (rsi < 40)                { score -= 15; r.push(`RSI약세`); }
  if (volRatio >= 4)                { score += 20; r.push(`거래량${volRatio.toFixed(1)}x`); }
  else if (volRatio >= 2.5)         { score += 12; r.push(`거래량${volRatio.toFixed(1)}x`); }
  else if (volRatio >= 1.5)         { score += 5;  r.push(`거래량증가`); }
  else if (volRatio < 0.5)          { score -= 10; r.push(`거래량부족`); }
  if (changeRate >= 3 && changeRate <= 10) { score += 10; r.push(`당일+${changeRate.toFixed(1)}%`); }
  else if (changeRate > 10)         { score += 5;  r.push(`급등`); }
  else if (changeRate <= -3)        { score -= 10; r.push(`당일하락`); }
  if (macdCross === 'golden')       { score += 12; r.push('MACD골든크로스'); }
  else if (macdCross === 'dead')    { score -= 12; r.push('MACD데드크로스'); }
  if (bb) {
    if (bb.percentB < 10)           { score += 8;  r.push(`BB하단돌파`); }
    else if (bb.percentB > 90)      { score -= 8;  r.push(`BB상단돌파`); }
  }
  const lGrade = score >= 70 ? '🏆 추천' : score >= 50 ? '🟢 후보' : score >= 30 ? '🟡 관찰' : '🔴 제외';
  return { lScore: Math.max(0, Math.min(100, score)), lGrade, lReasons: r };
}

export function calcLynchScore(close, ma5, ma20, ma60, rsi, volRatio, changeRate, dart = null, fundamentals = null) {
  let score = 0; const r = [];
  const dev = ma20 > 0 ? (close / ma20 - 1) * 100 : 0;
  if (dev >= -5 && dev <= 12)       { score += 25; r.push(`적정가격`); }
  else if (dev > 12 && dev <= 22)   { score += 10; r.push(`소폭고평가`); }
  else if (dev > 22)                { score -= 20; r.push(`과열`); }
  else if (dev < -15)               { score -= 10; r.push(`급락중`); }
  if (rsi >= 40 && rsi <= 62)       { score += 25; r.push(`RSI건강${rsi.toFixed(0)}`); }
  else if (rsi > 62 && rsi <= 72)   { score += 12; r.push(`RSI강세`); }
  else if (rsi > 72)                { score -= 12; r.push(`RSI과열`); }
  else if (rsi < 30)                { score += 15; r.push(`RSI저점매수`); }
  if (ma5 > ma20)                   { score += 15; r.push(`중기상승`); }
  else                              { score -= 8;  r.push(`중기조정`); }
  if (close > ma60)                 { score += 20; r.push(`장기상승`); }
  else                              { score -= 10; r.push(`장기선이탈`); }
  if (volRatio >= 0.8 && volRatio <= 2.0) { score += 15; r.push(`거래량안정`); }
  else if (volRatio > 2.0 && volRatio <= 3.5){ score += 8; r.push(`거래량증가`); }
  else if (volRatio > 3.5)          { score -= 5;  r.push(`거래량투기성`); }
  const revGrowth = dart?.revenueGrowth ?? fundamentals?.revenueGrowth ?? null;
  if (revGrowth != null) {
    if (revGrowth >= 30)       { score += 20; r.push(`매출+${revGrowth.toFixed(0)}%`); }
    else if (revGrowth >= 15)  { score += 12; r.push(`매출+${revGrowth.toFixed(0)}%`); }
    else if (revGrowth >= 5)   { score += 5;  r.push(`매출+${revGrowth.toFixed(0)}%`); }
    else if (revGrowth < -5)   { score -= 12; r.push(`매출감소`); }
  }
  const opMgn = dart?.opMargin ?? fundamentals?.opMargin ?? null;
  if (opMgn != null) {
    if (opMgn >= 20)           { score += 10; r.push(`영업익${opMgn.toFixed(0)}%`); }
    else if (opMgn >= 10)      { score += 6;  r.push(`영업익${opMgn.toFixed(0)}%`); }
    else if (opMgn >= 0)       { score += 2;  r.push(`영업흑자`); }
    else                       { score -= 10; r.push(`영업적자`); }
  }
  if (fundamentals?.peg != null) {
    const peg = fundamentals.peg;
    if      (peg > 0 && peg < 0.5) { score += 25; r.push(`PEG${peg.toFixed(1)}최고`); }
    else if (peg > 0 && peg < 1.0) { score += 15; r.push(`PEG${peg.toFixed(1)}매력`); }  // 음수PEG(적자기업) 가산 방지
    else if (peg > 0 && peg < 1.5) { score += 5;  r.push(`PEG${peg.toFixed(1)}보통`); }
    else if (peg <= 0)              { score -= 15; r.push(`PEG음수(적자/역성장)`); }       // 적자기업 패널티
    else if (peg > 2.5)             { score -= 10; r.push(`PEG${peg.toFixed(1)}비쌈`); }
  }
  if (fundamentals?.roe != null && fundamentals.roe > 15) { score += 5; r.push(`ROE${fundamentals.roe.toFixed(0)}%`); }
  if (fundamentals?.debtToEquity != null && fundamentals.debtToEquity < 50) { score += 3; r.push(`저부채`); }
  if (dart?.opGrowth != null && dart.opGrowth >= 25) { score += 3; r.push(`이익성장`); }
  const pGrade = score >= 70 ? '🏆 추천' : score >= 50 ? '🟢 후보' : score >= 30 ? '🟡 관찰' : '🔴 제외';
  return { pScore: Math.max(0, Math.min(100, score)), pGrade, pReasons: r };
}

export function calcCandlePatterns(opens, highs, lows, closes) {
  const n = closes.length;
  const patterns = [];
  if (n < 3) return patterns;
  const body  = (i) => Math.abs(closes[i] - opens[i]);
  const range = (i) => highs[i] - lows[i];
  const upper = (i) => highs[i] - Math.max(opens[i], closes[i]);
  const lower = (i) => Math.min(opens[i], closes[i]) - lows[i];
  const isGrn = (i) => closes[i] >= opens[i];
  const i = n - 1;
  const b = body(i), r = range(i), u = upper(i), l = lower(i);
  if (r > 0 && b / r < 0.1) {
    patterns.push({ name:'도지', nameEn:'Doji', signal:'neutral', desc:'매수·매도 세력 균형 — 추세 전환 신호. 다음 봉으로 방향 확인 필요.' });
  }
  if (n >= 6 && isGrn(i) && l >= b * 1.8 && u <= b * 0.3) {
    const p5 = closes.slice(i - 5, i).reduce((s, v) => s + v, 0) / 5;
    if (closes[i] < p5 * 1.03) patterns.push({ name:'망치형', nameEn:'Hammer', signal:'bullish', desc:'강한 반등 신호 — 매수세가 하락 시도를 완전 흡수.' });
  }
  if (n >= 2 && !isGrn(i - 1) && u >= b * 1.8 && l <= b * 0.3) {
    patterns.push({ name:'역망치', nameEn:'Inverted Hammer', signal:'bullish', desc:'반등 가능성 — 위꼬리 길어 매수 시도 확인.' });
  }
  if (n >= 6 && !isGrn(i) && l >= b * 1.8 && u <= b * 0.3) {
    const p5 = closes.slice(i - 5, i).reduce((s, v) => s + v, 0) / 5;
    if (closes[i] > p5 * 0.97) patterns.push({ name:'교수형', nameEn:'Hanging Man', signal:'bearish', desc:'하락 반전 경고 — 상승 추세에서 매도세 등장.' });
  }
  if (!isGrn(i) && u >= b * 2 && l <= b * 0.2) {
    patterns.push({ name:'유성형', nameEn:'Shooting Star', signal:'bearish', desc:'강한 하락 반전 신호 — 갭상승 후 급락.' });
  }
  if (i >= 1) {
    const b1 = body(i - 1);
    if (!isGrn(i - 1) && isGrn(i) && opens[i] < closes[i - 1] && closes[i] > opens[i - 1] && b > b1) {
      patterns.push({ name:'상승잉걸핑', nameEn:'Bullish Engulfing', signal:'bullish', desc:'강한 반전 신호 — 전날 음봉 완전 흡수.' });
    }
    if (isGrn(i - 1) && !isGrn(i) && opens[i] > closes[i - 1] && closes[i] < opens[i - 1] && b > b1) {
      patterns.push({ name:'하락잉걸핑', nameEn:'Bearish Engulfing', signal:'bearish', desc:'강한 하락 반전 — 전날 양봉 완전 흡수.' });
    }
    if (!isGrn(i - 1) && isGrn(i) && opens[i] < lows[i - 1] && closes[i] > (opens[i - 1] + closes[i - 1]) / 2) {
      patterns.push({ name:'관통형', nameEn:'Piercing Line', signal:'bullish', desc:'반등 신호 — 갭하락 후 전날 봉 중점 이상 회복.' });
    }
    if (isGrn(i - 1) && !isGrn(i) && opens[i] > highs[i - 1] && closes[i] < (opens[i - 1] + closes[i - 1]) / 2) {
      patterns.push({ name:'먹구름형', nameEn:'Dark Cloud Cover', signal:'bearish', desc:'하락 반전 신호 — 갭상승 후 전날 봉 중점 이하 마감.' });
    }
    if (!isGrn(i - 1) && isGrn(i) && b1 > b * 2.5 && opens[i] > closes[i - 1] && closes[i] < opens[i - 1]) {
      patterns.push({ name:'상승하라미', nameEn:'Bullish Harami', signal:'bullish', desc:'하락 추세 약화 — 전날 큰 음봉 안에 오늘 봉이 포함.' });
    }
  }
  if (i >= 2) {
    const b0 = body(i - 2), b1 = body(i - 1), b2 = body(i);
    if (!isGrn(i - 2) && b0 > 0 && b1 < b0 * 0.35 && isGrn(i) && b2 > b0 * 0.45 &&
        closes[i] > (opens[i - 2] + closes[i - 2]) / 2) {
      patterns.push({ name:'샛별형', nameEn:'Morning Star', signal:'bullish', desc:'강한 반등 신호 (3봉 완성) — 진입 적극 고려.' });
    }
    if (isGrn(i - 2) && b0 > 0 && b1 < b0 * 0.35 && !isGrn(i) && b2 > b0 * 0.45 &&
        closes[i] < (opens[i - 2] + closes[i - 2]) / 2) {
      patterns.push({ name:'저녁별형', nameEn:'Evening Star', signal:'bearish', desc:'강한 하락 반전 (3봉 완성) — 익절·손절 검토.' });
    }
    if (isGrn(i) && isGrn(i - 1) && isGrn(i - 2) &&
        closes[i] > closes[i - 1] && closes[i - 1] > closes[i - 2] &&
        opens[i] > opens[i - 1] && opens[i - 1] > opens[i - 2]) {
      patterns.push({ name:'세백색병사', nameEn:'Three White Soldiers', signal:'bullish', desc:'3연속 강한 양봉 — 추세 전환 고신뢰 패턴.' });
    }
    if (!isGrn(i) && !isGrn(i - 1) && !isGrn(i - 2) &&
        closes[i] < closes[i - 1] && closes[i - 1] < closes[i - 2] &&
        opens[i] < opens[i - 1] && opens[i - 1] < opens[i - 2]) {
      patterns.push({ name:'세흑색까마귀', nameEn:'Three Black Crows', signal:'bearish', desc:'3연속 강한 음봉 — 하락 전환 고신뢰 패턴.' });
    }
  }
  return patterns;
}

export function calcIchimoku(highs, lows, closes) {
  const n = closes.length;
  if (n < 52) return null;
  const mid = (a, b, s, len) => {
    const h = a.slice(s, s + len), l = b.slice(s, s + len);
    return (Math.max(...h) + Math.min(...l)) / 2;
  };
  const tenkan = closes.map((_, i) => i < 8  ? null : mid(highs, lows, i - 8,  9));
  const kijun  = closes.map((_, i) => i < 25 ? null : mid(highs, lows, i - 25, 26));
  const spanA  = tenkan.map((t, i) => (t != null && kijun[i] != null) ? (t + kijun[i]) / 2 : null);
  const spanB  = closes.map((_, i) => i < 51 ? null : mid(highs, lows, i - 51, 52));
  const last = n - 1;
  const lastT = tenkan[last], lastK = kijun[last], lastSA = spanA[last], lastSB = spanB[last];
  const cur = closes[last];
  const cloudTop = Math.max(lastSA ?? 0, lastSB ?? 0);
  const cloudBot = Math.min(lastSA ?? Infinity, lastSB ?? Infinity);
  const priceVsCloud = cur > cloudTop ? 'above' : cur < cloudBot ? 'below' : 'inside';
  const cloudColor = (lastSA != null && lastSB != null) ? (lastSA >= lastSB ? 'bullish' : 'bearish') : 'neutral';
  let tkKjCross = 'none';
  if (lastT != null && lastK != null && tenkan[last-1] != null && kijun[last-1] != null) {
    if (lastT > lastK && tenkan[last-1] <= kijun[last-1]) tkKjCross = 'golden';
    else if (lastT < lastK && tenkan[last-1] >= kijun[last-1]) tkKjCross = 'dead';
  }
  const chikouVsPrice = n >= 27 ? (cur > closes[n - 27] ? 'above' : 'below') : null;
  return { tenkan: lastT, kijun: lastK, spanA: lastSA, spanB: lastSB, cloudColor, priceVsCloud, tkKjCross, chikouVsPrice };
}

export function calcStochastic(highs, lows, closes, kPer = 14, dPer = 3) {
  const n = closes.length;
  if (n < kPer + dPer) return null;
  const kArr = closes.map((c, i) => {
    if (i < kPer - 1) return null;
    const hh = Math.max(...highs.slice(i - kPer + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPer + 1, i + 1));
    return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
  });
  const dArr = kArr.map((_, i) => {
    const sl = kArr.slice(Math.max(0, i - dPer + 1), i + 1).filter(v => v != null);
    return sl.length < dPer ? null : sl.reduce((s, v) => s + v, 0) / sl.length;
  });
  const lastK = [...kArr].reverse().find(v => v != null);
  const lastD = [...dArr].reverse().find(v => v != null);
  const prevK = [...kArr.slice(0, -1)].reverse().find(v => v != null);
  const prevD = [...dArr.slice(0, -1)].reverse().find(v => v != null);
  let signal = 'neutral';
  if (lastK != null && lastD != null) {
    if (lastK < 20 && lastD < 20) signal = 'oversold';
    else if (lastK > 80 && lastD > 80) signal = 'overbought';
    if (prevK != null && prevD != null) {
      if (lastK > lastD && prevK <= prevD && lastK < 35) signal = 'bullish_cross';
      else if (lastK < lastD && prevK >= prevD && lastK > 65) signal = 'bearish_cross';
    }
  }
  return { k: lastK, d: lastD, signal };
}

export function calcOBV(closes, volumes) {
  // OBV는 배열 시작점부터의 누적합이라 입력 길이가 바뀌면 기준선이 통째로 이동한다.
  // trend 판정이 누적값의 비율 비교라서, 창을 고정하지 않으면 데이터 소스나 조회 기간을
  // 바꾸는 것만으로 accumulating/distributing이 뒤집힌다. 120봉으로 고정한다.
  const W = 120;
  const c = closes.slice(-W), vol = volumes.slice(-W);
  const obv = [0];
  for (let i = 1; i < c.length; i++) {
    const v = vol[i] || 0;
    if (c[i] > c[i - 1]) obv.push(obv[i - 1] + v);
    else if (c[i] < c[i - 1]) obv.push(obv[i - 1] - v);
    else obv.push(obv[i - 1]);
  }
  const m = obv.length;
  let trend = 'neutral';
  if (m >= 20) {
    const recent = obv.slice(-10).reduce((s, v) => s + v, 0) / 10;
    const prior  = obv.slice(-20, -10).reduce((s, v) => s + v, 0) / 10;
    if (recent > prior * 1.05) trend = 'accumulating';
    else if (recent < prior * 0.95) trend = 'distributing';
  }
  return { lastObv: obv.at(-1), trend };
}

export function calcFibonacci(closes, highs, lows, lookback = 60) {
  const rH = highs.slice(-lookback), rL = lows.slice(-lookback);
  if (!rH.length) return null;
  const high = Math.max(...rH), low = Math.min(...rL);
  const diff = high - low;
  if (diff === 0) return null;
  const cur = closes.at(-1);
  const levels = { r0: high, r236: high - diff * 0.236, r382: high - diff * 0.382, r500: high - diff * 0.5, r618: high - diff * 0.618, r786: high - diff * 0.786, r100: low };
  const pctMap = { r0:'0%', r236:'23.6%', r382:'38.2%', r500:'50%', r618:'61.8%', r786:'78.6%', r100:'100%' };
  let nearestKey = null, minDist = Infinity;
  for (const [k, v] of Object.entries(levels)) {
    const d = Math.abs(cur - v);
    if (d < minDist) { minDist = d; nearestKey = k; }
  }
  return { high, low, levels, nearestLevel: pctMap[nearestKey], distPct: (minDist / cur * 100).toFixed(2) };
}

export function detectRSIDivergence(closes, rsiArr, lookback = 20) {
  const n = closes.length;
  if (n < lookback + 5) return { bullish: false, bearish: false };
  const rc = closes.slice(-lookback), rr = rsiArr.slice(-lookback).filter(v => v != null);
  if (rr.length < Math.floor(lookback * 0.6)) return { bullish: false, bearish: false };
  const half = Math.floor(rc.length / 2), rHalf = Math.floor(rr.length / 2);
  const pMin1 = Math.min(...rc.slice(0, half)),  pMin2 = Math.min(...rc.slice(half));
  const pMax1 = Math.max(...rc.slice(0, half)),  pMax2 = Math.max(...rc.slice(half));
  const rMin1 = Math.min(...rr.slice(0, rHalf)), rMin2 = Math.min(...rr.slice(rHalf));
  const rMax1 = Math.max(...rr.slice(0, rHalf)), rMax2 = Math.max(...rr.slice(rHalf));
  return {
    bullish: pMin2 < pMin1 * 0.995 && rMin2 > rMin1 + 3,
    bearish: pMax2 > pMax1 * 1.005 && rMax2 < rMax1 - 3,
  };
}

export function calcWilliamsR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period) return null;
  const hh = Math.max(...highs.slice(n - period));
  const ll = Math.min(...lows.slice(n - period));
  const value = hh === ll ? -50 : ((hh - closes[n - 1]) / (hh - ll)) * -100;
  const signal = value > -20 ? 'overbought' : value < -80 ? 'oversold' : 'neutral';
  return { value, signal };
}

export function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2) return { adx: null, plusDI: null, minusDI: null, trend: 'unknown', direction: null };
  const trArr = [], pdmArr = [], mdmArr = [];
  for (let i = 1; i < n; i++) {
    trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
    pdmArr.push(up > dn && up > 0 ? up : 0);
    mdmArr.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr14 = trArr.slice(0, period).reduce((a,b) => a+b, 0);
  let pdm14 = pdmArr.slice(0, period).reduce((a,b) => a+b, 0);
  let mdm14 = mdmArr.slice(0, period).reduce((a,b) => a+b, 0);
  const dxArr = [];
  for (let i = period; i < trArr.length; i++) {
    atr14 = atr14 - atr14/period + trArr[i];
    pdm14 = pdm14 - pdm14/period + pdmArr[i];
    mdm14 = mdm14 - mdm14/period + mdmArr[i];
    const pdi = atr14 > 0 ? (pdm14/atr14)*100 : 0;
    const mdi = atr14 > 0 ? (mdm14/atr14)*100 : 0;
    const dx  = (pdi+mdi) > 0 ? Math.abs(pdi-mdi)/(pdi+mdi)*100 : 0;
    dxArr.push({ dx, pdi, mdi });
  }
  if (dxArr.length < period) return { adx: null, plusDI: null, minusDI: null, trend: 'unknown', direction: null };
  let adx = dxArr.slice(0, period).reduce((s,d) => s+d.dx, 0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx*(period-1) + dxArr[i].dx) / period;
  const last = dxArr[dxArr.length-1];
  return {
    adx: parseFloat(adx.toFixed(1)),
    plusDI: parseFloat(last.pdi.toFixed(1)),
    minusDI: parseFloat(last.mdi.toFixed(1)),
    trend: adx >= 50 ? 'strong' : adx >= 25 ? 'moderate' : 'weak',
    direction: last.pdi > last.mdi ? 'up' : 'down',
  };
}

export function calcMFI(highs, lows, closes, volumes, period = 14) {
  const n = closes.length;
  if (n < period + 1 || !volumes || volumes.length < n) return null;
  const tp = closes.map((c,i) => (highs[i]+lows[i]+c)/3);
  const mf = tp.map((t,i) => t*(volumes[i]||0));
  let pos = 0, neg = 0;
  for (let i = n-period; i < n; i++) {
    if (tp[i] > tp[i-1]) pos += mf[i];
    else neg += mf[i];
  }
  if (neg === 0) return 100;
  return parseFloat((100 - 100/(1 + pos/neg)).toFixed(1));
}

export function calcParabolicSAR(highs, lows, closes) {
  const n = closes.length;
  if (n < 3) return null;
  let bull = closes[1] > closes[0];
  let sar  = bull ? Math.min(lows[0], lows[1]) : Math.max(highs[0], highs[1]);
  let ep   = bull ? highs[1] : lows[1];
  let af   = 0.02;
  for (let i = 2; i < n; i++) {
    sar = sar + af*(ep - sar);
    if (bull) {
      sar = Math.min(sar, lows[i-1], i>=2 ? lows[i-2] : lows[i-1]);
      if (lows[i] < sar) { bull=false; sar=ep; ep=lows[i]; af=0.02; }
      else if (highs[i] > ep) { ep=highs[i]; af=Math.min(af+0.02,0.2); }
    } else {
      sar = Math.max(sar, highs[i-1], i>=2 ? highs[i-2] : highs[i-1]);
      if (highs[i] > sar) { bull=true; sar=ep; ep=highs[i]; af=0.02; }
      else if (lows[i] < ep) { ep=lows[i]; af=Math.min(af+0.02,0.2); }
    }
  }
  const cur = closes[n-1];
  return { sar: parseFloat(sar.toFixed(0)), bull: cur > sar, sarPct: parseFloat(((cur-sar)/cur*100).toFixed(2)) };
}

export function calcElderRay(highs, lows, closes, period = 13) {
  const n = closes.length;
  if (n < period) return null;
  const k = 2/(period+1);
  let ema = closes.slice(0,period).reduce((a,b)=>a+b)/period;
  for (let i = period; i < n; i++) ema = closes[i]*k + ema*(1-k);
  const bull = highs[n-1] - ema;
  const bear = lows[n-1]  - ema;
  return {
    bullPower: parseFloat(bull.toFixed(0)),
    bearPower: parseFloat(bear.toFixed(0)),
    signal: bull > 0 && bear > -Math.abs(bull*0.5) ? 'bullish' : bear < 0 && bull < Math.abs(bear*0.5) ? 'bearish' : 'neutral',
  };
}

export function calcDynamicStopLoss(closes, atr) {
  if (!atr || !closes || closes.length === 0) return null;
  const cur = closes[closes.length-1];
  const s1 = cur - atr*1.5, s2 = cur - atr*2.0, s3 = cur - atr*3.0;
  const pct = (p) => parseFloat(((p-cur)/cur*100).toFixed(2));
  return {
    tight:  { price: Math.round(s1), pct: pct(s1), label: '빠른 손절 (1.5×ATR)' },
    normal: { price: Math.round(s2), pct: pct(s2), label: '기본 손절 (2×ATR)'   },
    wide:   { price: Math.round(s3), pct: pct(s3), label: '여유 손절 (3×ATR)'   },
    atr: Math.round(atr), atrPct: parseFloat((atr/cur*100).toFixed(2)),
  };
}

// ── 박세익 기준 프리미티브 ─────────────────────────────────────────
// "3년 연속 매출·영업이익 성장, 3년간 적자 없음, 그런데 주가는 빠졌다"를 판정하기 위한 원자 함수들.
// 공통 원칙: 값이 없으면(null) 통과로 간주하지 않는다. 데이터 미확보와 기준 미달은 다른 상태다.

// 말미의 미발표 연도를 잘라낸다.
// fetchDartMultiYear는 [curYear-5 .. curYear-1]을 채우고 미확보 연도를 null로 패딩하는데,
// 사업보고서 제출기한은 사업연도 경과 후 90일(「자본시장과 금융투자업에 관한 법률」제159조)이라
// 매년 1~3월에는 직전 사업연도가 통째로 null이 된다. 이걸 "데이터 누락"으로 취급해 중단하면
// 스크리너가 매년 3개월간 전 종목 판정 불가가 되어 무증상으로 죽는다.
// 말미 null(아직 안 나온 미래)과 중간 null(진짜 누락)은 다른 상태다.
function trimTrailingNulls(series) {
  let end = series.length - 1;
  while (end >= 0 && series[end] == null) end--;
  return series.slice(0, end + 1);
}

// 연속 증가 연수. series는 과거→현재 순서(fetchDartMultiYear 반환 순서와 동일).
// comparable은 실제로 비교 가능했던 구간 수 — streak가 0일 때 "성장 안 함"인지
// "데이터가 없어서 못 셈"인지 구분하는 데 쓴다. 따라서 판정 불가로 이탈하는 경로에서는
// comparable을 올리면 안 된다(전년 0 등).
export function calcGrowthStreak(series) {
  if (!Array.isArray(series)) return { streak: 0, comparable: 0 };
  const s = trimTrailingNulls(series);
  if (s.length < 2) return { streak: 0, comparable: 0 };
  let streak = 0, comparable = 0;
  for (let i = s.length - 1; i > 0; i--) {
    const cur = s[i], prev = s[i - 1];
    if (cur == null || prev == null) break;   // 중간 미확보 구간에서 중단
    if (prev === 0) break;                    // 전년이 0이면 증감 판정 불가 — comparable 증가 없이 이탈.
                                              // toEok 반올림으로 5천만원 미만 영업이익은 0이 되므로
                                              // 소형주 흑자전환에서 실제로 밟는 경로다.
    comparable++;
    if (cur > prev) streak++;
    else break;
  }
  return { streak, comparable };
}

// 최근 n년 적자 없음. 데이터가 부족하면 false가 아니라 null(판정 불가)을 돌려준다.
// 주의: null은 falsy라 `if (hasNoLoss(x))`로 쓰면 "판정 불가"와 "적자 있음"이 같아진다.
// 호출부는 반드시 `=== true` / `=== false`로 명시 비교할 것.
export function hasNoLoss(series, years = 3) {
  if (!Array.isArray(series)) return null;
  if (!Number.isInteger(years) || years < 1) return null; // slice(-0)=전체 배열이라 조용히 오판정된다
  const tail = trimTrailingNulls(series).slice(-years);
  if (tail.length < years || tail.some(v => v == null)) return null;
  return tail.every(v => v > 0);
}

// TTM(최근 12개월) = 당기 누적 + 전년 연간 − 전년 동기 누적.
// 연간 실적만 쓰면 최대 15개월 묵은 숫자로 밸류에이션을 하게 된다.
//
// 연도를 함께 받아 기간 정합성을 강제한다. 1~4월에는 "가장 최신 분기"와 "가장 최신 연간"이
// 같은 연도가 될 수 있어서, 호출부가 소박하게 둘을 짝지으면 같은 해를 이중 계상한다.
// 단위는 호출부 책임 — fetchDartMultiYear/fetchDartQuarterly 출력(억원)끼리만 섞을 것.
// fetchDartFinancials.opProfit은 원 단위라 여기에 넣으면 1e8배 어긋난다.
export function calcTTM({ cum, cumYear, prevFullYear, prevFullYearOf, prevCum }) {
  if (cum == null || prevFullYear == null || prevCum == null) return null;
  if (!Number.isInteger(cumYear) || !Number.isInteger(prevFullYearOf)) return null;
  if (prevFullYearOf !== cumYear - 1) return null; // 기간 불일치 — 조용히 계산하면 안 된다
  return cum + prevFullYear - prevCum;
}

export function calcPiotroski(dart, fund) {
  let score = 0;
  const details = [];

  // 데이터가 없으면 항목을 건너뜀 (noData: true), 있으면 pass/fail 판정
  const chk = (val, testFn, text) => {
    if (val === null || val === undefined) {
      details.push({ text, pass: null, noData: true });
      return;
    }
    const pass = testFn(val);
    if (pass) { score++; details.push({ text, pass: true }); }
    else { details.push({ text, pass: false }); }
  };

  // 수익성 — DART 공시 기반 (금융사는 매출 대신 영업이익·순이익으로 평가)
  chk(dart?.opProfit,      v => v > 0,  '영업이익 흑자');
  chk(dart?.netGrowth,     v => v > 0,  '순이익 증가');
  chk(dart?.revenueGrowth, v => v > 0,  '매출 성장');
  chk(dart?.opGrowth,      v => v > 0,  '영업이익 증가');
  chk(dart?.opMargin,      v => v > 8,  '영업이익률 8% 이상');
  chk(dart?.revenueGrowth, v => v > 3,  '매출성장률 3% 이상');

  // 재무 비율 — Naver/Yahoo 기반 (ROE는 Naver 제공, 나머지는 Yahoo 전용)
  chk(fund?.roe,           v => v > 8,   'ROE 8% 이상');
  chk(fund?.roa,           v => v > 0,   'ROA 양수');
  chk(fund?.currentRatio,  v => v > 1,   '유동비율 > 1');
  chk(fund?.debtToEquity,  v => v < 100, '부채비율 양호');

  const available = details.filter(d => !d.noData).length;
  const pct = available > 0 ? score / available : 0;
  const grade = available === 0 ? '데이터 부족'
    : pct >= 0.85 ? 'A+ (최우량)'
    : pct >= 0.70 ? 'A (우량)'
    : pct >= 0.55 ? 'B (양호)'
    : pct >= 0.35 ? 'C (보통)'
    : 'D (취약)';
  return { score, available, total: details.length, grade, details, investable: available >= 4 && pct >= 0.65 };
}

export function runBacktest(closes) {
  if (!closes || closes.length < 50) return null;
  const signals = [];
  for (let i = 25; i < closes.length - 20; i++) {
    const slice = closes.slice(0, i + 1);
    const rsiArr = calcRSI(slice);
    const ma5Arr = calcMA(slice, 5);
    const ma20Arr = calcMA(slice, 20);
    const rsi = rsiArr[i], ma5 = ma5Arr[i], ma20 = ma20Arr[i];
    const prevMa5 = ma5Arr[i - 1], prevMa20 = ma20Arr[i - 1];
    if (rsi === null || ma5 === null || ma20 === null || prevMa5 === null || prevMa20 === null) continue;
    const goldenCross = prevMa5 <= prevMa20 && ma5 > ma20;
    const rsiBounce  = rsi > 25 && rsi < 45;
    if (goldenCross && rsiBounce) {
      const COST = 0.21; // 수수료 0.015%×2(매수+매도) + 거래세 0.18%
      signals.push({
        ret5:  closes[i + 5]  != null ? (closes[i + 5]  - closes[i]) / closes[i] * 100 - COST : null,
        ret10: closes[i + 10] != null ? (closes[i + 10] - closes[i]) / closes[i] * 100 - COST : null,
        ret20: closes[i + 20] != null ? (closes[i + 20] - closes[i]) / closes[i] * 100 - COST : null,
      });
    }
  }
  if (signals.length === 0) return { count: 0, note: '신호 없음' };
  const stats = (key) => {
    const vals = signals.map(s => s[key]).filter(v => v != null);
    if (!vals.length) return null;
    const wins = vals.filter(v => v > 0);
    return {
      count: vals.length,
      winRate: Math.round(wins.length / vals.length * 100),
      avgReturn: parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2)),
      maxWin: parseFloat(Math.max(...vals).toFixed(2)),
      maxLoss: parseFloat(Math.min(...vals).toFixed(2)),
    };
  };
  return {
    count: signals.length,
    period: `${closes.length}일`,
    days5: stats('ret5'), days10: stats('ret10'), days20: stats('ret20'),
    note: 'RSI<45 + MA5>MA20 골든크로스 조건',
  };
}

// 멀티 전략 백테스트 (3가지 전략 동시 비교)
export function runBacktestMulti(closes, highs, lows, volumes) {
  if (!closes || closes.length < 60) return null;

  const strategies = [
    { key: 'golden_rsi',   label: 'RSI반등+골든크로스',   desc: 'RSI<45 + MA5>MA20 크로스' },
    { key: 'bb_bounce',    label: 'BB하단반등',            desc: 'Bollinger %B<20 + RSI<40' },
    { key: 'alignment_vol',label: '정배열+거래량급등',     desc: 'MA5>MA20>MA60 + 거래량2배' },
  ];

  const calcEMALocal = (arr, p) => {
    const k = 2/(p+1); let e = arr[0];
    for (let i=1; i<arr.length; i++) e = arr[i]*k + e*(1-k);
    return e;
  };
  const calcMALocal = (arr, p, endIdx) => {
    const sl = arr.slice(Math.max(0, endIdx-p+1), endIdx+1);
    return sl.length < p ? null : sl.reduce((a,b)=>a+b,0)/sl.length;
  };
  const calcRSILocal = (arr, p=14, endIdx) => {
    if (endIdx < p) return null;
    let g=0, l=0;
    for (let j=endIdx-p+1; j<=endIdx; j++) {
      const d = arr[j]-arr[j-1]; if(d>0) g+=d; else l-=d;
    }
    return 100 - 100/(1+(l===0?100:g/l));
  };

  const results = {};
  for (const s of strategies) {
    const signals = [];
    for (let i=60; i<closes.length-10; i++) {
      const ma5  = calcMALocal(closes, 5, i),  pma5  = calcMALocal(closes, 5, i-1);
      const ma20 = calcMALocal(closes, 20, i), pma20 = calcMALocal(closes, 20, i-1);
      const ma60 = calcMALocal(closes, 60, i);
      const rsi  = calcRSILocal(closes, 14, i);
      if (!ma5||!ma20||!ma60||rsi===null) continue;

      let triggered = false;
      if (s.key === 'golden_rsi') {
        triggered = rsi < 45 && ma5 > ma20 && pma5 <= pma20;
      } else if (s.key === 'bb_bounce') {
        const last20 = closes.slice(i-19, i+1);
        const mean = last20.reduce((a,b)=>a+b,0)/20;
        const std  = Math.sqrt(last20.reduce((a,v)=>a+(v-mean)**2,0)/20);
        const lower = mean - 2*std;
        const pctB  = std>0 ? (closes[i]-lower)/((2*std*2)||1)*100 : 50;
        triggered = pctB < 20 && rsi < 40;
      } else if (s.key === 'alignment_vol') {
        const avgVol = volumes ? volumes.slice(Math.max(0,i-20),i).reduce((a,b)=>a+b,0)/20 : 0;
        const todayVol = volumes?.[i] || 0;
        triggered = ma5>ma20 && ma20>ma60 && pma5 && pma20 && !(pma5>pma20 && pma20>ma60) && avgVol>0 && todayVol/avgVol>=2;
      }

      if (triggered) {
        const COST = 0.21; // 수수료 0.015%×2 + 거래세 0.18%
        const ret5  = closes[i+5]  != null ? (closes[i+5]  - closes[i])/closes[i]*100 - COST : null;
        const ret10 = closes[i+10] != null ? (closes[i+10] - closes[i])/closes[i]*100 - COST : null;
        signals.push({ ret5, ret10 });
      }
    }

    const stats = (key) => {
      const vals = signals.map(s=>s[key]).filter(v=>v!=null);
      if (!vals.length) return null;
      const wins = vals.filter(v=>v>0);
      return {
        count:     vals.length,
        winRate:   Math.round(wins.length/vals.length*100),
        avgReturn: parseFloat((vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2)),
        maxWin:    parseFloat(Math.max(...vals).toFixed(2)),
        maxLoss:   parseFloat(Math.min(...vals).toFixed(2)),
      };
    };

    results[s.key] = {
      label: s.label, desc: s.desc,
      signalCount: signals.length,
      days5:  stats('ret5'),
      days10: stats('ret10'),
    };
  }
  return results;
}

export function koreanMarketFlags(closes, volumes, changeRate) {
  const flags = [];
  const n = closes.length;
  if (n < 2) return flags;
  const prev = closes[n - 2], cur = closes[n - 1];
  const dayChg = prev > 0 ? (cur - prev) / prev * 100 : 0;
  if (dayChg >= 29)       flags.push({ type: 'LIMIT_UP',        label: '상한가',       severity: 'warning', desc: '상한가 도달 — 다음날 갭하락 리스크' });
  else if (dayChg >= 20)  flags.push({ type: 'NEAR_LIMIT_UP',   label: '상한가 근접',   severity: 'caution', desc: `+${dayChg.toFixed(1)}% — 추격 매수 위험` });
  if (dayChg <= -29)      flags.push({ type: 'LIMIT_DOWN',      label: '하한가',       severity: 'danger',  desc: '하한가 도달 — 패닉셀 가능성' });
  else if (dayChg <= -20) flags.push({ type: 'NEAR_LIMIT_DOWN', label: '하한가 근접',   severity: 'danger',  desc: `${dayChg.toFixed(1)}%` });
  if (volumes && volumes.length >= 21) {
    const avgVol = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const ratio  = avgVol > 0 ? volumes[n - 1] / avgVol : 0;
    if (ratio >= 5) flags.push({ type: 'VOLUME_SURGE', label: `거래량 ${ratio.toFixed(0)}배`, severity: 'info', desc: '거래량 폭발 — 세력 개입 가능성' });
    else if (ratio >= 3) flags.push({ type: 'VOLUME_HIGH', label: `거래량 ${ratio.toFixed(1)}배`, severity: 'info', desc: '거래량 급증' });
  }
  const high52w = Math.max(...closes.slice(-252));
  const low52w  = Math.min(...closes.slice(-252));
  if (cur >= high52w * 0.98) flags.push({ type: 'NEAR_52W_HIGH', label: '52주 신고가', severity: 'info', desc: '52주 최고가 근처 — 저항 가능' });
  if (cur <= low52w  * 1.02) flags.push({ type: 'NEAR_52W_LOW',  label: '52주 신저가', severity: 'danger', desc: '52주 최저가 근처 — 바닥 불확실' });
  return flags;
}

export const SENTIMENT_POS = [
  '급등','상승','돌파','신고가','52주신고가','연고점','반등','회복','강세','상향','급반등',
  '호실적','흑자','영업이익증가','매출증가','실적개선','어닝서프라이즈','예상상회','최대실적','사상최대',
  '수주','계약','협약','파트너십','수출','신제품','출시','상용화','승인','허가','채택','선정',
  '호재','기대감','목표주가상향','매수추천','긍정','성장','확대','투자유치','모멘텀','수혜','저평가','턴어라운드',
  '배당','자사주','분할','주식매입','호조','개선','증가',
];

export const SENTIMENT_NEG = [
  '급락','하락','신저가','52주신저가','연저점','약세','하향','폭락','추락','급락세',
  '적자','손실','어닝쇼크','실적부진','매출감소','이익감소','예상하회','영업손실','적자전환',
  '취소','해지','소송','제재','조사','리콜','결함','중단','철수','지연','계약해제','공급차질',
  '우려','경고','위험','부담','악재','매도추천','목표주가하향','부정','위기','유동성부족','부채급증',
  '감자','상장폐지','유상증자','주가희석','공매도','대량매도','오버행','블록딜',
];

// 레버리지·인버스 ETF 자동 감지
export function detectLeverageETF(name = '') {
  const upper = (name || '').toUpperCase();
  const keywords = ['레버리지', '인버스', '곱버스', '2X', '2배', '3X', '3배', 'LEVERAGE', 'INVERSE', 'SHORT'];
  return {
    isLeverage: keywords.some(k => upper.includes(k)),
    isInverse:  ['인버스', '곱버스', 'INVERSE', 'SHORT'].some(k => upper.includes(k)),
    warning: keywords.some(k => upper.includes(k))
      ? '레버리지/인버스 ETF — 변동성 감쇠(Volatility Decay)로 장기 보유 시 원금 손실 위험. 단기 트레이딩 전용.'
      : null,
  };
}

// 거래량-가격 다이버전스 감지
// 강한 상승 = 주가↑ + 거래량↑ / 허수 상승 = 주가↑ + 거래량↓
export function calcVolumePriceDivergence(closes, volumes, period = 10) {
  const n = closes.length;
  if (n < period + 1 || !volumes || volumes.length < n) return null;
  const rc = closes.slice(-period);
  const rv = volumes.slice(-period);
  const half = Math.floor(period / 2);
  const priceChange = (rc[rc.length - 1] - rc[0]) / (rc[0] || 1) * 100;
  const avgVolFirst = rv.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const avgVolLast  = rv.slice(half).reduce((a, b) => a + b, 0) / (period - half);
  const volRatio    = avgVolFirst > 0 ? avgVolLast / avgVolFirst : 1;
  const priceUp     = priceChange > 1;
  const priceDown   = priceChange < -1;
  const volUp       = volRatio > 1.2;
  const volDown     = volRatio < 0.8;
  let type = 'neutral', signal = 'neutral', desc = '';
  if (priceUp && volUp)   { type = 'confirmed_up';   signal = 'bullish'; desc = `주가 +${priceChange.toFixed(1)}% + 거래량 ${volRatio.toFixed(1)}배 — 강한 상승 신호`; }
  else if (priceUp && volDown) { type = 'divergence_up'; signal = 'bearish'; desc = `주가 상승에 거래량 미동반(${volRatio.toFixed(1)}배) — 상승 신뢰도 낮음`; }
  else if (priceDown && volUp) { type = 'confirmed_dn'; signal = 'warning'; desc = `하락 중 거래량 급증(${volRatio.toFixed(1)}배) — 추가 하락 또는 세력 개입 주의`; }
  else if (priceDown && volDown){ type = 'divergence_dn'; signal = 'neutral'; desc = `거래량 감소 속 하락(${volRatio.toFixed(1)}배) — 기술적 조정 가능성`; }
  else { desc = '거래량-가격 추세 중립'; }
  return { type, signal, desc, priceChangePct: parseFloat(priceChange.toFixed(2)), volRatioChange: parseFloat(volRatio.toFixed(2)) };
}

export function analyzeNewsSentiment(newsItems) {
  if (!newsItems || !newsItems.length) return null;
  let pos = 0, neg = 0;
  const scored = newsItems.map(n => {
    const t = n.title || '';
    let sc = 0;
    for (const kw of SENTIMENT_POS) if (t.includes(kw)) sc++;
    for (const kw of SENTIMENT_NEG) if (t.includes(kw)) sc--;
    if (sc > 0) pos++;
    else if (sc < 0) neg++;
    return { ...n, sentiment: sc > 0 ? 'positive' : sc < 0 ? 'negative' : 'neutral', score: sc };
  });
  const net = pos - neg;
  return {
    label:   net > 0 ? '긍정' : net < 0 ? '부정' : '중립',
    pos, neg, neutral: newsItems.length - pos - neg,
    score: net,
    items: scored,
  };
}

// Feature 4: 품질 스크린 7개 필터 (투자 가치 있는 기업인지 사전 필터링)
export function calcQualityScreen(dart, fundamentals, pScore, fScore) {
  const f = fundamentals || {};
  const d = dart || {};
  const checks = [];

  const mk = (key, label, pass, value) => checks.push({ key, label, pass, value });

  // 1. 영업이익률 >= 5%
  const opMgn = d.opMargin ?? f.opMargin ?? null;
  mk('profitability', '영업이익률 ≥ 5%',
    opMgn !== null ? opMgn >= 5 : null,
    opMgn !== null ? `${opMgn.toFixed(1)}%` : 'N/A');

  // 2. 매출 성장 (역성장 없음)
  const revG = d.revenueGrowth ?? f.revenueGrowth ?? null;
  mk('revenue_growth', '매출 성장 (역성장 없음)',
    revG !== null ? revG >= 0 : null,
    revG !== null ? `${revG >= 0 ? '+' : ''}${revG.toFixed(1)}%` : 'N/A');

  // 3. PER < 25배
  const per = f.per ?? null;
  mk('valuation', 'PER < 25배 (합리적 가격)',
    per !== null ? (per > 0 && per < 25) : null,
    per !== null ? `${per.toFixed(1)}배` : 'N/A');

  // 4. 부채비율 < 200%
  const debt = f.debtToEquity ?? null;
  mk('debt', '부채비율 < 200%',
    debt !== null ? debt < 200 : null,
    debt !== null ? `${debt.toFixed(0)}%` : 'N/A');

  // 5. ROE >= 10%
  const roe = f.roe ?? null;
  mk('roe', 'ROE ≥ 10%',
    roe !== null ? roe >= 10 : null,
    roe !== null ? `${roe.toFixed(1)}%` : 'N/A');

  // 6. Piotroski F-Score >= 5
  const fs = fScore?.score ?? null;
  mk('piotroski', 'F-Score ≥ 5 (재무 건전성)',
    fs !== null ? fs >= 5 : null,
    fs !== null ? `${fs}/9` : 'N/A');

  // 7. 린치 점수 >= 40
  const ps = pScore ?? null;
  mk('lynch', '린치 점수 ≥ 40점',
    ps !== null ? ps >= 40 : null,
    ps !== null ? `${Math.round(ps)}점` : 'N/A');

  const defined = checks.filter(c => c.pass !== null);
  const passed  = defined.filter(c => c.pass === true);
  const failed  = defined.filter(c => c.pass === false);

  let grade, verdict;
  if (!defined.length) { grade = 'N/A'; verdict = 'UNKNOWN'; }
  else {
    const rate = passed.length / defined.length;
    if (rate >= 0.86) { grade = 'A'; verdict = 'PASS'; }
    else if (rate >= 0.71) { grade = 'B'; verdict = 'PASS'; }
    else if (rate >= 0.57) { grade = 'C'; verdict = 'WATCH'; }
    else { grade = 'F'; verdict = 'FAIL'; }
  }

  return { verdict, grade, passCount: passed.length, failCount: failed.length, total: checks.length, checks };
}
