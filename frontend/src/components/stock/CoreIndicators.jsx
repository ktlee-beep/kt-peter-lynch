function fmtMarketCap(val) {
  if (!val) return '-';
  if (val >= 10000) return `${(val / 10000).toFixed(1)}조`;
  return `${Math.round(val).toLocaleString('ko-KR')}억`;
}

function Chip({ label, value, sub }) {
  return (
    <div className="flex-shrink-0 flex-1 min-w-[56px] bg-surface-900 rounded-xl px-3 py-2.5">
      <p className="text-[10px] text-slate-500 mb-1 truncate">{label}</p>
      <p className="text-sm font-bold text-white leading-none truncate">{value ?? '-'}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function CoreIndicators({ fundamentals }) {
  if (!fundamentals) {
    return (
      <div className="flex gap-1.5 px-4 py-2 overflow-x-auto scrollbar-hide">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex-shrink-0 flex-1 min-w-[56px] h-14 bg-surface-900 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  const per = fundamentals.per != null ? fundamentals.per.toFixed(1) + '배' : '-';
  const pbr = fundamentals.pbr != null ? fundamentals.pbr.toFixed(2) + '배' : '-';
  const cap = fmtMarketCap(fundamentals.marketCap);
  const roe = fundamentals.roe != null ? fundamentals.roe.toFixed(1) + '%' : '-';
  const divYield = fundamentals.dividendYield != null
    ? fundamentals.dividendYield.toFixed(2) + '%'
    : null;
  const eps = fundamentals.eps != null
    ? (Math.abs(fundamentals.eps) >= 10000
      ? (fundamentals.eps / 10000).toFixed(1) + '만'
      : fundamentals.eps.toLocaleString('ko-KR'))
    : null;
  const fifthLabel = divYield != null ? '배당수익률' : eps != null ? 'EPS' : null;
  const fifthValue = divYield ?? eps ?? null;

  return (
    <div className="flex gap-1.5 px-4 py-2 overflow-x-auto scrollbar-hide">
      <Chip label="PER" value={per} />
      <Chip label="PBR" value={pbr} />
      <Chip label="시가총액" value={cap} />
      <Chip label="ROE" value={roe} />
      {fifthLabel && <Chip label={fifthLabel} value={fifthValue} />}
    </div>
  );
}
