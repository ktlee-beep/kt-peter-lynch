import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

export default function New52wSection() {
  const [tab, setTab]     = useState('high');
  const [data, setData]   = useState({ high: null, low: null });
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (data[tab] !== null) return;
    setLoading(true);
    fetch(`/api/52w?direction=${tab}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setData(prev => ({ ...prev, [tab]: d.items || [] })); setLoading(false); })
      .catch(() => { setData(prev => ({ ...prev, [tab]: [] })); setLoading(false); });
  }, [tab]);

  const items = data[tab];

  return (
    <section className="px-4 mt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">52주 신고가 / 신저가</h3>
        {items !== null && !loading && (
          <span className="text-[11px] text-slate-500">{items.length}종목</span>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        {['high', 'low'].map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); if (!data[t]) setLoading(true); }}
            className={`flex-1 py-2 rounded-xl text-xs font-medium transition-colors ${
              tab === t
                ? t === 'high' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                : 'bg-surface-900 text-slate-500'
            }`}
          >
            {t === 'high' ? '신고가' : '신저가'}
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-surface-900 rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {!loading && items !== null && items.length === 0 && (
        <div className="bg-surface-900 rounded-xl py-6 text-center">
          <p className="text-sm text-slate-500">스캔 데이터 없음</p>
          <p className="text-xs text-slate-600 mt-1">일일 스캔(20:00 KST) 후 사용 가능합니다</p>
        </div>
      )}

      {!loading && items !== null && items.length > 0 && (
        <div className="space-y-1.5">
          {items.slice(0, 15).map(item => (
            <button
              key={item.code}
              onClick={() => navigate(`/stock?code=${item.code}`)}
              className="w-full bg-surface-900 rounded-xl px-3 py-2.5 flex items-center justify-between hover:bg-slate-800 transition-colors"
            >
              <div className="text-left min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">{item.name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-slate-600 font-mono">{item.code}</span>
                  {item.lynchScore != null && (
                    <span className="text-[10px] text-brand-400">린치 {item.lynchScore}</span>
                  )}
                </div>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                <p className="text-sm font-medium text-white">{item.price?.toLocaleString('ko-KR')}</p>
                <p className={`text-[11px] ${(item.changeRate || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {(item.changeRate || 0) > 0 ? '+' : ''}{(item.changeRate || 0).toFixed(2)}%
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
