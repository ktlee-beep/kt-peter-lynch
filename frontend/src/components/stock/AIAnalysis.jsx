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
          <button
            onClick={load}
            className="px-4 py-2 bg-brand-500 text-white text-sm rounded-lg"
          >
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

      <p className="text-[10px] text-slate-600 text-center pb-2">
        AI 분석은 투자 참고용이며, 투자 결정의 책임은 본인에게 있습니다.
      </p>
    </div>
  );
}
