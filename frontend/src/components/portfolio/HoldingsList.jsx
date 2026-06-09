import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

function HoldingItem({ holding, onPriceLoad }) {
  const [price, setPrice] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/naver-stock/${holding.code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d.price) return;
        setPrice(d.price);
        const pnl = (d.price - holding.avgPrice) * holding.shares;
        const pnlPct = ((d.price / holding.avgPrice) - 1) * 100;
        onPriceLoad?.(holding.code, { currentPrice: d.price, pnl, pnlPct, currentValue: d.price * holding.shares });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [holding.code, holding.avgPrice, holding.shares]);

  const currentValue = price ? price * holding.shares : null;
  const investedValue = holding.avgPrice * holding.shares;
  const pnl = price ? (price - holding.avgPrice) * holding.shares : null;
  const pnlPct = price ? ((price / holding.avgPrice) - 1) * 100 : null;
  const up = pnl > 0;
  const dn = pnl < 0;
  const colorCls = up ? 'text-profit' : dn ? 'text-loss' : 'text-slate-400';

  return (
    <div
      className="flex items-center bg-surface-900 rounded-xl px-4 py-3 gap-3 cursor-pointer hover:bg-slate-800 active:bg-slate-700 transition-colors"
      onClick={() => navigate(`/stock?code=${holding.code}`)}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{holding.name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-slate-500">{holding.shares}주 · 평단 {holding.avgPrice.toLocaleString('ko-KR')}원</span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        {price ? (
          <>
            <p className="text-sm font-bold text-white">{currentValue?.toLocaleString('ko-KR')}</p>
            <p className={`text-[11px] ${colorCls}`}>
              {up ? '+' : ''}{pnl?.toLocaleString('ko-KR')}
              <span className="ml-1">({up ? '+' : ''}{pnlPct?.toFixed(2)}%)</span>
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-white">{investedValue.toLocaleString('ko-KR')}</p>
            <p className="text-[11px] text-slate-600">시세 로딩중...</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function HoldingsList({ holdings, onPriceLoad }) {
  if (!holdings) {
    return (
      <div className="space-y-2 px-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-surface-900 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-slate-500">보유 종목이 없습니다</p>
        <p className="text-xs text-slate-600 mt-1">매수 거래를 입력하면 여기에 표시됩니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-4">
      {holdings.map(h => (
        <HoldingItem key={h.code} holding={h} onPriceLoad={onPriceLoad} />
      ))}
    </div>
  );
}
