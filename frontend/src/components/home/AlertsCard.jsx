import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

const LEVEL_STYLE = {
  buy:  { bg: 'bg-profit/10', text: 'text-profit',  dot: 'bg-profit' },
  warn: { bg: 'bg-loss/10',   text: 'text-loss',    dot: 'bg-loss' },
  info: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
};

export default function AlertsCard() {
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [wlRes, hldRes] = await Promise.all([
          fetch('/api/watchlist', { headers: authHeaders() }),
          fetch('/api/portfolio/holdings', { headers: authHeaders() }),
        ]);
        const [wl, hld] = await Promise.all([wlRes.json(), hldRes.json()]);

        const codes = new Set();
        (wl.items || []).forEach(i => codes.add(i.code));
        (hld.holdings || []).forEach(h => codes.add(h.code));

        if (!codes.size) { if (!cancelled) { setAlerts([]); setLoading(false); } return; }

        const codeStr = [...codes].join(',');
        const r = await fetch(`/api/alerts?codes=${codeStr}`, { headers: authHeaders() });
        const d = await r.json();
        if (!cancelled) { setAlerts(d.alerts || []); setLoading(false); }
      } catch {
        if (!cancelled) { setAlerts([]); setLoading(false); }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return null;
  if (!alerts || !alerts.length) return null;

  return (
    <section className="px-4 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full bg-loss animate-pulse" />
        <p className="text-xs font-semibold text-slate-300">이상 신호 알림</p>
        <span className="ml-auto text-[10px] text-slate-600">{alerts.length}건</span>
      </div>

      <div className="space-y-2">
        {alerts.map(a => (
          <button
            key={a.code}
            onClick={() => navigate(`/stock?code=${a.code}`)}
            className="w-full bg-surface-900 rounded-xl px-3 py-3 text-left hover:bg-slate-800 transition-colors"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div>
                <span className="text-xs font-semibold text-white">{a.name}</span>
                <span className="text-[10px] text-slate-500 ml-1.5">{a.code}</span>
              </div>
              <div className="text-right">
                <p className="text-xs text-white">{a.price?.toLocaleString('ko-KR')}</p>
                <p className={`text-[10px] ${(a.changeRate || 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {(a.changeRate || 0) > 0 ? '+' : ''}{(a.changeRate || 0).toFixed(2)}%
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-1">
              {a.signal.map((s, i) => {
                const style = LEVEL_STYLE[s.level] || LEVEL_STYLE.info;
                return (
                  <span key={i} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${style.bg} ${style.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
                    {s.text}
                  </span>
                );
              })}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
