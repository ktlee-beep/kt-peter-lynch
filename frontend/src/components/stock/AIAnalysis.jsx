import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

function OpinionBadge({ opinion }) {
  const config = {
    '매수': 'bg-profit/20 text-profit border-profit/30',
    '관망': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    '매도': 'bg-loss/20 text-loss border-loss/30',
  };
  return (
    <span className={`inline-block px-3 py-1 rounded-full text-sm font-bold border ${config[opinion] ?? 'bg-slate-700 text-slate-300 border-slate-600'}`}>
      {opinion}
    </span>
  );
}

function VerdictBadge({ verdict }) {
  const cfg = {
    BUY:        { label: '매수', cls: 'bg-profit/20 text-profit border-profit/30' },
    NO_BUY:     { label: '매수 불가', cls: 'bg-loss/20 text-loss border-loss/30' },
    WATCH:      { label: '관망', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
    STRONG_BUY: { label: '강력 매수', cls: 'bg-profit/30 text-profit border-profit/50' },
    PASS:       { label: '제외', cls: 'bg-slate-700/50 text-slate-400 border-slate-600' },
  };
  const c = cfg[verdict] || cfg.WATCH;
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold border ${c.cls}`}>
      {c.label}
    </span>
  );
}

function DecisionZones({ decision, currentPrice }) {
  if (!decision?.zones) return null;
  const { verdict, reason, zones } = decision;
  const zone = (z, color, label) => (
    <div className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border ${color}`}>
      <span className="text-[10px] font-semibold mt-0.5 flex-shrink-0 w-12">{label}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-200 leading-tight">{z.action}</p>
        <p className="text-[10px] text-slate-400 mt-0.5">{z.range}</p>
      </div>
    </div>
  );

  return (
    <div className="bg-surface-900 rounded-xl px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-300">결론 (강제 산출)</p>
        <VerdictBadge verdict={verdict} />
      </div>
      {reason && <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">{reason}</p>}
      <div className="space-y-2">
        {zone(zones.aggressive,    'bg-profit/5 border-profit/20',       '적극형')}
        {zone(zones.safe,          'bg-yellow-500/5 border-yellow-500/20', '안전형')}
        {zone(zones.conservative,  'bg-slate-800 border-slate-700',       '보수형')}
      </div>
    </div>
  );
}

function MultiPerspective({ code }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('lynch');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/gemini/analyze-deep?code=${code}`, { headers: authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  if (!data && !loading && !error) {
    return (
      <div className="bg-surface-900 rounded-xl px-4 py-4 text-center space-y-2">
        <p className="text-xs text-slate-400">멀티 에이전트 심층 분석</p>
        <p className="text-[10px] text-slate-600">린치 관점 + 가치투자 관점을 병렬 실행하여 종합 판단</p>
        <button onClick={load} className="mt-1 px-4 py-1.5 bg-brand-500/20 text-brand-400 text-xs rounded-lg">
          심층 분석 실행 (~30초)
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-surface-900 rounded-xl px-4 py-5 text-center space-y-2">
        <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs text-slate-500">두 관점 병렬 분석 중...</p>
        <p className="text-[10px] text-slate-600">린치 + 가치투자 동시 실행</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface-900 rounded-xl px-4 py-4 space-y-2">
        <p className="text-xs text-red-400">{error}</p>
        <button onClick={load} className="px-3 py-1 bg-surface-800 text-slate-400 text-xs rounded-lg">재시도</button>
      </div>
    );
  }

  const tabs = [
    { id: 'lynch', label: '린치 관점' },
    { id: 'value', label: '가치투자' },
    { id: 'synthesis', label: '종합' },
  ];

  const perspective = activeTab === 'synthesis' ? null : data[activeTab];
  const syn = data.synthesis;

  return (
    <div className="bg-surface-900 rounded-xl overflow-hidden">
      <div className="flex border-b border-slate-800">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 py-2 text-[11px] font-medium transition-colors ${
              activeTab === t.id ? 'text-brand-400 border-b-2 border-brand-400' : 'text-slate-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-4 py-3">
        {activeTab === 'synthesis' ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">종합 판단</span>
              <VerdictBadge verdict={syn?.verdict} />
            </div>
            <p className="text-[11px] text-slate-400">{syn?.agreement} · 확신도 {syn?.avgConviction}/5</p>
            {syn?.consensusTarget > 0 && (
              <div className="bg-surface-800 rounded-lg px-3 py-2 flex justify-between items-center">
                <span className="text-[10px] text-slate-500">합산 목표주가</span>
                <span className="text-sm font-bold text-brand-400">{Number(syn.consensusTarget).toLocaleString('ko-KR')}원</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {data.lynch && (
                <div className="bg-profit/5 border border-profit/20 rounded-lg px-2.5 py-2">
                  <p className="text-[9px] text-slate-500 mb-1">린치</p>
                  <VerdictBadge verdict={data.lynch.verdict} />
                  <p className="text-[10px] text-slate-400 mt-1">{data.lynch.pegAssessment}</p>
                </div>
              )}
              {data.value && (
                <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg px-2.5 py-2">
                  <p className="text-[9px] text-slate-500 mb-1">가치투자</p>
                  <VerdictBadge verdict={data.value.verdict} />
                  <p className="text-[10px] text-slate-400 mt-1">{data.value.marginOfSafety?.slice(0, 30)}</p>
                </div>
              )}
            </div>
          </div>
        ) : perspective ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <VerdictBadge verdict={perspective.verdict} />
              <span className="text-[10px] text-slate-500">확신도 {perspective.conviction}/5</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">{perspective.keyReason}</p>
            {perspective.targetPrice > 0 && (
              <div className="bg-surface-800 rounded-lg px-3 py-2 flex justify-between">
                <span className="text-[10px] text-slate-500">목표주가</span>
                <span className="text-sm font-bold text-brand-400">{Number(perspective.targetPrice).toLocaleString('ko-KR')}원</span>
              </div>
            )}
            <p className="text-[10px] text-slate-500">
              {activeTab === 'lynch' ? perspective.pegAssessment : perspective.marginOfSafety}
            </p>
            <p className="text-[10px] text-slate-500">
              {activeTab === 'lynch' ? perspective.storyClarity : perspective.moatAssessment}
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-500 text-center py-4">데이터 없음</p>
        )}
        {data.fromCache && <p className="text-[9px] text-slate-700 text-right mt-2">캐시된 심층 분석</p>}
      </div>
    </div>
  );
}

export default function AIAnalysis({ code }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = useState(false);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/gemini/analyze?code=${code}`, { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'AI 분석 실패');
      setData(json);
      setFetched(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (code && !fetched) load();
  }, [code]);

  if (loading) {
    return (
      <div className="px-4 space-y-3 pt-2">
        {[120, 80, 160, 100].map((w, i) => (
          <div key={i} className="h-4 bg-surface-800 rounded animate-pulse" style={{ width: `${w}px` }} />
        ))}
        <p className="text-xs text-slate-500 mt-4 text-center">Gemini AI 분석 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 pt-2">
        <div className="bg-surface-900 rounded-xl px-4 py-5 text-center space-y-3">
          <p className="text-sm text-slate-400">{error}</p>
          <button onClick={load} className="px-4 py-2 bg-brand-500 text-white text-sm rounded-lg">
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const fmtPrice = (n) => n ? `${Number(n).toLocaleString('ko-KR')}원` : '-';

  return (
    <div className="px-4 pt-2 space-y-3">
      {data.fromCache && (
        <p className="text-[10px] text-slate-600 text-right">캐시된 분석 (24h)</p>
      )}

      {/* Feature 1: 결론 강제 산출 */}
      {data.decision && (
        <DecisionZones decision={data.decision} currentPrice={data.close} />
      )}

      <div className="bg-surface-900 rounded-xl px-4 py-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-slate-500 font-medium">AI 투자 의견</span>
          <OpinionBadge opinion={data.opinion} />
        </div>
        <p className="text-sm text-slate-300 leading-relaxed">{data.summary}</p>
        {data.targetPrice && (
          <div className="mt-3 pt-3 border-t border-slate-800 flex justify-between items-center">
            <span className="text-xs text-slate-500">AI 목표주가 (1년)</span>
            <span className="text-base font-bold text-brand-400">{fmtPrice(data.targetPrice)}</span>
          </div>
        )}
      </div>

      {data.bullCase && (
        <div className="bg-profit/10 border border-profit/20 rounded-xl px-4 py-4">
          <p className="text-xs font-semibold text-profit mb-2">강세 근거 (Bull Case)</p>
          <p className="text-sm text-slate-300 leading-relaxed">{data.bullCase}</p>
        </div>
      )}

      {data.bearCase && (
        <div className="bg-loss/10 border border-loss/20 rounded-xl px-4 py-4">
          <p className="text-xs font-semibold text-loss mb-2">리스크 (Bear Case)</p>
          <p className="text-sm text-slate-300 leading-relaxed">{data.bearCase}</p>
        </div>
      )}

      {/* Feature 5: 멀티 에이전트 병렬 분석 */}
      <MultiPerspective code={code} />

      <p className="text-[10px] text-slate-600 text-center pb-2">
        AI 분석은 투자 참고용이며, 투자 결정의 책임은 본인에게 있습니다.
      </p>
    </div>
  );
}
