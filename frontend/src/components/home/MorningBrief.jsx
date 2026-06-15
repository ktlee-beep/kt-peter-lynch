import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

// 개장 전 AI 아침 브리핑 카드 — 매 영업일 08:00 KST cron이 생성한 최신 1건 표시
export default function MorningBrief() {
  const [brief, setBrief]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen]       = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/brief/morning', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!cancelled) { setBrief(d.brief || null); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="px-4 mt-3">
        <div className="bg-surface-900 rounded-2xl h-20 animate-pulse" />
      </div>
    );
  }
  if (!brief) return null; // 아직 생성 전이면 카드 숨김

  const fut = brief.futures;
  const futCls = fut?.changeRate > 0 ? 'text-green-400' : fut?.changeRate < 0 ? 'text-red-400' : 'text-slate-400';

  return (
    <div className="px-4 mt-3">
      <div className="bg-surface-900 border border-brand-500/20 rounded-2xl p-4">
        <button onClick={() => setOpen(o => !o)} className="w-full flex items-start justify-between gap-2 text-left">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] bg-brand-500/20 text-brand-400 px-1.5 py-0.5 rounded font-medium">아침 브리핑</span>
              {brief.briefDate && <span className="text-[10px] text-slate-600">{brief.briefDate}</span>}
            </div>
            {brief.headline && <p className="text-sm font-bold text-white leading-snug">{brief.headline}</p>}
          </div>
          <svg className={`w-4 h-4 text-slate-500 mt-1 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {open && (
          <div className="mt-3 space-y-3">
            {brief.kospiOutlook && (
              <div>
                <p className="text-[10px] text-slate-500 mb-0.5">오늘 개장 전망</p>
                <p className="text-xs text-slate-200 leading-relaxed">{brief.kospiOutlook}</p>
              </div>
            )}
            {fut?.price != null && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500">코스피200 야간선물</span>
                <span className={`text-xs font-semibold ${futCls}`}>
                  {fut.price?.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}
                  {fut.changeRate != null && ` (${fut.changeRate > 0 ? '+' : ''}${fut.changeRate.toFixed(2)}%)`}
                </span>
              </div>
            )}
            {brief.overnight && (
              <div>
                <p className="text-[10px] text-slate-500 mb-0.5">밤사이 시장</p>
                <p className="text-xs text-slate-400 leading-relaxed">{brief.overnight}</p>
              </div>
            )}
            {brief.picks?.length > 0 && (
              <div>
                <p className="text-[10px] text-slate-500 mb-1.5">주목 종목</p>
                <ul className="space-y-1.5">
                  {brief.picks.map((p, i) => (
                    <li key={i} className="text-xs leading-snug">
                      <span className="text-slate-200 font-medium">{p.name}</span>
                      {p.reason && <span className="text-slate-500"> — {p.reason}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {brief.caution && (
              <div>
                <p className="text-[10px] text-slate-500 mb-0.5">유의</p>
                <p className="text-[11px] text-yellow-400/80 leading-relaxed">{brief.caution}</p>
              </div>
            )}
            {brief.strategy && (
              <div className="bg-slate-800/40 rounded-lg px-3 py-2">
                <p className="text-[11px] text-brand-300 leading-relaxed">{brief.strategy}</p>
              </div>
            )}
            <p className="text-[9px] text-slate-700 text-right">Gemini · 매 영업일 08:00 생성 · 참고용</p>
          </div>
        )}
      </div>
    </div>
  );
}
