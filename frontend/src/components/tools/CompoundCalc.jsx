import { useState, useMemo } from 'react';

export default function CompoundCalc() {
  const [init, setInit]     = useState('1000000');
  const [monthly, setMonthly] = useState('300000');
  const [rate, setRate]     = useState('8');
  const [years, setYears]   = useState('20');

  const result = useMemo(() => {
    const P  = parseFloat(init)    || 0;
    const m  = parseFloat(monthly) || 0;
    const r  = (parseFloat(rate) || 0) / 100 / 12;
    const n  = (parseInt(years)   || 0) * 12;
    if (n === 0) return null;
    const fv = r > 0
      ? P * Math.pow(1 + r, n) + m * ((Math.pow(1 + r, n) - 1) / r)
      : P + m * n;
    const invested = P + m * n;
    return { fv, invested, profit: fv - invested };
  }, [init, monthly, rate, years]);

  const fmt = (v) => Math.round(v).toLocaleString('ko-KR');
  const mFmt = (v) => {
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
    if (v >= 1e4) return `${Math.round(v / 1e4)}만`;
    return fmt(v);
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: '초기 투자금 (원)', value: init, set: setInit },
          { label: '월 적립액 (원)',   value: monthly, set: setMonthly },
          { label: '연 수익률 (%)',    value: rate,    set: setRate },
          { label: '투자 기간 (년)',   value: years,   set: setYears },
        ].map(({ label, value, set }) => (
          <div key={label} className="bg-surface-900 rounded-xl px-3 py-2.5">
            <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
            <input
              type="number"
              value={value}
              onChange={e => set(e.target.value)}
              className="w-full bg-transparent text-white text-sm outline-none"
            />
          </div>
        ))}
      </div>

      {result && (
        <div className="bg-surface-900 rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center border-b border-slate-800 pb-3">
            <span className="text-slate-400 text-sm">최종 자산</span>
            <span className="text-xl font-bold text-brand-400">{mFmt(result.fv)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">원금 합계</span>
            <span className="text-white">{mFmt(result.invested)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">수익금</span>
            <span className="text-green-400">+{mFmt(result.profit)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">수익률</span>
            <span className="text-green-400">+{((result.profit / result.invested) * 100).toFixed(1)}%</span>
          </div>
        </div>
      )}

      {result && (
        <div className="bg-surface-900 rounded-xl p-4">
          <p className="text-[11px] text-slate-500 mb-3">연도별 자산 추이</p>
          <div className="space-y-1.5">
            {Array.from({ length: Math.min(parseInt(years) || 0, 30) }, (_, i) => {
              const yr = i + 1;
              const P  = parseFloat(init)    || 0;
              const m  = parseFloat(monthly) || 0;
              const r  = (parseFloat(rate) || 0) / 100 / 12;
              const n  = yr * 12;
              const fv = r > 0 ? P * Math.pow(1 + r, n) + m * ((Math.pow(1 + r, n) - 1) / r) : P + m * n;
              const max = result.fv;
              return (
                <div key={yr} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500 w-8">{yr}년</span>
                  <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                    <div className="bg-brand-400 h-1.5 rounded-full" style={{ width: `${(fv / max) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 w-16 text-right">{mFmt(fv)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
