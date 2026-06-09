import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../contexts/AuthContext';
import StockSearchBar from '../components/discover/StockSearchBar';
import WatchlistSection from '../components/discover/WatchlistSection';
import ScreenerSection from '../components/discover/ScreenerSection';
import New52wSection from '../components/discover/New52wSection';
import SectorBrowser from '../components/discover/SectorBrowser';
import SupplyRanking from '../components/discover/SupplyRanking';

export default function DiscoverPage() {
  const [watchlistRevision, setWatchlistRevision] = useState(0);
  const [addingCode, setAddingCode] = useState(null);
  const navigate = useNavigate();

  const handleSelectStock = useCallback(async (stock) => {
    setAddingCode(stock.code);
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ code: stock.code, name: stock.name, market: stock.market }),
      });
      const d = await r.json();
      if (r.ok) {
        setWatchlistRevision(n => n + 1);
      } else if (d.error?.includes('최대')) {
        alert('관심종목은 최대 30개까지 추가할 수 있습니다');
      }
    } catch {}
    setAddingCode(null);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
      <div className="px-4 pt-5 pb-3">
        <h1 className="text-xl font-bold text-white">발굴</h1>
        <p className="text-xs text-slate-500 mt-0.5">종목 검색 · 관심종목 · 스크리너</p>
      </div>

      <StockSearchBar onSelect={handleSelectStock} />

      {addingCode && (
        <div className="mx-4 mt-2 px-3 py-2 bg-brand-500/10 border border-brand-500/20 rounded-lg flex items-center gap-2">
          <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <span className="text-xs text-brand-400">관심종목 추가 중...</span>
        </div>
      )}

      <WatchlistSection
        refreshTrigger={watchlistRevision}
        onWatchlistChange={() => setWatchlistRevision(n => n + 1)}
      />

      <ScreenerSection />

      <New52wSection />

      <SectorBrowser />

      <SupplyRanking />

      <div className="h-6" />
    </div>
  );
}
