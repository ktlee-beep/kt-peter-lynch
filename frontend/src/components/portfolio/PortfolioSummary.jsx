function StatCard({ label, value, subValue, colorClass }) {
  return (
    <div className="flex-1 bg-surface-900 rounded-xl px-3 py-3">
      <p className="text-[10px] text-slate-500 mb-1">{label}</p>
      <p className={`text-sm font-bold leading-none ${colorClass || 'text-white'}`}>{value}</p>
      {subValue && <p className={`text-[11px] mt-1 ${colorClass || 'text-slate-400'}`}>{subValue}</p>}
    </div>
  );
}

function fmtKRW(n) {
  if (n == null) return '-';
  const abs = Math.abs(n);
  if (abs >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (abs >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`;
  return n.toLocaleString('ko-KR');
}

export default function PortfolioSummary({ summary }) {
  if (!summary) {
    return (
      <div className="px-4 py-2 grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 bg-surface-900 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  const { investedAmount, currentValue, totalReturn, totalReturnPct, stockCount } = summary;
  const up = totalReturn > 0;
  const dn = totalReturn < 0;
  const retColor = up ? 'text-profit' : dn ? 'text-loss' : 'text-slate-300';

  return (
    <div className="px-4 py-2 grid grid-cols-2 gap-2">
      <StatCard label="투자 원금" value={fmtKRW(investedAmount)} />
      <StatCard label="평가 금액" value={currentValue != null ? fmtKRW(currentValue) : '-'} />
      <StatCard
        label="평가 손익"
        value={totalReturn != null ? `${up ? '+' : ''}${fmtKRW(totalReturn)}` : '-'}
        subValue={totalReturnPct != null ? `${up ? '+' : ''}${totalReturnPct.toFixed(2)}%` : null}
        colorClass={retColor}
      />
      <StatCard label="보유 종목" value={`${stockCount}개`} />
    </div>
  );
}
