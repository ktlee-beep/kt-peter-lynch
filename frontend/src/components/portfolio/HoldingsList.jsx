import { useNavigate } from 'react-router-dom';

function fmtKRW(n) {
  if (n == null) return null;
  const abs = Math.abs(n);
  if (abs >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (abs >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`;
  return n.toLocaleString('ko-KR');
}

function HoldingItem({ holding, priceInfo }) {
  const navigate = useNavigate();

  const price = priceInfo?.currentPrice ?? null;
  const currentValue = priceInfo?.currentValue ?? null;
  const pnl = priceInfo?.pnl ?? null;
  const pnlPct = priceInfo?.pnlPct ?? null;
  const investedValue = holding.avgPrice * holding.shares;
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
          <span className="text-[11px] text-slate-500">
            {holding.shares}주 · 평단 {holding.avgPrice.toLocaleString('ko-KR')}원
          </span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        {price != null ? (
          <>
            <p className="text-sm font-bold text-white">{fmtKRW(currentValue)}</p>
            <p className={`text-[11px] ${colorCls}`}>
              {up ? '+' : ''}{fmtKRW(pnl)}
              {pnlPct != null && (
                <span className="ml-1">({up ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
              )}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-white">{fmtKRW(investedValue)}</p>
            <div className="w-20 h-3 bg-slate-800 rounded animate-pulse mt-1" />
          </>
        )}
      </div>
    </div>
  );
}

export default function HoldingsList({ holdings, priceMap }) {
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
      <div className="px-4 py-10 text-center">
        <div className="w-14 h-14 rounded-2xl bg-surface-900 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
          </svg>
        </div>
        <p className="text-sm text-slate-400 font-medium">보유 종목이 없습니다</p>
        <p className="text-xs text-slate-600 mt-1">매수 거래를 입력하면 여기에 표시됩니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-4">
      {holdings.map(h => (
        <HoldingItem key={h.code} holding={h} priceInfo={priceMap?.[h.code]} />
      ))}
    </div>
  );
}
