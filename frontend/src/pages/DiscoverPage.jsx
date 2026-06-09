import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../contexts/AuthContext';
import StockSearchBar from '../components/discover/StockSearchBar';
import WatchlistSection from '../components/discover/WatchlistSection';
import ScreenerSection from '../components/discover/ScreenerSection';
import New52wSection from '../components/discover/New52wSection';
import SectorBrowser from '../components/discover/SectorBrowser';
import SupplyRanking from '../components/discover/SupplyRanking';

// 검색 선택 후 액션 바텀시트
function StockActionSheet({ stock, onClose, onAddWatchlist, adding }) {
  const navigate = useNavigate();
  if (!stock) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-surface-900 rounded-t-2xl px-4 pt-4 pb-8 safe-bottom">
        <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-4" />
        <div className="flex items-center gap-3 mb-4 px-1">
          <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center flex-shrink-0">
            <span className="text-brand-400 text-sm font-bold">{stock.name[0]}</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{stock.name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[11px] text-slate-500 font-mono">{stock.code}</span>
              <span className={`text-[10px] px-1.5 py-px rounded font-medium ${
                stock.market === 'KOSPI' ? 'bg-blue-500/20 text-blue-400' :
                stock.market === 'KOSDAQ' ? 'bg-purple-500/20 text-purple-400' :
                'bg-slate-700 text-slate-400'
              }`}>{stock.market || '기타'}</span>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <button
            onClick={() => { navigate(`/stock?code=${stock.code}`); onClose(); }}
            className="w-full py-3.5 bg-brand-500 text-white rounded-xl text-sm font-semibold"
          >
            종목 분석 보기
          </button>
          <button
            onClick={() => onAddWatchlist(stock)}
            disabled={adding}
            className="w-full py-3.5 bg-surface-800 text-slate-200 rounded-xl text-sm font-medium disabled:opacity-50"
          >
            {adding ? '추가 중...' : '관심종목에 추가'}
          </button>
          <button onClick={onClose} className="w-full py-3 text-slate-500 text-sm">취소</button>
        </div>
      </div>
    </>
  );
}

export default function DiscoverPage() {
  const [watchlistRevision, setWatchlistRevision] = useState(0);
  const [selectedStock, setSelectedStock]         = useState(null);
  const [adding, setAdding]                       = useState(false);

  const handleSearchSelect = useCallback((stock) => {
    setSelectedStock(stock);
  }, []);

  const handleAddWatchlist = useCallback(async (stock) => {
    setAdding(true);
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ code: stock.code, name: stock.name, market: stock.market }),
      });
      const d = await r.json();
      if (r.ok) {
        setWatchlistRevision(n => n + 1);
        setSelectedStock(null);
      } else if (d.error?.includes('최대')) {
        alert('관심종목은 최대 30개까지 추가할 수 있습니다');
      } else if (d.error?.includes('already') || d.error?.includes('이미')) {
        setSelectedStock(null); // 이미 있으면 그냥 닫기
      }
    } catch {}
    setAdding(false);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
      <div className="px-4 pt-5 pb-3">
        <h1 className="text-xl font-bold text-white">발굴</h1>
        <p className="text-xs text-slate-500 mt-0.5">종목 검색 · 관심종목 · 스크리너</p>
      </div>

      <StockSearchBar onSelect={handleSearchSelect} />

      <WatchlistSection
        refreshTrigger={watchlistRevision}
        onWatchlistChange={() => setWatchlistRevision(n => n + 1)}
      />

      <ScreenerSection />

      <New52wSection />

      <SectorBrowser />

      <SupplyRanking />

      <div className="h-6" />

      {selectedStock && (
        <StockActionSheet
          stock={selectedStock}
          onClose={() => setSelectedStock(null)}
          onAddWatchlist={handleAddWatchlist}
          adding={adding}
        />
      )}
    </div>
  );
}
