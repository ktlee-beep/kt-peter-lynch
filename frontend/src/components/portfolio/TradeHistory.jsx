import { useState, useEffect, useCallback } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

export default function TradeHistory({ refreshTrigger }) {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState(null);

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
    try {
      await fetch(`/api/portfolio/trade/${id}`, { method: 'DELETE', headers: authHeaders() });
      setTrades(prev => prev.filter(t => t.id !== id));
    } catch {}
    setConfirmId(null);
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
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-slate-500">거래 이력이 없습니다</p>
        <p className="text-xs text-slate-600 mt-1">매매 입력 탭에서 거래를 기록하세요</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-4">
      {trades.map(t => {
        const isBuy = t.trade_type === 'buy';
        const amount = t.shares * t.price;
        const isConfirming = confirmId === t.id;
        return (
          <div key={t.id} className="bg-surface-900 rounded-xl px-4 py-3">
            <div className="flex items-center gap-3">
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
                {t.memo && <p className="text-[11px] text-slate-600 truncate mt-0.5">{t.memo}</p>}
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-medium text-white">{amount.toLocaleString('ko-KR')}</p>
                {!isConfirming ? (
                  <button
                    onClick={() => setConfirmId(t.id)}
                    className="text-[11px] text-slate-600 hover:text-red-400 transition-colors"
                  >
                    삭제
                  </button>
                ) : (
                  <div className="flex items-center gap-1 mt-0.5">
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="text-[11px] text-red-400 font-medium"
                    >
                      확인
                    </button>
                    <span className="text-slate-700 text-[11px]">·</span>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="text-[11px] text-slate-500"
                    >
                      취소
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
