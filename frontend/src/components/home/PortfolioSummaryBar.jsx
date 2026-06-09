import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

export default function PortfolioSummaryBar() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/portfolio/holdings', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const holdings = d.holdings || [];
        if (!holdings.length) { setLoading(false); return; }

        const totalCost  = holdings.reduce((s, h) => s + (h.avgPrice || 0) * (h.qty || 0), 0);
        const totalValue = holdings.reduce((s, h) => s + (h.currentPrice || h.avgPrice || 0) * (h.qty || 0), 0);
        const gain       = totalValue - totalCost;
        const gainPct    = totalCost > 0 ? (gain / totalCost) * 100 : 0;
        setData({ count: holdings.length, totalValue, gain, gainPct });
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (loading || !data) return null;

  const isGain = data.gain >= 0;
  const fmt = (v) => {
    const abs = Math.abs(v);
    if (abs >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
    if (abs >= 1e4) return `${Math.round(v / 1e4)}만`;
    return Math.round(v).toLocaleString();
  };

  return (
    <button
      onClick={() => navigate('/portfolio')}
      className="mx-4 mt-3 bg-surface-900 rounded-xl px-4 py-3 flex items-center justify-between w-[calc(100%-2rem)] hover:bg-slate-800 active:scale-[0.99] transition-all"
    >
      <div className="text-left">
        <p className="text-[10px] text-slate-500 mb-0.5">내 포트폴리오 · {data.count}종목</p>
        <p className="text-base font-bold text-white">{fmt(data.totalValue)}원</p>
      </div>
      <div className="text-right">
        <p className={`text-sm font-semibold ${isGain ? 'text-green-400' : 'text-red-400'}`}>
          {isGain ? '+' : ''}{fmt(data.gain)}원
        </p>
        <p className={`text-xs ${isGain ? 'text-green-400' : 'text-red-400'}`}>
          {isGain ? '+' : ''}{data.gainPct.toFixed(2)}%
        </p>
      </div>
    </button>
  );
}
