import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

export default function WatchlistSection({ refreshTrigger, onWatchlistChange }) {
  const [items,   setItems]   = useState([]);
  const [prices,  setPrices]  = useState({}); // code → { price, changeRate }
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/watchlist', { headers: authHeaders() });
      const d = await r.json();
      const list = d.items || [];
      setItems(list);
      setLoading(false);

      // 가격 배치 로드 (병렬, 결과는 code별로 저장)
      if (list.length > 0) {
        const fetches = list.map(item =>
          fetch(`/api/naver-stock/${item.code}`, { headers: authHeaders() })
            .then(r => r.json())
            .then(p => ({ code: item.code, data: p }))
            .catch(() => ({ code: item.code, data: null }))
        );
        const results = await Promise.all(fetches);
        const map = {};
        results.forEach(({ code, data }) => { if (data?.price) map[code] = data; });
        setPrices(map);
      }
    } catch {
      setItems([]); setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  const remove = async (e, code) => {
    e.stopPropagation();
    try {
      await fetch(`/api/watchlist/${code}`, { method: 'DELETE', headers: authHeaders() });
      setItems(prev => prev.filter(i => i.code !== code));
      setPrices(prev => { const n = { ...prev }; delete n[code]; return n; });
      onWatchlistChange?.();
    } catch {}
  };

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
          <p className="text-sm text-slate-400">관심 종목이 없습니다</p>
          <p className="text-xs text-slate-600 mt-1">위 검색창에서 종목을 추가하세요</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => {
            const p = prices[item.code];
            const up = p ? p.changeRate > 0 : null;
            const dn = p ? p.changeRate < 0 : null;
            return (
              <div
                key={item.code}
                className="flex items-center bg-surface-900 rounded-xl px-4 py-3 gap-3"
              >
                <button
                  className="flex-1 flex items-center gap-3 text-left min-w-0"
                  onClick={() => navigate(`/stock?code=${item.code}`)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate">{item.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[11px] text-slate-500 font-mono">{item.code}</span>
                      <span className={`text-[10px] px-1 py-px rounded font-medium ${
                        item.market === 'KOSPI'  ? 'bg-blue-500/20 text-blue-400' :
                        item.market === 'KOSDAQ' ? 'bg-purple-500/20 text-purple-400' :
                        'bg-slate-700 text-slate-400'
                      }`}>{item.market || '기타'}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {p ? (
                      <>
                        <div className="text-sm font-bold text-white">{p.price.toLocaleString('ko-KR')}</div>
                        <div className={`text-[11px] ${up ? 'text-green-400' : dn ? 'text-red-400' : 'text-slate-400'}`}>
                          {p.changeRate > 0 ? '+' : ''}{p.changeRate?.toFixed(2)}%
                        </div>
                      </>
                    ) : (
                      <div className="w-14 h-8 bg-slate-800 rounded animate-pulse" />
                    )}
                  </div>
                </button>
                <button
                  onClick={(e) => remove(e, item.code)}
                  className="flex-shrink-0 text-slate-700 hover:text-red-400 transition-colors p-1"
                  aria-label="관심종목 삭제"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
