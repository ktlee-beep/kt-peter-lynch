import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { authHeaders } from '../contexts/AuthContext';
import StockHeader from '../components/stock/StockHeader';
import CoreIndicators from '../components/stock/CoreIndicators';
import ScoreCard from '../components/stock/ScoreCard';
import PriceChart from '../components/stock/PriceChart';
import StockNews from '../components/stock/StockNews';
import AIAnalysis from '../components/stock/AIAnalysis';
import TechIndicatorChart from '../components/stock/TechIndicatorChart';
import FinancialCharts from '../components/stock/FinancialCharts';
import ThesisEditor from '../components/stock/ThesisEditor';
import ThesisValidator from '../components/stock/ThesisValidator';
import PiotroskiChecklist from '../components/stock/PiotroskiChecklist';
import EPSPEGCard from '../components/stock/EPSPEGCard';
import FairValueCalc from '../components/stock/FairValueCalc';
import DCFCalculator from '../components/stock/DCFCalculator';
import DividendCard from '../components/stock/DividendCard';
import PeerComparison from '../components/stock/PeerComparison';
import SupplyChart from '../components/stock/SupplyChart';

const TABS = ['종합', '재무', 'AI', 'Thesis'];

export default function StockPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const code = searchParams.get('code') || '';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('종합');
  const [inWatchlist, setInWatchlist] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    setError('');
    setData(null);
    fetch(`/api/analysis?code=${encodeURIComponent(code)}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setLoading(false); return; }
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [code]);

  useEffect(() => {
    if (!code) return;
    fetch('/api/watchlist', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        setInWatchlist((d.items || []).some(i => i.code === code));
      })
      .catch(() => {});
  }, [code]);

  const handleWatchlistToggle = useCallback(async () => {
    if (!data || toggling) return;
    setToggling(true);
    try {
      if (inWatchlist) {
        await fetch(`/api/watchlist/${code}`, { method: 'DELETE', headers: authHeaders() });
        setInWatchlist(false);
      } else {
        const r = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ code, name: data.name, market: data.market }),
        });
        const d = await r.json();
        if (r.ok) setInWatchlist(true);
        else if (d.error?.includes('최대')) alert('관심종목은 최대 30개까지 추가할 수 있습니다');
      }
    } catch {}
    setToggling(false);
  }, [data, code, inWatchlist, toggling]);

  if (!code) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center pb-20">
        <p className="text-slate-400 text-sm mb-3">종목 코드가 없습니다</p>
        <button
          onClick={() => navigate('/discover')}
          className="text-brand-400 text-sm underline"
        >
          발굴 탭에서 종목을 검색하세요
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <StockHeader
        data={data}
        inWatchlist={inWatchlist}
        onWatchlistToggle={handleWatchlistToggle}
        toggling={toggling}
      />

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
        {error && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <p className="text-xs text-slate-500 mt-1">종목 코드: {code}</p>
          </div>
        )}

        {!error && tab === '종합' && (
          <>
            <CoreIndicators fundamentals={loading ? null : data?.fundamentals} />
            <PriceChart
              candles={data?.candles}
              ma5arr={data?.ma5arr}
              ma20arr={data?.ma20arr}
              ma60arr={data?.ma60arr}
            />
            <TechIndicatorChart candles={data?.candles} />
            {code && <SupplyChart code={code} />}
            <ScoreCard data={loading ? null : data} />
            {data && <StockNews code={code} />}
            <div className="h-4" />
          </>
        )}

        {!error && tab === 'AI' && code && (
          <AIAnalysis code={code} />
        )}

        {!error && tab === '재무' && code && (
          <>
            <FinancialCharts code={code} />
            <EPSPEGCard code={code} per={data?.fundamentals?.per} />
            <FairValueCalc
              currentPrice={data?.candles?.[data.candles.length - 1]?.c}
              currentPer={data?.fundamentals?.per}
            />
            <DCFCalculator
              currentPrice={data?.candles?.[data.candles.length - 1]?.c}
              currentPer={data?.fundamentals?.per}
            />
            <DividendCard fundamentals={data?.fundamentals} />
            {data?.fScore && <PiotroskiChecklist fScore={data.fScore} />}
            <PeerComparison code={code} />
            <div className="h-8" />
          </>
        )}

        {!error && tab === 'Thesis' && code && (
          <>
            <ThesisEditor code={code} name={data?.name || ''} />
            <ThesisValidator code={code} />
            <div className="h-4" />
          </>
        )}
      </div>
    </div>
  );
}
