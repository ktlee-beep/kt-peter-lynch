import { useState, useEffect, useCallback } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

export default function TradeHistory({ refreshTrigger }) {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/portfolio/trades', { headers: authHeaders() });
      const d = await r.json();
      setTrades(d.trades || []);
    } catch {
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  const handleDelete = async (id) => {
    if (!confirm('이 거래를 삭제하시겠습니까?')) return;
    try {
      await fetch(`/api/portfolio/trade/${id}`, { method: 'DELETE', headers: authHeaders() });
      setTrades(prev => prev.filter(t => t.id !== id));
    } catch {}
  };

  if (loading) {
    return (
      <div className="space-y-2 px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 bg-surface-900 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-slate-500">거래 이력이 없습니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-4">
      {trades.map(t => {
        const isBuy = t.trade_type === 'buy';
        const amount = t.shares * t.price;
        return (
          <div key={t.id} className="flex items-center bg-surface-900 rounded-xl px-4 py-3 gap-3">
            <div className={`flex-shrink-0 text-xs font-bold px-2 py-1 rounded ${
              isBuy ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss'
            }`}>
              {isBuy ? '매수' : '매도'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{t.name}</p>
              <p className="text-[11px] text-slate-500">
                {t.trade_date} · {t.shares}주 · {t.price.toLocaleString('ko-KR')}원
              </p>
              {t.memo && <p className="text-[11px] text-slate-600 truncate">{t.memo}</p>}
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm font-medium text-white">{amount.toLocaleString('ko-KR')}</p>
              <button
                onClick={() => handleDelete(t.id)}
                className="text-[11px] text-slate-600 hover:text-red-400 transition-colors"
              >
                삭제
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
