import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { authHeaders } from '../contexts/AuthContext';

// ── 리포트 산출 로직 (python-legacy/modules/report.py 포팅) ──────────

function volComment(ratio) {
  if (ratio >= 5.0) return '폭발적 수급 유입 (세력·기관 관여 가능성)';
  if (ratio >= 3.0) return '강한 수급 유입';
  if (ratio >= 2.0) return '수급 증가 — 추세 강화 신호';
  if (ratio >= 1.5) return '평균 이상 거래 — 양호';
  if (ratio >= 1.0) return '평균 수준';
  return '거래 부진 — 모멘텀 약화 주의';
}

function ratingAndUpside(score) {
  if (score >= 85) return { rating: '적극매수', upside: 0.20, tone: 'strong' };
  if (score >= 70) return { rating: '매수',     upside: 0.15, tone: 'buy' };
  if (score >= 55) return { rating: '중립',     upside: 0.08, tone: 'neutral' };
  return { rating: '관망', upside: 0.05, tone: 'hold' };
}

function buildReport(d) {
  const price = d.close;
  const score = Math.round(((d.pScore ?? 0) + (d.lScore ?? 0)) / 2);
  const { rating, upside, tone } = ratingAndUpside(score);

  // 손절가: 25일선(주봉 5주선 근사) -3% / 현재가 -8% / 20일 저가 -1.5% 중 가장 보수적(높은) 값
  const ma25 = d.ma25arr?.at?.(-1) ?? null;
  const lows20 = (d.candles || []).slice(-20).map(c => c.l).filter(Boolean);
  const low20d = lows20.length ? Math.min(...lows20) : Math.round(price * 0.92);
  const stopLoss = Math.max(
    ma25 ? Math.round(ma25 * 0.97) : 0,
    Math.round(price * 0.92),
    Math.round(low20d * 0.985),
  );
  const targetPrice = Math.round(price * (1 + upside));
  const downside = price > stopLoss ? (price - stopLoss) / price : 0.05;
  const rrRatio = downside > 0 ? (upside / downside).toFixed(1) : '-';

  const highs20 = (d.candles || []).slice(-20).map(c => c.h).filter(Boolean);
  const high20d = highs20.length ? Math.max(...highs20) : null;

  // 투자 포인트
  const points = [];
  if (d.ma5 && price > d.ma5)   points.push(`5일선(${d.ma5.toLocaleString()}원) 상회 — 단기 상승 추세`);
  if (d.ma20 && price > d.ma20) points.push(`20일선(${d.ma20.toLocaleString()}원) 상회 — 중기 추세 유효`);
  if (d.ma60 && price > d.ma60) points.push(`60일선(${d.ma60.toLocaleString()}원) 상회 — 중장기 상승 구조`);
  if (d.fullAlignment)          points.push('이동평균선 완전 정배열 (5>20>60>120) — 이상적 추세 구조');
  if (d.macd?.lastCross === 'golden') points.push('MACD 골든크로스 — 단기 매수 모멘텀 확인');
  if (d.rsi && d.rsi >= 48 && d.rsi <= 65) points.push(`RSI ${d.rsi.toFixed(1)} — 과열 없는 건강한 모멘텀 구간`);
  if (d.volRatio >= 1.5) points.push(`거래량 ${d.volRatio.toFixed(1)}배 — ${volComment(d.volRatio)}`);
  const f = d.fundamentals || {};
  if (f.per != null && f.per > 0 && f.per < 12) points.push(`PER ${f.per}배 — 시장 대비 저평가 영역`);
  if (f.roe != null && f.roe >= 15) points.push(`ROE ${f.roe}% — 우량한 자본 효율`);
  if (d.fScore?.score >= 7) points.push(`피오트로스키 F-Score ${d.fScore.score}/9 — 재무 건전성 우수`);
  if (!points.length) points.push('현재 뚜렷한 매수 근거 부족 — 관망 권고');

  // 리스크 요인
  const risks = [];
  if (ma25) risks.push(`25일선(${ma25.toLocaleString()}원) 하향 이탈 시 추세 약화 — 손절 기준 준수`);
  risks.push('KOSPI·KOSDAQ 시장 전체 하락 시 동반 하락 위험');
  if (d.ma60 && price < d.ma60) risks.push('60일선 하회 중 — 중장기 하락 구조 가능성');
  if (d.rsi && d.rsi > 70) risks.push(`RSI ${d.rsi.toFixed(1)} — 단기 과열, 조정 출현 가능성`);
  if (d.volRatio > 5) risks.push(`거래량 ${d.volRatio.toFixed(1)}배 급증 — 차익실현 물량 주의`);
  if (f.per != null && f.per > 40) risks.push(`PER ${f.per}배 — 고평가 부담, 성장 둔화 시 조정 폭 큼`);
  if (f.debtToEquity != null && f.debtToEquity > 150) risks.push(`부채비율 ${f.debtToEquity}% — 재무 레버리지 부담`);
  if (d.mdd != null && d.mdd < -30) risks.push(`최근 1년 최대낙폭 ${d.mdd.toFixed(0)}% — 변동성 큰 종목`);

  return { price, score, rating, tone, targetPrice, stopLoss, rrRatio,
    upsidePct: upside * 100, downsidePct: downside * 100,
    high20d, low20d, points, risks };
}

const TONE_STYLE = {
  strong:  'bg-profit/15 text-profit',
  buy:     'bg-profit/10 text-profit',
  neutral: 'bg-yellow-500/10 text-yellow-400',
  hold:    'bg-slate-700/40 text-slate-300',
};

function Section({ title, children }) {
  return (
    <section className="px-4 mt-5">
      <h3 className="text-[13px] font-bold text-brand-400 mb-2.5">■ {title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, accent }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-slate-800/50 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-medium ${accent || 'text-slate-200'}`}>{value}</span>
    </div>
  );
}

export default function ReportPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const code = searchParams.get('code') || '';

  const [data, setData] = useState(null);
  const [disclosures, setDisclosures] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code) return;
    fetch(`/api/analysis?code=${encodeURIComponent(code)}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => d.error ? setError(d.error) : setData(d))
      .catch(e => setError(e.message));
    fetch(`/api/disclosures?code=${encodeURIComponent(code)}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setDisclosures(d.items || []))
      .catch(() => {});
  }, [code]);

  const report = useMemo(() => data ? buildReport(data) : null, [data]);
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });

  if (!code) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center pb-20 px-6">
        <h2 className="text-lg font-semibold text-slate-300 mb-2">종목을 선택하세요</h2>
        <p className="text-sm text-slate-500 mb-6">관심 탭에서 종목을 선택한 뒤 리포트를 발행할 수 있습니다</p>
        <button onClick={() => navigate('/discover')} className="px-6 py-3 bg-brand-500 text-white rounded-xl text-sm font-semibold">
          종목 찾기
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center pb-20 px-6">
        <p className="text-sm text-red-400 mb-4">{error}</p>
        <button onClick={() => navigate(-1)} className="px-4 py-2 bg-surface-900 text-slate-300 text-sm rounded-xl border border-slate-700">돌아가기</button>
      </div>
    );
  }

  if (!data || !report) {
    return (
      <div className="flex-1 pb-20 pt-6 px-4 space-y-3">
        <div className="h-24 bg-surface-900 rounded-xl animate-pulse" />
        <div className="h-40 bg-surface-900 rounded-xl animate-pulse" />
        <div className="h-40 bg-surface-900 rounded-xl animate-pulse" />
      </div>
    );
  }

  const f = data.fundamentals || {};
  const pct = (v) => v == null ? '-' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

  return (
    <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
      {/* 헤더 */}
      <div className="flex items-center gap-3 px-4 pt-5 pb-2">
        <button onClick={() => navigate(-1)} className="text-slate-400 hover:text-white p-1 -ml-1">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1">
          <h1 className="text-base font-bold text-white">{data.name} <span className="text-xs text-slate-500 font-normal">{code}</span></h1>
          <p className="text-[10px] text-slate-500">기술적 분석 리포트 · {today} · {data.market}</p>
        </div>
        <button
          onClick={() => window.print()}
          className="text-slate-400 hover:text-white p-1.5 bg-surface-900 rounded-lg"
          aria-label="인쇄/저장"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659" />
          </svg>
        </button>
      </div>

      {/* 투자의견 요약 카드 */}
      <div className="mx-4 mt-2 bg-surface-900 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${TONE_STYLE[report.tone]}`}>{report.rating}</span>
          <div className="text-right">
            <p className="text-[10px] text-slate-500">종합점수</p>
            <p className="text-lg font-bold text-white">{report.score}<span className="text-xs text-slate-500 font-normal"> / 100</span></p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-surface-950 rounded-xl py-2.5">
            <p className="text-[10px] text-slate-500">현재가</p>
            <p className="text-sm font-bold text-white mt-0.5">{report.price?.toLocaleString()}원</p>
          </div>
          <div className="bg-surface-950 rounded-xl py-2.5">
            <p className="text-[10px] text-slate-500">목표주가</p>
            <p className="text-sm font-bold text-profit mt-0.5">{report.targetPrice.toLocaleString()}원</p>
            <p className="text-[9px] text-profit/70">+{report.upsidePct.toFixed(0)}%</p>
          </div>
          <div className="bg-surface-950 rounded-xl py-2.5">
            <p className="text-[10px] text-slate-500">손절가</p>
            <p className="text-sm font-bold text-loss mt-0.5">{report.stopLoss.toLocaleString()}원</p>
            <p className="text-[9px] text-loss/70">-{report.downsidePct.toFixed(1)}%</p>
          </div>
        </div>
        <p className="text-center text-[11px] text-slate-500 mt-3">
          리스크/리워드 <span className="text-brand-400 font-semibold">1 : {report.rrRatio}</span>
          {' '}— {report.downsidePct.toFixed(1)}% 손실 감수 시 {report.upsidePct.toFixed(0)}% 수익 기대
        </p>
      </div>

      {/* 투자 포인트 */}
      <Section title="투자 포인트">
        <div className="bg-surface-900 rounded-xl p-4 space-y-2">
          {report.points.map((p, i) => (
            <p key={i} className="text-xs text-slate-300 leading-relaxed flex gap-2">
              <span className="text-profit shrink-0">{i + 1}.</span>{p}
            </p>
          ))}
        </div>
      </Section>

      {/* 기술적 분석 */}
      <Section title="기술적 분석">
        <div className="bg-surface-900 rounded-xl px-4 py-2">
          <Row label="종합 시그널" value={data.combinedSignal?.signal || '-'}
            accent={data.combinedSignal?.signal === 'BUY' ? 'text-profit' : data.combinedSignal?.signal === 'SELL' ? 'text-loss' : 'text-yellow-400'} />
          <Row label="이평선 배열" value={data.fullAlignment ? '완전정배열' : '부분 배열'} />
          <Row label="MA5 / MA20" value={`${data.ma5?.toLocaleString() ?? '-'} / ${data.ma20?.toLocaleString() ?? '-'}`} />
          <Row label="MA60 / MA120" value={`${data.ma60?.toLocaleString() ?? '-'} / ${data.ma120?.toLocaleString() ?? '-'}`} />
          <Row label="RSI (14일)" value={data.rsi != null ? data.rsi.toFixed(1) : '-'}
            accent={data.rsi > 70 ? 'text-loss' : data.rsi < 30 ? 'text-profit' : undefined} />
          <Row label="MACD 크로스" value={data.macd?.lastCross === 'golden' ? '골든크로스' : data.macd?.lastCross === 'dead' ? '데드크로스' : '없음'}
            accent={data.macd?.lastCross === 'golden' ? 'text-profit' : data.macd?.lastCross === 'dead' ? 'text-loss' : undefined} />
          <Row label="ATR (변동폭)" value={data.atr != null ? `${Math.round(data.atr).toLocaleString()}원` : '-'} />
          <Row label="거래량 비율" value={`${data.volRatio?.toFixed(2) ?? '-'}배 — ${volComment(data.volRatio || 0)}`} />
        </div>
      </Section>

      {/* 펀더멘털 */}
      <Section title="펀더멘털">
        <div className="bg-surface-900 rounded-xl px-4 py-2">
          <Row label="PER / PBR" value={`${f.per ?? '-'}배 / ${f.pbr ?? '-'}배`} />
          <Row label="ROE" value={f.roe != null ? `${f.roe}%` : '-'} />
          <Row label="배당수익률" value={f.dividendYield != null ? `${f.dividendYield}%` : '-'} />
          <Row label="매출 성장률" value={pct(f.revenueGrowth)} />
          <Row label="영업이익률" value={pct(f.opMargin)} />
          {data.fScore && <Row label="피오트로스키 F-Score" value={`${data.fScore.score} / 9`}
            accent={data.fScore.score >= 7 ? 'text-profit' : data.fScore.score <= 3 ? 'text-loss' : undefined} />}
          <Row label="린치 / 리버모어 점수" value={`${Math.round(data.pScore ?? 0)} / ${Math.round(data.lScore ?? 0)}`} />
        </div>
      </Section>

      {/* 주요 가격 레벨 */}
      <Section title="주요 가격 레벨">
        <div className="bg-surface-900 rounded-xl px-4 py-2">
          {report.high20d && <Row label="20일 최고가" value={`${report.high20d.toLocaleString()}원`} />}
          <Row label="20일 최저가" value={`${report.low20d.toLocaleString()}원`} />
          {data.high52w && <Row label="52주 최고가" value={`${data.high52w.toLocaleString()}원 (현재가 ${(((data.high52w - report.price) / report.price) * 100).toFixed(1)}% 위)`} />}
          {data.low52w && <Row label="52주 최저가" value={`${data.low52w.toLocaleString()}원 (현재가 ${(((report.price - data.low52w) / report.price) * 100).toFixed(1)}% 위)`} />}
        </div>
      </Section>

      {/* 최근 공시 */}
      <Section title="최근 공시 (90일)">
        <div className="bg-surface-900 rounded-xl px-4 py-3">
          {disclosures.length === 0 ? (
            <p className="text-xs text-slate-500">최근 공시 없음 또는 조회 불가</p>
          ) : (
            <div className="space-y-2">
              {disclosures.map((d, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="text-slate-600 shrink-0 font-mono">
                    {d.date?.length === 8 ? `${d.date.slice(2,4)}.${d.date.slice(4,6)}.${d.date.slice(6,8)}` : d.date}
                  </span>
                  <span className="text-slate-300 leading-snug">{d.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* 리스크 요인 */}
      <Section title="리스크 요인">
        <div className="bg-surface-900 rounded-xl p-4 space-y-2">
          {report.risks.map((r, i) => (
            <p key={i} className="text-xs text-slate-400 leading-relaxed flex gap-2">
              <span className="text-loss shrink-0">▪</span>{r}
            </p>
          ))}
        </div>
      </Section>

      <p className="px-6 mt-5 text-[10px] text-slate-600 text-center leading-relaxed">
        본 리포트는 기술적 분석 기반 자동 생성 리포트입니다.<br />
        투자 판단의 최종 책임은 투자자 본인에게 있습니다.
      </p>
      <div className="h-6" />
    </div>
  );
}
