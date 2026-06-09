import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

export default function New52wSection() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('high');
  const [data, setData] = useState({ high: null, low: null });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    if (data[tab] !== null) return;
    setLoading(true);
    fetch(`/api/52w?direction=${tab}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        setData(prev => ({ ...prev, [tab]: d.items || [] }));
        setLoading(false);
      })
      .catch(() => {
        setData(prev => ({ ...prev, [tab]: [] }));
        setLoading(false);
      });
  }, [open, tab]);

  const handleTabSwitch = (t) => {
    if (t !== tab) { setTab(t); setLoading(data[t] === null); }
  };

  const items = data[tab];

  return (
    <section className="px-4 mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-1"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">52주 신고가 / 신저가</span>
          {items !== null && (
            <span className="text-[10px] text-slate-600">{items.length}종목</span>
          )}
        </div>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2">
          <div className="flex gap-2 mb-2">
            {['high', 'low'].map(t => (
              <button
                key={t}
                onClick={() => handleTabSwitch(t)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  tab === t
                    ? t === 'high' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss'
                    : 'bg-surface-800 text-slate-500'
                }`}
              >
                {t === 'high' ? '52주 신고가' : '52주 신저가'}
              </button>
            ))}
          </div>

          {loading && (
            <div className="flex items-center justify-center py-6 gap-2">
              <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-slate-500">조회 중...</span>
            </div>
          )}

          {!loading && items !== null && items.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-xs text-slate-600">해당 신호 종목 없음</p>
              <p className="text-[10px] text-slate-700 mt-1">스캔 데이터가 없거나 해당 조건 종목이 없습니다</p>
            </div>
          )}

          {!loading && items !== null && items.length > 0 && (
            <div className="space-y-1">
              {items.map(item => (
                <button
                  key={item.code}
                  onClick={() => navigate(`/stock?code=${item.code}`)}
                  className="w-full bg-surface-900 rounded-xl px-3 py-2.5 flex items-center justify-between hover:bg-slate-800 transition-colors"
                >
                  <div className="text-left min-w-0 flex-1">
                    <p className="text-xs font-medium text-white truncate">{item.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-slate-600">{item.code}</span>
                      {item.lynchScore != null && (
                        <span className="text-[10px] text-brand-400">린치 {item.lynchScore}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <p className="text-xs font-medium text-white">{item.price?.toLocaleString('ko-KR')}</p>
                    <p className={`text-[10px] ${(item.changeRate || 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {(item.changeRate || 0) > 0 ? '+' : ''}{(item.changeRate || 0).toFixed(2)}%
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
