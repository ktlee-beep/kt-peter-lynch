import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';
import StockSearchBar from '../discover/StockSearchBar';

const today = () => new Date().toISOString().slice(0, 10);

export default function TradeForm({ onTradeAdded, initialStock }) {
  const [stock, setStock] = useState(initialStock || null);
  const [tradeType, setTradeType] = useState('buy');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [tradeDate, setTradeDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fetchingPrice, setFetchingPrice] = useState(false);

  useEffect(() => {
    if (initialStock) setStock(initialStock);
  }, [initialStock?.code]);

  const handleSelectStock = (s) => {
    setStock(s);
    setPrice('');
    // Auto-fill current price
    setFetchingPrice(true);
    fetch(`/api/naver-stock/${s.code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (d.price) setPrice(String(d.price)); })
      .catch(() => {})
      .finally(() => setFetchingPrice(false));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stock) { setError('종목을 검색해서 선택하세요'); return; }
    if (!shares || parseInt(shares) <= 0) { setError('주수를 입력하세요'); return; }
    if (!price || parseInt(price) <= 0) { setError('가격을 입력하세요'); return; }
    setError('');
    setSubmitting(true);
    try {
      const r = await fetch('/api/portfolio/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          code: stock.code, name: stock.name, market: stock.market,
          trade_type: tradeType,
          shares: parseInt(shares),
          price: parseInt(price.replace(/,/g, '')),
          trade_date: tradeDate,
          memo,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || '저장 실패'); setSubmitting(false); return; }
      setStock(null);
      setShares('');
      setPrice('');
      setMemo('');
      setTradeDate(today());
      onTradeAdded?.();
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  const totalAmount = price && shares && parseInt(price) > 0 && parseInt(shares) > 0
    ? parseInt(price.replace(/,/g, '')) * parseInt(shares)
    : null;

  return (
    <form onSubmit={handleSubmit} className="px-4 space-y-3 pb-2">
      <div className="flex gap-1 bg-surface-900 rounded-xl p-1">
        {['buy', 'sell'].map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTradeType(t)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              tradeType === t
                ? (t === 'buy' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss')
                : 'text-slate-500'
            }`}
          >
            {t === 'buy' ? '매수' : '매도'}
          </button>
        ))}
      </div>

      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <StockSearchBar onSelect={handleSelectStock} />
      </div>
      {stock && (
        <div className="flex items-center gap-2 px-3 py-2 bg-brand-500/10 border border-brand-500/20 rounded-xl">
          <span className="text-sm font-medium text-white">{stock.name}</span>
          <span className="text-xs text-slate-500 font-mono">{stock.code}</span>
          <button type="button" onClick={() => { setStock(null); setPrice(''); }} className="ml-auto text-slate-500 hover:text-slate-300">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-surface-900 rounded-xl px-3 py-2">
          <label className="text-[10px] text-slate-500">주수</label>
          <input
            type="number" inputMode="numeric" min="1"
            value={shares}
            onChange={e => setShares(e.target.value)}
            placeholder="0"
            className="block w-full bg-transparent text-sm text-white outline-none mt-0.5"
          />
        </div>
        <div className="bg-surface-900 rounded-xl px-3 py-2">
          <div className="flex items-center justify-between">
            <label className="text-[10px] text-slate-500">단가 (원)</label>
            {fetchingPrice && (
              <span className="text-[9px] text-brand-400 animate-pulse">시세 조회중...</span>
            )}
          </div>
          <input
            type="text" inputMode="numeric"
            value={price}
            onChange={e => setPrice(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="0"
            className="block w-full bg-transparent text-sm text-white outline-none mt-0.5"
          />
        </div>
      </div>

      <div className="bg-surface-900 rounded-xl px-3 py-2">
        <label className="text-[10px] text-slate-500">거래일</label>
        <input
          type="date"
          value={tradeDate}
          onChange={e => setTradeDate(e.target.value)}
          className="block w-full bg-transparent text-sm text-white outline-none mt-0.5"
        />
      </div>

      <div className="bg-surface-900 rounded-xl px-3 py-2">
        <label className="text-[10px] text-slate-500">메모 (선택)</label>
        <input
          type="text"
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder="투자 근거..."
          className="block w-full bg-transparent text-sm text-white outline-none mt-0.5 placeholder-slate-600"
        />
      </div>

      {totalAmount != null && (
        <div className="flex items-center justify-between text-xs px-1">
          <span className="text-slate-500">{tradeType === 'buy' ? '매수' : '매도'} 금액</span>
          <span className="text-white font-semibold">{totalAmount.toLocaleString('ko-KR')}원</span>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className={`w-full py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 ${
          tradeType === 'buy' ? 'bg-profit/90 hover:bg-profit text-white' : 'bg-loss/90 hover:bg-loss text-white'
        }`}
      >
        {submitting ? '저장 중...' : (tradeType === 'buy' ? '매수 저장' : '매도 저장')}
      </button>
    </form>
  );
}
