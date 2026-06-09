import { useState, useEffect, useCallback } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const TYPE_STYLES = {
  earnings:  { label: '실적',   color: 'text-profit',  bg: 'bg-profit/10'  },
  quarterly: { label: '분기',   color: 'text-blue-400', bg: 'bg-blue-500/10' },
  audit:     { label: '감사',   color: 'text-slate-400', bg: 'bg-slate-800' },
  other:     { label: '공시',   color: 'text-slate-500', bg: 'bg-surface-900' },
};

export default function EarningsCalendar({ holdings, watchlist }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const codes = [...new Set([
      ...(holdings || []).map(h => h.code),
      ...(watchlist || []).map(w => w.code),
    ])].slice(0, 30);
    if (!codes.length) { setItems([]); return; }

    setLoading(true);
    try {
      const r = await fetch(`/api/calendar?codes=${codes.join(',')}`, { headers: authHeaders() });
      const d = await r.json();
      setItems(d.items || []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [holdings, watchlist]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="flex items-center justify-center py-10 gap-2">
      <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
      <span className="text-xs text-slate-500">공시 조회 중...</span>
    </div>
  );

  if (!items || items.length === 0) return (
    <div className="py-10 text-center px-4">
      <p className="text-sm text-slate-500">최근 공시가 없습니다</p>
      <p className="text-xs text-slate-700 mt-1">관심종목·보유종목의 90일 내 DART 공시를 표시합니다</p>
    </div>
  );

  // Group by month
  const groups = {};
  for (const item of items) {
    const month = item.date?.slice(0, 7) || '기타';
    if (!groups[month]) groups[month] = [];
    groups[month].push(item);
  }

  return (
    <div className="px-4 pt-4 space-y-4">
      {Object.entries(groups).map(([month, list]) => (
        <div key={month}>
          <p className="text-[10px] text-slate-600 mb-2 font-medium">{month}</p>
          <div className="space-y-1.5">
            {list.map((item, i) => {
              const s = TYPE_STYLES[item.type] || TYPE_STYLES.other;
              return (
                <a
                  key={i}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 bg-surface-900 rounded-xl px-3 py-2.5 hover:bg-slate-800 transition-colors"
                >
                  <div className={`${s.bg} rounded-lg px-1.5 py-0.5 flex-shrink-0 mt-0.5`}>
                    <span className={`text-[9px] font-medium ${s.color}`}>{s.label}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white truncate">{item.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {item.name && <span className="text-[9px] text-slate-500">{item.name}</span>}
                      <span className="text-[9px] text-slate-700">{item.date}</span>
                    </div>
                  </div>
                  <svg className="w-3.5 h-3.5 text-slate-700 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[9px] text-slate-700 text-center pb-2">DART 공시 데이터 · 최근 90일 기준</p>
    </div>
  );
}
