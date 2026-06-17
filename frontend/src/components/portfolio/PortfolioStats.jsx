function fmtKRW(n) {
  if (n == null) return '-';
  const abs = Math.abs(n);
  if (abs >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (abs >= 10000) return `${Math.round(n / 10000).toLocaleString()}만`;
  return n.toLocaleString();
}

const PIE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#eab308', '#6366f1', '#84cc16'];

export default function PortfolioStats({ holdings, priceMap, summary }) {
  if (!holdings || holdings.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-slate-500">보유 종목이 없습니다</p>
      </div>
    );
  }

  // Build enriched items
  const items = holdings.map(h => {
    const pm = priceMap[h.code];
    const pnl = pm?.pnl ?? 0;
    const pnlPct = pm?.pnlPct ?? 0;
    const currentValue = pm?.currentValue ?? h.avgPrice * h.shares;
    const currentPrice = pm?.currentPrice ?? h.avgPrice;
    return { ...h, pnl, pnlPct, currentValue, currentPrice };
  }).filter(i => priceMap[i.code]);

  const totalInvested = holdings.reduce((s, h) => s + h.avgPrice * h.shares, 0);
  const totalCurrent  = items.reduce((s, i) => s + i.currentValue, 0);
  const totalPnl      = totalCurrent - totalInvested;
  const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  const sortedByReturn = [...items].sort((a, b) => b.pnlPct - a.pnlPct);
  const best  = sortedByReturn[0];
  const worst = sortedByReturn[sortedByReturn.length - 1];

  const maxAbsPct = Math.max(...items.map(i => Math.abs(i.pnlPct)), 1);

  // 비중(allocation) — 현재 평가액 기준, 시세 없으면 원금으로 폴백해 항상 표시
  const allocItems = holdings
    .map(h => ({ code: h.code, name: h.name, value: priceMap[h.code]?.currentValue ?? h.avgPrice * h.shares }))
    .filter(i => i.value > 0)
    .sort((a, b) => b.value - a.value);
  const allocTotal = allocItems.reduce((s, i) => s + i.value, 0);
  // 도넛 세그먼트: 비중(%)과 누적 오프셋을 미리 계산 (렌더 중 변수 재할당 회피)
  const allocSegments = allocItems.map((it, i, arr) => {
    const w = allocTotal > 0 ? (it.value / allocTotal) * 100 : 0;
    const off = arr.slice(0, i).reduce((s, x) => s + (allocTotal > 0 ? (x.value / allocTotal) * 100 : 0), 0);
    return { code: it.code, name: it.name, w, off, color: PIE_COLORS[i % PIE_COLORS.length] };
  });

  return (
    <div className="px-4 pt-4 space-y-4">
      {/* Total return */}
      <div className={`rounded-xl px-4 py-4 text-center ${totalPnl >= 0 ? 'bg-profit/10' : 'bg-loss/10'}`}>
        <p className="text-[10px] text-slate-500 mb-1">전체 수익률</p>
        <p className={`text-2xl font-bold ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
          {totalPnl >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%
        </p>
        <p className={`text-sm font-medium mt-1 ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
          {totalPnl >= 0 ? '+' : ''}{fmtKRW(totalPnl)}
        </p>
        <p className="text-[10px] text-slate-600 mt-1">
          원금 {fmtKRW(totalInvested)} → 평가 {fmtKRW(totalCurrent)}
        </p>
      </div>

      {/* 종목 비중 (도넛) */}
      {allocItems.length > 0 && allocTotal > 0 && (
        <div className="bg-surface-900 rounded-xl px-4 py-4">
          <p className="text-[10px] text-slate-500 mb-3">종목 비중</p>
          <div className="flex items-center gap-4">
            <div className="relative w-28 h-28 flex-shrink-0">
              <svg viewBox="0 0 36 36" className="w-28 h-28 -rotate-90">
                {allocSegments.map((s) => (
                  <circle
                    key={s.code}
                    cx="18" cy="18" r="15.915"
                    fill="none"
                    stroke={s.color}
                    strokeWidth="4"
                    pathLength="100"
                    strokeDasharray={`${s.w} ${100 - s.w}`}
                    strokeDashoffset={-s.off}
                  />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[9px] text-slate-500">종목</span>
                <span className="text-base font-bold text-white">{allocItems.length}</span>
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-1.5">
              {allocSegments.map((s) => (
                <div key={s.code} className="flex items-center gap-1.5 text-[11px]">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
                  <span className="text-slate-300 truncate flex-1">{s.name}</span>
                  <span className="text-slate-400 font-medium flex-shrink-0">{s.w.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Best / Worst */}
      {items.length >= 2 && (
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: '최고 수익', item: best, color: 'text-profit', bg: 'bg-profit/10' },
            { label: '최저 수익', item: worst, color: 'text-loss', bg: 'bg-loss/10' },
          ].map(({ label, item, color, bg }) => (
            <div key={label} className={`${bg} rounded-xl p-3`}>
              <p className="text-[9px] text-slate-500 mb-0.5">{label}</p>
              <p className="text-xs font-medium text-white truncate">{item.name}</p>
              <p className={`text-sm font-bold ${color} mt-0.5`}>
                {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Per-stock bar chart */}
      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <p className="text-[10px] text-slate-500 px-4 pt-3 pb-2">종목별 수익률</p>
        <div className="px-4 pb-4 space-y-2">
          {sortedByReturn.map(item => {
            const barWidth = (Math.abs(item.pnlPct) / maxAbsPct) * 50;
            const pos = item.pnlPct >= 0;
            return (
              <div key={item.code} className="flex items-center gap-2">
                <p className="text-[10px] text-slate-400 w-16 flex-shrink-0 truncate">{item.name}</p>
                <div className="flex-1 flex items-center h-5">
                  <div className="flex-1 flex justify-end pr-0.5">
                    {!pos && (
                      <div
                        className="h-full rounded-sm bg-loss/60"
                        style={{ width: `${barWidth}%` }}
                      />
                    )}
                  </div>
                  <div className="w-px h-full bg-slate-700" />
                  <div className="flex-1 flex justify-start pl-0.5">
                    {pos && (
                      <div
                        className="h-full rounded-sm bg-profit/60"
                        style={{ width: `${barWidth}%` }}
                      />
                    )}
                  </div>
                </div>
                <p className={`text-[10px] font-medium w-14 text-right flex-shrink-0 ${pos ? 'text-profit' : 'text-loss'}`}>
                  {pos ? '+' : ''}{item.pnlPct.toFixed(1)}%
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-stock detail */}
      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <p className="text-[10px] text-slate-500 px-4 pt-3 pb-2">종목별 손익</p>
        <div className="divide-y divide-slate-800">
          {sortedByReturn.map(item => (
            <div key={item.code} className="px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white truncate">{item.name}</p>
                <p className="text-[9px] text-slate-600">
                  {item.shares}주 · 평균 {item.avgPrice.toLocaleString()}원
                </p>
              </div>
              <div className="text-right">
                <p className={`text-xs font-medium ${item.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {item.pnl >= 0 ? '+' : ''}{fmtKRW(item.pnl)}
                </p>
                <p className={`text-[10px] ${item.pnlPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
