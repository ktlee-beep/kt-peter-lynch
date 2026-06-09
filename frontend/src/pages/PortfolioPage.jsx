import { useState, useEffect, useCallback } from 'react';
import { authHeaders } from '../contexts/AuthContext';
import PortfolioSummary from '../components/portfolio/PortfolioSummary';
import PortfolioStats from '../components/portfolio/PortfolioStats';
import EarningsCalendar from '../components/portfolio/EarningsCalendar';
import HoldingsList from '../components/portfolio/HoldingsList';
import TradeForm from '../components/portfolio/TradeForm';
import TradeHistory from '../components/portfolio/TradeHistory';

const TABS = ['보유', '통계', '공시', '매매 입력', '매매일지'];

export default function PortfolioPage() {
  const [tab, setTab] = useState('보유');
  const [holdings, setHoldings] = useState(null);
  const [watchlist, setWatchlist] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loadingHoldings, setLoadingHoldings] = useState(false);
  const [portfolioRevision, setPortfolioRevision] = useState(0);
  const [priceMap, setPriceMap] = useState({});

  const loadHoldings = useCallback(async () => {
    if (loadingHoldings) return;
    setLoadingHoldings(true);
    try {
      const r = await fetch('/api/portfolio/holdings', { headers: authHeaders() });
      const d = await r.json();
      const h = d.holdings || [];
      setHoldings(h);
      setSummary({
        investedAmount: h.reduce((s, x) => s + x.avgPrice * x.shares, 0),
        currentValue: null,
        totalReturn: null,
        totalReturnPct: null,
        stockCount: h.length,
      });
      setPriceMap({});
    } catch {}
    setLoadingHoldings(false);
  }, [loadingHoldings]);

  useEffect(() => {
    loadHoldings();
    fetch('/api/watchlist', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setWatchlist(d.items || []))
      .catch(() => {});
  }, []);

  const handlePriceLoad = useCallback((code, { currentPrice, pnl, pnlPct, currentValue }) => {
    setPriceMap(prev => {
      const next = { ...prev, [code]: { currentPrice, pnl, pnlPct, currentValue } };
      const codes = Object.keys(next);
      const totalCurrentValue = codes.reduce((s, c) => {
        const h = holdings?.find(x => x.code === c);
        return s + (next[c].currentValue || (h ? h.avgPrice * h.shares : 0));
      }, 0);
      const investedAmount = (holdings || []).reduce((s, x) => s + x.avgPrice * x.shares, 0);
      const totalReturn = totalCurrentValue - investedAmount;
      const totalReturnPct = investedAmount > 0 ? (totalReturn / investedAmount) * 100 : 0;
      setSummary(prev => ({
        ...prev,
        currentValue: totalCurrentValue,
        totalReturn,
        totalReturnPct,
      }));
      return next;
    });
  }, [holdings]);

  const handleTradeAdded = () => {
    setPortfolioRevision(n => n + 1);
    setHoldings(null);
    setPriceMap({});
    loadHoldings();
    setTab('보유');
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-3 bg-surface-950">
        <h1 className="text-xl font-bold text-white">포트폴리오</h1>
      </div>

      <div className="flex border-b border-slate-800">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              tab === t
                ? 'text-brand-400 border-b-2 border-brand-400'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
        {tab === '보유' && (
          <>
            <PortfolioSummary summary={summary} />
            <div className="mt-2">
              <HoldingsList holdings={holdings} onPriceLoad={handlePriceLoad} />
            </div>
          </>
        )}

        {tab === '통계' && (
          <div className="pt-2 pb-4">
            <PortfolioStats holdings={holdings} priceMap={priceMap} summary={summary} />
          </div>
        )}

        {tab === '공시' && (
          <EarningsCalendar holdings={holdings} watchlist={watchlist} />
        )}

        {tab === '매매 입력' && (
          <div className="pt-4">
            <TradeForm onTradeAdded={handleTradeAdded} />
          </div>
        )}

        {tab === '매매일지' && (
          <div className="pt-4">
            <TradeHistory refreshTrigger={portfolioRevision} />
          </div>
        )}

        <div className="h-4" />
      </div>
    </div>
  );
}
