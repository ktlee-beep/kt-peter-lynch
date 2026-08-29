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
import SeonjeomCard from '../components/stock/SeonjeomCard';
import NewsPulse from '../components/stock/NewsPulse';
import QualityScreen from '../components/stock/QualityScreen';

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
      .then(r => {
        if (!r.ok) throw new Error('관심종목 상태를 불러오지 못했습니다');
        return r.json();
      })
      .then(d => {
        setInWatchlist((d.items || []).some(i => i.code === code));
      })
      .catch(() => {
        setInWatchlist(null);
      });
  }, [code]);

  const handleWatchlistToggle = useCallback(async () => {
    if (!data || toggling) return;
    setToggling(true);
    try {
      if (inWatchlist) {
        const r = await fetch(`/api/watchlist/${code}`, { method: 'DELETE', headers: authHeaders() });
        if (r.ok) setInWatchlist(false);
        else alert('관심종목 삭제에 실패했습니다. 잠시 후 다시 시도해주세요.');
      } else {
        const r = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ code, name: data.name, market: data.market }),
        });
        const d = await r.json();
        if (r.ok) setInWatchlist(true);
        else if (d.error?.includes('최대')) alert('관심종목은 최대 30개까지 추가할 수 있습니다');
        else alert('관심종목 추가에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }
    } catch {
      alert('네트워크 오류로 요청을 처리하지 못했습니다.');
    }
    setToggling(false);
  }, [data, code, inWatchlist, toggling]);

  if (!code) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center pb-20 px-6">
        <div className="w-20 h-20 rounded-2xl bg-surface-900 flex items-center justify-center mb-5">
          <svg className="w-10 h-10 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-300 mb-2">종목을 선택하세요</h2>
        <p className="text-sm text-slate-500 text-center leading-relaxed mb-6">
          발굴 탭에서 관심 종목을 검색하거나<br />관심종목 목록에서 선택하세요
        </p>
        <button
          onClick={() => navigate('/discover')}
          className="px-6 py-3 bg-brand-500 text-white rounded-xl text-sm font-semibold"
        >
          종목 검색하기
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

      {data && (
        <div className="flex gap-2 px-4 pb-2.5 bg-surface-950">
          <button
            onClick={() => navigate(`/report?code=${code}`)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-brand-500/15 text-brand-400 rounded-xl text-xs font-semibold"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            리포트 발행
          </button>
          <button
            onClick={() => navigate('/tools?tool=buy')}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-surface-900 text-slate-300 rounded-xl text-xs font-semibold"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            매수 검토
          </button>
        </div>
      )}

      <div className="flex border-b border-slate-800 bg-surface-950">
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
            <p className="text-sm text-red-400 mb-1">{error}</p>
            <p className="text-xs text-slate-500 mb-4">종목 코드: {code}</p>
            <button
              onClick={() => {
                setError('');
                setLoading(true);
                fetch(`/api/analysis?code=${encodeURIComponent(code)}`, { headers: authHeaders() })
                  .then(r => r.json())
                  .then(d => { if (d.error) { setError(d.error); } else { setData(d); } setLoading(false); })
                  .catch(e => { setError(e.message); setLoading(false); });
              }}
              className="px-4 py-2 bg-surface-900 text-slate-300 text-sm rounded-xl border border-slate-700"
            >
              다시 시도
            </button>
          </div>
        )}

        {!error && loading && !data && tab === '종합' && (
          <div className="space-y-3 pt-2">
            <div className="flex gap-2 px-4">
              {[1,2,3,4].map(i => <div key={i} className="flex-1 h-14 bg-surface-900 rounded-xl animate-pulse" />)}
            </div>
            <div className="mx-4 h-52 bg-surface-900 rounded-xl animate-pulse" />
            <div className="mx-4 h-32 bg-surface-900 rounded-xl animate-pulse" />
            <div className="mx-4 h-28 bg-surface-900 rounded-xl animate-pulse" />
            <div className="space-y-2 px-4">
              {[1,2,3].map(i => <div key={i} className="h-16 bg-surface-900 rounded-xl animate-pulse" />)}
            </div>
          </div>
        )}

        {!error && (!loading || data) && tab === '종합' && (
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
            {code && <SeonjeomCard code={code} />}
            {data && <StockNews code={code} />}
            <div className="h-4" />
          </>
        )}

        {!error && tab === 'AI' && code && (
          <div className="space-y-3 pb-4">
            {data?.changeRate != null && Math.abs(data.changeRate) >= 3 && (
              <div className="px-4">
                <NewsPulse code={code} changeRate={data.changeRate} />
              </div>
            )}
            <div className="px-4">
              <QualityScreen code={code} />
            </div>
            <AIAnalysis code={code} />
          </div>
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
