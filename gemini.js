const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수 미설정');

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 600,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 429) throw new Error('Gemini 요청 한도 초과 (15req/min). 잠시 후 다시 시도하세요.');
    throw new Error(`Gemini API 오류 ${res.status}: ${err.slice(0, 120)}`);
  }

  const d = await res.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function analyzeStock(data) {
  const cacheKey = `stock:${data.code}`;
  const hit = getCache(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const f = data.fundamentals || {};
  const prompt = `당신은 한국 주식 가치투자 분석 AI입니다. 피터 린치 투자 철학(성장주 + 합리적 가격) 기반으로 분석하세요.
다음 데이터를 보고 JSON으로만 응답하세요.

종목: ${data.name} (${data.code}) / ${data.market}
현재가: ${data.close?.toLocaleString()}원
52주 고가: ${data.high52w?.toLocaleString()}원 | 52주 저가: ${data.low52w?.toLocaleString()}원
기술 지표: RSI ${data.rsi?.toFixed(1)} | MA20 괴리 ${data.deviation?.toFixed(1)}%
피터린치 점수: ${data.pScore}/100 (${data.pGrade}) | 리버모어 점수: ${data.lScore}/100 (${data.lGrade})
PER: ${f.per?.toFixed(1) ?? 'N/A'}배 | PBR: ${f.pbr?.toFixed(2) ?? 'N/A'}배 | ROE: ${f.roe?.toFixed(1) ?? 'N/A'}%
매출성장률: ${data.dart?.revenueGrowth?.toFixed(1) ?? 'N/A'}% | 영업이익률: ${data.dart?.opMargin?.toFixed(1) ?? 'N/A'}%
피오트로스키 F-Score: ${data.fScore?.score ?? 'N/A'}/${data.fScore?.total ?? 9}

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "bullCase": "강세 근거 2~3문장 (한국어)",
  "bearCase": "리스크 및 약세 근거 2~3문장 (한국어)",
  "opinion": "매수" | "관망" | "매도",
  "targetPrice": 숫자 (1년 목표주가, 원 단위),
  "summary": "1문장 핵심 투자 요약 (한국어)"
}`;

  const result = await callGemini(prompt);
  if (result.bullCase) setCache(cacheKey, result);
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
