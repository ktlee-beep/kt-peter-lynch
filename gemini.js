// 최신 모델 우선 시도, 실패(미지원/한도)면 다음 모델 폴백.
// Gemma도 동일 Google API·동일 키 사용. Gemini 한도 초과 시 Gemma로 자동 폴백.
import { getAppConfig } from './db.js';

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemma-4-31b-it', 'gemma-4-4b-it'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// 키 조회: Render 환경변수 우선, 없으면 DB(설정 화면 입력값). 60초 캐시.
let _keyCache = { value: null, ts: 0 };
async function getApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (_keyCache.value && Date.now() - _keyCache.ts < 60000) return _keyCache.value;
  const k = await getAppConfig('gemini_api_key').catch(() => null);
  _keyCache = { value: k, ts: Date.now() };
  return k;
}

const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCache(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function extractJson(text) {
  if (!text) return {};
  // 마크다운 코드펜스 제거 (```json ... ``` 또는 ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const clean = fenceMatch ? fenceMatch[1].trim() : text.trim();
  try {
    return JSON.parse(clean);
  } catch {
    // 첫 번째 { ... } 블록만 추출 시도
    const objMatch = clean.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch {}
    }
    return { raw: clean };
  }
}

async function callGemini(prompt) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('AI 키 미설정 — 설정 화면에서 Gemini/Gemma 키를 입력하세요');

  let lastErr;
  for (const model of GEMINI_MODELS) {
    const isGemma = model.startsWith('gemma');
    try {
      // Gemma는 JSON 모드(responseMimeType)·systemInstruction 미지원 → 생략하고
      // 프롬프트의 "JSON으로만 응답" 지시 + extractJson으로 파싱
      const generationConfig = { temperature: 0.4, maxOutputTokens: 2048 };
      if (!isGemma) generationConfig.responseMimeType = 'application/json';
      // Gemini 2.5는 thinking 기본 ON → 사고 토큰이 출력 예산을 잠식해 응답이 잘림.
      // thinkingBudget 0으로 비활성화하여 출력 토큰을 확보.
      if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

      const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 404) { lastErr = new Error(`모델 미지원: ${model}`); continue; } // 다음 모델 시도
      if (res.status === 429) { lastErr = new Error('요청 한도 초과'); continue; }           // 한도 → 다음 모델(Gemma) 시도
      if (!res.ok) {
        const err = await res.text();
        lastErr = new Error(`API 오류 ${res.status}: ${err.slice(0, 120)}`);
        continue;
      }

      const d = await res.json();
      // 안전 필터 차단 확인
      const finishReason = d.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY' || finishReason === 'BLOCKED') {
        lastErr = new Error('안전 필터 차단'); continue;
      }
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error('응답이 비어있음'); continue; }
      return extractJson(text);
    } catch (e) {
      lastErr = e; // 타임아웃·네트워크 등 → 다음 모델 시도
    }
  }
  throw lastErr || new Error('AI 모델 호출 실패 (모든 모델 시도 실패)');
}

export async function analyzeStock(data) {
  const cacheKey = `stock:${data.code}`;
  const hit = getCache(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const f = data.fundamentals || {};
  const cur = data.close || 0;
  const prompt = `당신은 한국 주식 가치투자 분석 AI입니다. 피터 린치 투자 철학(성장주 + 합리적 가격) 기반으로 분석하세요.
다음 데이터를 보고 JSON으로만 응답하세요.

종목: ${data.name} (${data.code}) / ${data.market}
현재가: ${cur.toLocaleString()}원
52주 고가: ${data.high52w?.toLocaleString()}원 | 52주 저가: ${data.low52w?.toLocaleString()}원
기술 지표: RSI ${data.rsi?.toFixed(1)} | MA20 괴리 ${data.deviation?.toFixed(1)}%
피터린치 점수: ${data.pScore}/100 (${data.pGrade}) | 리버모어 점수: ${data.lScore}/100 (${data.lGrade})
PER: ${f.per?.toFixed(1) ?? 'N/A'}배 | PBR: ${f.pbr?.toFixed(2) ?? 'N/A'}배 | ROE: ${f.roe?.toFixed(1) ?? 'N/A'}%
매출성장률: ${data.dart?.revenueGrowth?.toFixed(1) ?? 'N/A'}% | 영업이익률: ${data.dart?.opMargin?.toFixed(1) ?? 'N/A'}%
피오트로스키 F-Score: ${data.fScore?.score ?? 'N/A'}/${data.fScore?.total ?? 9}

[중요] 결론을 반드시 명확하게 제시하라. "한편으로는... 다른 한편으로는..."식 양비론 금지.
BUY/NO_BUY/WATCH 중 하나로 강제 결정하고, 전략 유형별 구체적 매수 가격대를 제시하라.
현재가(${cur.toLocaleString()}원) 기준으로 zone 가격대를 계산하라.

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "bullCase": "강세 근거 2~3문장 (한국어)",
  "bearCase": "리스크 및 약세 근거 2~3문장 (한국어)",
  "opinion": "매수" | "관망" | "매도",
  "targetPrice": 숫자 (1년 목표주가, 원 단위),
  "summary": "1문장 핵심 투자 요약 (한국어)",
  "decision": {
    "verdict": "BUY" | "NO_BUY" | "WATCH",
    "reason": "결정 핵심 근거 1문장 (왜 이 verdict인지)",
    "zones": {
      "aggressive": { "action": "적극형 전략 행동 (예: 현재가 즉시 매수)", "range": "구체적 가격대 (원 단위, 예: 85,000~90,000원)" },
      "safe": { "action": "안전형 전략 행동 (예: 눌림목 XX원대 대기)", "range": "구체적 가격대 (원 단위)" },
      "conservative": { "action": "보수형 전략 행동 (예: 관망 또는 XX원 이하 소량)", "range": "가격대 또는 -" }
    }
  }
}`;

  const result = await callGemini(prompt);
  if (result.bullCase) setCache(cacheKey, result);
  return result;
}

// 보유 종목 홀드/매도 판단 — 매수가·현재가·차트 지표 기반
export async function analyzeHolding(holding, analysis) {
  const cacheKey = `holding:${holding.code}:${Math.round(holding.currentPrice / 100)}`;
  const hit = getCache(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const pnlPct = holding.buyPrice > 0
    ? (((holding.currentPrice - holding.buyPrice) / holding.buyPrice) * 100).toFixed(1)
    : '0.0';
  const f = analysis?.fundamentals || {};
  const dart = analysis?.dart || {};

  const prompt = `당신은 한국 주식 가치투자 AI 코치입니다. 피터 린치 투자 철학 기반.
보유 종목을 분석하고 "지금 홀드할지 / 매도할지" 판단을 JSON으로만 응답하세요.

종목: ${holding.name} (${holding.code})
매수가: ${holding.buyPrice?.toLocaleString()}원 | 현재가: ${holding.currentPrice?.toLocaleString()}원
손익: ${pnlPct}% | 보유 수량: ${holding.shares}주
${analysis ? `
RSI: ${analysis.rsi?.toFixed(1) ?? 'N/A'} | MA20 괴리: ${analysis.deviation?.toFixed(1) ?? 'N/A'}%
피터린치 점수: ${analysis.pScore ?? 'N/A'}/100 | ATR 손절: ${analysis.dynStop?.normal?.price?.toLocaleString() ?? 'N/A'}원
PER: ${f.per?.toFixed(1) ?? 'N/A'}배 | ROE: ${f.roe?.toFixed(1) ?? 'N/A'}%
매출성장률: ${dart.revenueGrowth?.toFixed(1) ?? 'N/A'}% | 영업이익률: ${dart.opMargin?.toFixed(1) ?? 'N/A'}%
52주 고가 대비: ${analysis.high52w ? ((analysis.close / analysis.high52w - 1) * 100).toFixed(1) : 'N/A'}%
` : ''}
응답 형식 (JSON만, 다른 텍스트 없이):
{
  "verdict": "홀드" | "매도" | "추가매수",
  "summary": "판단 핵심 1문장 (한국어)",
  "reasoning": "판단 근거 2~3문장 (한국어)",
  "holdReasons": ["홀드 근거 최대 3개 (한국어)"],
  "sellTriggers": ["이 상황이 되면 팔아라 최대 3개 (구체적 조건, 한국어)"],
  "riskFactors": ["현재 리스크 최대 2개 (한국어)"]
}`;

  const result = await callGemini(prompt);
  if (result.verdict) setCache(cacheKey, result);
  return result;
}

export async function analyzeMarket(macroData) {
  const cacheKey = 'market:sentiment';
  const hit = getCache(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const prompt = `당신은 한국 주식시장 매크로 분석 AI입니다.
다음 거시경제 데이터를 분석하고 JSON으로만 응답하세요.

시장 국면: ${macroData.label} (점수 ${macroData.score})
KOSPI: ${macroData.kospi} | KOSDAQ: ${macroData.kosdaq}
USD/KRW: ${macroData.usdkrw} | VIX: ${macroData.vix} | 미국채10년: ${macroData.us10y}%
주요 신호: ${(macroData.notes || []).join(', ')}

응답 형식 (JSON만):
{
  "phase": "시장 국면 한 단어 (상승/횡보/하락/공포/탐욕)",
  "summary": "현 시장 상황 2~3문장 요약",
  "strategy": "이 국면에서의 투자 전략 1~2문장",
  "watchlist": ["관심 섹터/테마1", "관심 섹터/테마2", "관심 섹터/테마3"],
  "risks": ["주요 리스크1", "주요 리스크2"]
}`;

  const result = await callGemini(prompt);
  if (result.summary) setCache(cacheKey, result);
  return result;
}

// 개장 전 아침 브리핑 — 밤사이 매크로 + 야간선물 + 전일 스캔 상위 매수후보 종합
export async function generateMorningBrief(ctx) {
  const { macro, futures, picks } = ctx || {};
  const pickLines = (picks || []).slice(0, 5).map(p =>
    `- ${p.name ?? p.code}(${p.code}) 종가 ${p.close_price?.toLocaleString?.('ko-KR') ?? p.close_price ?? '?'}원, `
    + `등락 ${p.change_rate ?? '?'}%, 린치 ${p.lynch_score ?? '?'}, RSI ${p.rsi ?? '?'}`
  ).join('\n') || '- (전일 BUY 신호 종목 없음)';
  const fut = futures && !futures.error && futures.price != null
    ? `${futures.price?.toLocaleString?.('ko-KR') ?? futures.price} (${futures.changeRate > 0 ? '+' : ''}${futures.changeRate?.toFixed?.(2) ?? '?'}%)`
    : '데이터 없음';

  const prompt = `당신은 한국 주식 개장 전 아침 브리핑 AI입니다. 피터 린치 가치투자 관점.
오늘 한국 증시 개장(09:00) 전, 투자자에게 줄 간결하고 실용적인 아침 브리핑을 작성하세요.

[밤사이 시장] 국면: ${macro?.label ?? '미상'} (점수 ${macro?.score ?? '?'})
${(macro?.notes || []).map(n => '· ' + n).join('\n')}

[코스피200 야간선물 24h] ${fut}

[전일 스캔 상위 매수후보]
${pickLines}

응답 형식 (JSON만, 다른 텍스트 없이, 모두 한국어):
{
  "headline": "오늘 시장 한 줄 요약 (개장 방향 암시)",
  "overnight": "밤사이 미국장·환율·금리 핵심 2~3문장",
  "kospiOutlook": "야간선물·매크로 종합 오늘 코스피 개장 방향 전망 1~2문장",
  "picks": [{"name": "종목명", "reason": "주목 이유 1문장"}],
  "caution": "오늘 유의할 리스크 1문장",
  "strategy": "오늘의 한 줄 대응 전략"
}`;

  return await callGemini(prompt);
}

// Feature 3: 주가 급등락 원인 귀인 분석 (±5% 이상 변동 시)
export async function analyzeNewsPulse(data) {
  const { code, name, changeRate, close, rsi, volRatio, market } = data;
  const cacheKey = `pulse:${code}:${new Date().toISOString().slice(0, 10)}`;
  const hit = getCache(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const dir = changeRate > 0 ? '급등' : '급락';
  const prompt = `당신은 한국 주식 급등락 원인 분석 AI입니다.
다음 종목이 오늘 ${dir}했습니다. 가능한 원인과 향후 대응을 분석하세요.

종목: ${name} (${code}) / ${market ?? 'KRX'}
현재가: ${close?.toLocaleString()}원 | 등락률: ${changeRate?.toFixed(2)}%
RSI: ${rsi?.toFixed(1) ?? 'N/A'} | 거래량 비율: ${volRatio?.toFixed(2) ?? 'N/A'}배

응답 형식 (JSON만):
{
  "cause": "가능성 높은 원인 2~3가지 (한국어, 섹터 이슈/실적/수급/매크로 등)",
  "causeType": "실적" | "수급" | "섹터테마" | "매크로" | "기술적" | "미확인",
  "isSustainable": true | false,
  "sustainReason": "지속성 판단 근거 1문장",
  "recommendation": "보유자 / 매수 고려자 대응 1문장",
  "confidence": "높음" | "중간" | "낮음"
}`;

  const result = await callGemini(prompt);
  if (result.cause) setCache(cacheKey, result);
  return result;
}

// Feature 2: Thesis 현재 유효성 추적 (매수 후 thesis가 여전히 유효한지)
export async function trackThesisValidity(thesis, stockData, stockName) {
  const f = stockData?.fundamentals || {};
  const dart = stockData?.dart || {};
  const thesisText = [
    thesis.story   ? `사업이해: ${thesis.story}` : '',
    thesis.growth  ? `성장근거: ${thesis.growth}` : '',
    thesis.valuation ? `밸류에이션: ${thesis.valuation}` : '',
    thesis.exit_plan ? `매도기준: ${thesis.exit_plan}` : '',
  ].filter(Boolean).join('\n');

  if (!thesisText.trim()) throw new Error('Thesis 내용이 없습니다');

  const prompt = `당신은 투자 Thesis 유효성 추적 AI입니다. 매수 당시 작성한 Thesis가 현재 데이터 기준으로 여전히 유효한지 판단하세요.

종목: ${stockName}
현재가 지표: RSI ${stockData?.rsi?.toFixed(1) ?? 'N/A'} | 피터린치 ${stockData?.pScore ?? 'N/A'}/100
PER: ${f.per?.toFixed(1) ?? 'N/A'}배 | ROE: ${f.roe?.toFixed(1) ?? 'N/A'}%
매출성장률: ${dart.revenueGrowth?.toFixed(1) ?? 'N/A'}% | 영업이익률: ${dart.opMargin?.toFixed(1) ?? 'N/A'}%
F-Score: ${stockData?.fScore?.score ?? 'N/A'}/${stockData?.fScore?.total ?? 9}

[원래 Thesis]
${thesisText}

응답 형식 (JSON만):
{
  "status": "INTACT" | "WARNING" | "BROKEN",
  "statusLabel": "thesis 유효" | "일부 훼손" | "thesis 무효화",
  "intactPoints": ["여전히 유효한 thesis 근거 (최대 3개)"],
  "brokenPoints": ["훼손된 thesis 근거 (최대 3개)"],
  "verdict": "홀드 유지" | "재검토 필요" | "매도 고려",
  "note": "현시점 핵심 판단 1문장"
}`;

  return await callGemini(prompt);
}

// Feature 5: 멀티 에이전트 병렬 분석 (린치 관점 + 가치투자 관점)
export async function analyzeStockMultiPerspective(data) {
  const cacheKey = `multi:${data.code}`;
  const hit = getCache(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const f = data.fundamentals || {};
  const base = `종목: ${data.name} (${data.code})
현재가: ${data.close?.toLocaleString()}원 | RSI: ${data.rsi?.toFixed(1)} | MA20 괴리: ${data.deviation?.toFixed(1)}%
PER: ${f.per?.toFixed(1) ?? 'N/A'}배 | PBR: ${f.pbr?.toFixed(2) ?? 'N/A'}배 | ROE: ${f.roe?.toFixed(1) ?? 'N/A'}%
매출성장률: ${data.dart?.revenueGrowth?.toFixed(1) ?? 'N/A'}% | 영업이익률: ${data.dart?.opMargin?.toFixed(1) ?? 'N/A'}%
PEG: ${f.peg?.toFixed(2) ?? 'N/A'} | 피오트로스키: ${data.fScore?.score ?? 'N/A'}/${data.fScore?.total ?? 9}`;

  const lynchPrompt = `당신은 피터 린치 투자 철학 전문 AI입니다. "합리적 가격의 성장주(GARP)"를 찾는 관점으로만 분석하세요.
PEG < 1이면 매력적, 사업 이해가 쉬울수록 좋음, 매출성장률 15%+ 선호.

${base}

응답 형식 (JSON만):
{
  "verdict": "BUY" | "WATCH" | "PASS",
  "keyReason": "린치 기준 핵심 판단 1문장",
  "targetPrice": 숫자,
  "pegAssessment": "PEG 평가 (예: PEG 0.8 — 성장 대비 저평가)",
  "storyClarity": "사업 명확성 평가 (한국어 1문장)",
  "conviction": 1 | 2 | 3 | 4 | 5
}`;

  const valuePrompt = `당신은 워런 버핏·벤저민 그레이엄 가치투자 철학 전문 AI입니다. "내재가치 대비 안전마진"을 찾는 관점으로만 분석하세요.
PBR < 1.5 또는 ROE 20%+를 선호, 부채비율 낮을수록 좋음, 10년 후 확실성 기준.

${base}

응답 형식 (JSON만):
{
  "verdict": "BUY" | "WATCH" | "PASS",
  "keyReason": "가치투자 기준 핵심 판단 1문장",
  "targetPrice": 숫자,
  "marginOfSafety": "안전마진 평가 (예: 내재가치 대비 15% 할인 — 적정 마진)",
  "moatAssessment": "경제적 해자 평가 (한국어 1문장)",
  "conviction": 1 | 2 | 3 | 4 | 5
}`;

  const [lynchRes, valueRes] = await Promise.allSettled([
    callGemini(lynchPrompt),
    callGemini(valuePrompt),
  ]);

  const lynch = lynchRes.status === 'fulfilled' ? lynchRes.value : null;
  const value = valueRes.status === 'fulfilled' ? valueRes.value : null;

  if (!lynch && !value) throw new Error('멀티 분석 실패 — 두 관점 모두 응답 없음');

  // 두 verdict를 합산하여 종합 판단
  const verdicts = [lynch?.verdict, value?.verdict].filter(Boolean);
  const buyCount = verdicts.filter(v => v === 'BUY').length;
  const passCount = verdicts.filter(v => v === 'PASS').length;
  const synthesisVerdict = buyCount >= 2 ? 'STRONG_BUY' : buyCount === 1 && passCount === 0 ? 'BUY' : passCount >= 2 ? 'PASS' : 'WATCH';
  const avgConviction = Math.round(((lynch?.conviction ?? 0) + (value?.conviction ?? 0)) / (verdicts.length || 1));
  const avgTarget = Math.round(((lynch?.targetPrice ?? 0) + (value?.targetPrice ?? 0)) / (verdicts.length || 1));

  const result = {
    lynch,
    value,
    synthesis: {
      verdict: synthesisVerdict,
      verdictLabel: synthesisVerdict === 'STRONG_BUY' ? '강력 매수' : synthesisVerdict === 'BUY' ? '조건부 매수' : synthesisVerdict === 'WATCH' ? '관망' : '통과',
      avgConviction,
      consensusTarget: avgTarget,
      agreement: buyCount === 2 || passCount === 2 ? '두 관점 일치' : '관점 분기',
    },
  };

  if (result.synthesis) setCache(cacheKey, result);
  return result;
}

export async function validateThesis(thesis, stockName) {
  const thesisText = [
    thesis.story ? `사업이해: ${thesis.story}` : '',
    thesis.growth ? `성장근거: ${thesis.growth}` : '',
    thesis.valuation ? `밸류에이션: ${thesis.valuation}` : '',
    thesis.exit_plan ? `매도기준: ${thesis.exit_plan}` : '',
  ].filter(Boolean).join('\n');

  if (!thesisText.trim()) throw new Error('Thesis 내용이 없습니다');

  const prompt = `당신은 장기 가치투자 Thesis 검증 AI입니다. 피터 린치 투자 철학 기반.
투자 Thesis를 분석하고 논리적 타당성, 리스크, 보완점을 평가하세요.

종목: ${stockName || '미지정'}
---
${thesisText}
---

응답 형식 (JSON만):
{
  "verdict": "STRONG" | "VALID" | "WEAK",
  "verdictLabel": "강력한 thesis" | "타당한 thesis" | "보완 필요",
  "strengths": ["강점1", "강점2"],
  "risks": ["리스크1", "리스크2", "리스크3"],
  "gaps": ["빠진 근거1", "빠진 근거2"],
  "suggestions": ["개선 제안1", "개선 제안2"]
}`;

  return await callGemini(prompt);
}
