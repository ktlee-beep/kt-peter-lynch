import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

export default function MarketAIComment() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [open, setOpen]       = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/gemini/market', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setData(d);
        setLoading(false);
      })
      .catch(e => {
        if (!cancelled) { setError(e.message); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="px-4 mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] bg-brand-500/20 text-brand-400 px-1.5 py-0.5 rounded font-medium">AI</span>
          <span className="text-xs font-semibold text-slate-300">시장 AI 코멘트</span>
          {loading && (
            <div className="w-3 h-3 border-2 border-brand-400/50 border-t-transparent rounded-full animate-spin" />
          )}
          {!loading && !error && data?.summary && (
            <span className="text-[10px] text-slate-500 max-w-[120px] truncate">{data.phase}</span>
          )}
        </div>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 bg-surface-900 rounded-xl p-4">
          {loading && (
            <div className="flex items-center gap-2 py-3 justify-center">
              <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-slate-500">Gemini 분석 중...</span>
            </div>
          )}

          {!loading && error && (
            <div className="space-y-2">
              <p className="text-xs text-red-400">{error}</p>
              <button
                onClick={() => {
                  setError(''); setLoading(true); setData(null);
                  fetch('/api/gemini/market', { headers: authHeaders() })
                    .then(r => r.json())
                    .then(d => { if (d.error) setError(d.error); else setData(d); setLoading(false); })
                    .catch(e => { setError(e.message); setLoading(false); });
                }}
                className="text-[11px] text-brand-400 hover:text-brand-300"
              >
                다시 시도
              </button>
            </div>
          )}

          {!loading && !error && data && (
            <div className="space-y-3">
              {data.phase && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500">시장 국면</span>
                  <span className="text-xs font-semibold text-brand-400">{data.phase}</span>
                </div>
              )}
              {data.summary && (
                <p className="text-xs text-slate-300 leading-relaxed">{data.summary}</p>
              )}
              {data.strategy && (
                <div>
                  <p className="text-[10px] text-slate-500 mb-1">투자 전략</p>
                  <p className="text-xs text-slate-400 leading-relaxed">{data.strategy}</p>
                </div>
              )}
              {data.watchlist?.length > 0 && (
                <div>
                  <p className="text-[10px] text-slate-500 mb-1.5">관심 섹터</p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.watchlist.map((w, i) => (
                      <span key={i} className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">{w}</span>
                    ))}
                  </div>
                </div>
              )}
              {data.risks?.length > 0 && (
                <div>
                  <p className="text-[10px] text-slate-500 mb-1.5">주요 리스크</p>
                  <ul className="space-y-1">
                    {data.risks.map((r, i) => (
                      <li key={i} className="text-[11px] text-yellow-400/80 flex gap-1.5">
                        <span className="flex-shrink-0">•</span><span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-[9px] text-slate-700 text-right">Gemini · AI 생성 참고용</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
