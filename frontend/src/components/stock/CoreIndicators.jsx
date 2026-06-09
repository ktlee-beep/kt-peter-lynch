function fmtMarketCap(val) {
  if (!val) return '-';
  if (val >= 10000) return `${(val / 10000).toFixed(1)}조`;
  return `${Math.round(val).toLocaleString('ko-KR')}억`;
}

function Chip({ label, value, sub }) {
  return (
    <div className="flex-1 bg-surface-900 rounded-xl px-3 py-2.5">
      <p className="text-[10px] text-slate-500 mb-1">{label}</p>
      <p className="text-sm font-bold text-white leading-none">{value ?? '-'}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function CoreIndicators({ fundamentals }) {
  if (!fundamentals) {
    return (
      <div className="flex gap-2 px-4 py-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex-1 h-14 bg-surface-900 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  const per = fundamentals.per != null ? fundamentals.per.toFixed(1) + '배' : '-';
  const pbr = fundamentals.pbr != null ? fundamentals.pbr.toFixed(2) + '배' : '-';
  const cap = fmtMarketCap(fundamentals.marketCap);
  const roe = fundamentals.roe != null ? fundamentals.roe.toFixed(1) + '%' : '-';

  return (
    <div className="flex gap-2 px-4 py-2">
      <Chip label="PER" value={per} />
      <Chip label="PBR" value={pbr} />
      <Chip label="시가총액" value={cap} />
      <Chip label="ROE" value={roe} />
    </div>
  );
}
