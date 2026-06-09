import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const SIGNAL_LABELS = {
  buy:  { label: '매수 신호', color: 'text-profit', bg: 'bg-profit/10' },
  sell: { label: '매도 고려', color: 'text-loss', bg: 'bg-loss/10' },
  warn: { label: '주의', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  info: { label: '확인', color: 'text-blue-400', bg: 'bg-blue-500/10' },
};

export default function TodayTodo() {
  const [alerts, setAlerts] = useState([]);
  const [checked, setChecked] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch watchlist + portfolio codes, then get alerts
    Promise.all([
      fetch('/api/watchlist', { headers: authHeaders() }).then(r => r.json()).catch(() => ({ items: [] })),
      fetch('/api/portfolio/holdings', { headers: authHeaders() }).then(r => r.json()).catch(() => ({ holdings: [] })),
    ]).then(([wl, ph]) => {
      const codes = [...new Set([
        ...(wl.items || []).map(i => i.code),
        ...(ph.holdings || []).map(i => i.code),
      ])];
      if (!codes.length) { setLoading(false); return; }
      fetch(`/api/alerts?codes=${codes.join(',')}`, { headers: authHeaders() })
        .then(r => r.json())
        .then(d => { setAlerts(d.alerts || []); setLoading(false); })
        .catch(() => setLoading(false));
    });
  }, []);

  if (loading) return null;
  if (!alerts.length) return null;

  const done = alerts.filter((_, i) => checked[i]).length;

  return (
    <div className="px-4 mt-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-300">오늘 확인할 종목</span>
        <span className="text-[10px] text-slate-500">{done}/{alerts.length} 확인</span>
      </div>
      <div className="space-y-1.5">
        {alerts.map((a, i) => {
          const s = SIGNAL_LABELS[a.level] || SIGNAL_LABELS.info;
          const isDone = !!checked[i];
          return (
            <button
              key={i}
              onClick={() => setChecked(p => ({ ...p, [i]: !p[i] }))}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                isDone ? 'bg-surface-900 opacity-40' : s.bg
              }`}
            >
              <div className={`w-4 h-4 rounded-full flex-shrink-0 border-2 flex items-center justify-center ${
                isDone ? 'border-slate-600 bg-slate-600' : `border-current ${s.color}`
              }`}>
                {isDone && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-medium ${isDone ? 'text-slate-600' : 'text-white'}`}>{a.name}</span>
                  <span className={`text-[9px] font-medium ${isDone ? 'text-slate-700' : s.color}`}>{s.label}</span>
                </div>
                <p className={`text-[10px] mt-0.5 ${isDone ? 'text-slate-700' : 'text-slate-500'}`}>{a.message}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
