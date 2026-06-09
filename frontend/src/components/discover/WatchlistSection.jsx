import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

function PriceTag({ code }) {
  const [price, setPrice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/naver-stock/${code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!cancelled && d.price) setPrice(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [code]);

  if (!price) return <span className="text-xs text-slate-600">-</span>;

  const up = price.changeRate > 0;
  const dn = price.changeRate < 0;
  return (
    <div className="text-right">
      <div className="text-sm font-bold text-white">{price.price.toLocaleString('ko-KR')}</div>
      <div className={`text-[11px] ${up ? 'text-profit' : dn ? 'text-loss' : 'text-slate-400'}`}>
        {price.changeRate > 0 ? '+' : ''}{price.changeRate?.toFixed(2)}%
      </div>
    </div>
  );
}

export default function WatchlistSection({ refreshTrigger, onWatchlistChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/watchlist', { headers: authHeaders() });
      const d = await r.json();
      setItems(d.items || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  const remove = async (code) => {
    try {
      await fetch(`/api/watchlist/${code}`, { method: 'DELETE', headers: authHeaders() });
      setItems(prev => prev.filter(i => i.code !== code));
      onWatchlistChange?.();
    } catch {}
  };

  const goToStock = (code) => navigate(`/stock?code=${code}`);

  if (loading) {
    return (
      <section className="px-4 mt-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-300">관심종목</h3>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 bg-surface-900 rounded-xl animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 mt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">
          관심종목
          {items.length > 0 && (
            <span className="ml-1.5 text-[11px] text-slate-500 font-normal">{items.length}/30</span>
          )}
        </h3>
      </div>

      {items.length === 0 ? (
        <div className="bg-surface-900 rounded-xl p-6 text-center">
          <p className="text-sm text-slate-500">종목을 검색해서 관심종목에 추가하세요</p>
          <p className="text-xs text-slate-600 mt-1">최대 30개</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <div
              key={item.code}
              className="flex items-center bg-surface-900 rounded-xl px-4 py-3 gap-3"
            >
              <button
                className="flex-1 flex items-center gap-3 text-left min-w-0"
                onClick={() => goToStock(item.code)}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white truncate">{item.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px] text-slate-500 font-mono">{item.code}</span>
                    <span className={`text-[10px] px-1 py-px rounded font-medium ${
                      item.market === 'KOSPI' ? 'bg-blue-500/20 text-blue-400' :
                      item.market === 'KOSDAQ' ? 'bg-purple-500/20 text-purple-400' :
                      'bg-slate-700 text-slate-400'
                    }`}>{item.market || '기타'}</span>
                  </div>
                </div>
                <PriceTag code={item.code} />
              </button>
              <button
                onClick={() => remove(item.code)}
                className="flex-shrink-0 text-slate-600 hover:text-red-400 transition-colors p-1"
                aria-label="관심종목 삭제"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
