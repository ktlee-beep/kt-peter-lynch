import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const ORDER = ['kospi', 'kosdaq', 'kf', 'sp500', 'nasdaq', 'dow', 'usdkrw', 'us10y', 'vix'];

function fmt(id, price) {
  if (!price) return '-';
  if (id === 'usdkrw') return price.toFixed(2);
  if (id === 'vix' || id === 'us10y') return price.toFixed(2);
  if (price > 1000) return price.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return price.toFixed(2);
}

function IndexCard({ item }) {
  const up = item.changeRate > 0;
  const dn = item.changeRate < 0;
  const colorCls = up ? 'text-green-400' : dn ? 'text-red-400' : 'text-slate-400';

  const isVix = item.id === 'vix';
  const displayUp = isVix ? dn : up;
  const displayCls = isVix
    ? (dn ? 'text-green-400' : up ? 'text-red-400' : 'text-slate-400')
    : colorCls;

  return (
    <div className="flex-shrink-0 bg-surface-900 rounded-xl px-3.5 py-2.5 min-w-[90px]">
      <div className="text-[10px] text-slate-500 mb-1 truncate">{item.name}</div>
      <div className="text-sm font-bold text-white leading-none">{fmt(item.id, item.price)}</div>
      <div className={`text-[11px] mt-1 ${displayCls}`}>
        {item.changeRate != null
          ? `${item.changeRate > 0 ? '+' : ''}${item.changeRate.toFixed(2)}%`
          : '-'}
      </div>
    </div>
  );
}

export default function MarketIndexBar() {
  const [market, setMarket] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/market', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!cancelled) { setMarket(d.market || []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const sorted = ORDER
    .map(id => market.find(m => m.id === id))
    .filter(Boolean);

  if (loading) {
    return (
      <div className="flex gap-2 px-4 overflow-x-auto scrollbar-hide py-1">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-shrink-0 bg-surface-900 rounded-xl px-3.5 py-2.5 min-w-[90px] h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-2 px-4 overflow-x-auto scrollbar-hide py-1">
      {sorted.map(item => <IndexCard key={item.id} item={item} />)}
    </div>
  );
}
