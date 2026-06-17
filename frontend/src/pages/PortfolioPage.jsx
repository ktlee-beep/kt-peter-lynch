import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { authHeaders } from '../contexts/AuthContext';
import PortfolioSummary from '../components/portfolio/PortfolioSummary';
import PortfolioStats from '../components/portfolio/PortfolioStats';
import EarningsCalendar from '../components/portfolio/EarningsCalendar';
import HoldingsList from '../components/portfolio/HoldingsList';
import TradeForm from '../components/portfolio/TradeForm';
import TradeHistory from '../components/portfolio/TradeHistory';

const TABS = ['보유', '통계', '공시', '매매 입력', '매매일지'];

export default function PortfolioPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState('보유');
  const [holdings, setHoldings] = useState(null);
  const [watchlist, setWatchlist] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loadingHoldings, setLoadingHoldings] = useState(false);
  const [portfolioRevision, setPortfolioRevision] = useState(0);
  const [priceMap, setPriceMap] = useState({});
  const [initialStock, setInitialStock] = useState(null);
  const [alertMap, setAlertMap] = useState({});
  const loadingRef = useRef(false);

  // Handle ?action=trade&code=XXX&name=YYY from StockHeader "+" button
  useEffect(() => {
    const action = searchParams.get('action');
    const code = searchParams.get('code');
    const name = searchParams.get('name');
    if (action === 'trade' && code) {
      setTab('매매 입력');
      setInitialStock({ code, name: name || code });
      setSearchParams({}, { replace: true });
    }
  }, []);

  const loadHoldings = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingHoldings(true);
    try {
      const r = await fetch('/api/portfolio/holdings', { headers: authHeaders() });
      const d = await r.json();
      const h = d.holdings || [];
      setHoldings(h);
      const investedAmount = h.reduce((s, x) => s + x.avgPrice * x.shares, 0);
      setSummary({ investedAmount, currentValue: null, totalReturn: null, totalReturnPct: null, stockCount: h.length });
      setPriceMap({});

      if (h.length > 0) {
        const results = await Promise.all(
          h.map(item =>
            fetch(`/api/naver-stock/${item.code}`, { headers: authHeaders() })
              .then(r => r.json())
              .then(p => ({ code: item.code, data: p }))
              .catch(() => ({ code: item.code, data: null }))
          )
        );
        const map = {};
        results.forEach(({ code, data }) => {
          if (!data?.price) return;
          const holding = h.find(x => x.code === code);
          if (!holding) return;
          map[code] = {
            currentPrice: data.price,
            currentValue: data.price * holding.shares,
            pnl: (data.price - holding.avgPrice) * holding.shares,
            pnlPct: ((data.price / holding.avgPrice) - 1) * 100,
          };
        });
        setPriceMap(map);

        const totalCurrentValue = h.reduce((s, x) => s + (map[x.code]?.currentValue ?? x.avgPrice * x.shares), 0);
        const totalReturn = totalCurrentValue - investedAmount;
        setSummary({
          investedAmount,
          currentValue: totalCurrentValue,
          totalReturn,
          totalReturnPct: investedAmount > 0 ? (totalReturn / investedAmount) * 100 : 0,
          stockCount: h.length,
        });
      }
    } catch {}
    setLoadingHoldings(false);
    loadingRef.current = false;
  }, []);

  // 시세만 조용히 재조회 (스켈레톤 깜빡임 없이 priceMap·summary 갱신) — 60초 자동 갱신용
  const refreshPrices = useCallback(async (list) => {
    if (!list || list.length === 0) return;
    try {
      const results = await Promise.all(
        list.map(item =>
          fetch(`/api/naver-stock/${item.code}`, { headers: authHeaders() })
            .then(r => r.json())
            .then(p => ({ code: item.code, data: p }))
            .catch(() => ({ code: item.code, data: null }))
        )
      );
      const map = {};
      results.forEach(({ code, data }) => {
        if (!data?.price) return;
        const holding = list.find(x => x.code === code);
        if (!holding) return;
        map[code] = {
          currentPrice: data.price,
          currentValue: data.price * holding.shares,
          pnl: (data.price - holding.avgPrice) * holding.shares,
          pnlPct: ((data.price / holding.avgPrice) - 1) * 100,
        };
      });
      setPriceMap(map);
      const investedAmount = list.reduce((s, x) => s + x.avgPrice * x.shares, 0);
      const totalCurrentValue = list.reduce((s, x) => s + (map[x.code]?.currentValue ?? x.avgPrice * x.shares), 0);
      const totalReturn = totalCurrentValue - investedAmount;
      setSummary({
        investedAmount,
        currentValue: totalCurrentValue,
        totalReturn,
        totalReturnPct: investedAmount > 0 ? (totalReturn / investedAmount) * 100 : 0,
        stockCount: list.length,
      });
    } catch {}
  }, []);

  // 화면이 보이는 동안 60초마다 시세 자동 갱신 (백그라운드면 정지 → API·배터리 절약)
  useEffect(() => {
    if (!holdings || holdings.length === 0) return;
    const tick = () => { if (document.visibilityState === 'visible') refreshPrices(holdings); };
    const id = setInterval(tick, 60000);
    const onVis = () => { if (document.visibilityState === 'visible') refreshPrices(holdings); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [holdings, refreshPrices]);

  useEffect(() => {
    loadHoldings();
    fetch('/api/watchlist', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setWatchlist(d.items || []))
      .catch(() => {});
    fetch('/api/alert-settings', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        const m = {};
        (d.settings || []).forEach(s => { m[s.code] = s; });
        setAlertMap(m);
      })
      .catch(() => {});
  }, []);

  const handleTradeAdded = () => {
    setPortfolioRevision(n => n + 1);
    setHoldings(null);
    setPriceMap({});
    loadingRef.current = false;
    loadHoldings();
    setTab('보유');
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-3 bg-surface-950">
        <h1 className="text-xl font-bold text-white">포트폴리오</h1>
        <p className="text-xs text-slate-500 mt-0.5">보유종목 · 매매일지 · 공시</p>
      </div>

      <div className="flex border-b border-slate-800 bg-surface-950 overflow-x-auto scrollbar-hide">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-shrink-0 flex-1 py-2.5 text-xs font-medium transition-colors whitespace-nowrap px-1 ${
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
              <HoldingsList holdings={holdings} priceMap={priceMap} alertMap={alertMap} />
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
            <TradeForm onTradeAdded={handleTradeAdded} initialStock={initialStock} />
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
