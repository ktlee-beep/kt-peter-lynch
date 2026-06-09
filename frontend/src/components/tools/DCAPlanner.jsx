import { useState, useMemo } from 'react';

export default function DCAPlanner() {
  const [monthly,   setMonthly]   = useState('500000');
  const [price,     setPrice]     = useState('70000');
  const [months,    setMonths]    = useState('12');
  const [targetPct, setTargetPct] = useState('30');
  const [mode,      setMode]      = useState('fixed'); // fixed | increasing

  const schedule = useMemo(() => {
    const m  = parseFloat(monthly)   || 0;
    const p  = parseFloat(price)     || 0;
    const n  = parseInt(months)      || 12;
    const tp = parseFloat(targetPct) || 30;
    if (p === 0) return [];

    const targetPrice = p * (1 + tp / 100);
    let totalInvested = 0, totalShares = 0;
    const rows = [];
    for (let i = 1; i <= Math.min(n, 36); i++) {
      const amt = mode === 'increasing' ? m * (1 + (i - 1) * 0.02) : m;
      const shares = Math.floor(amt / p);
      totalInvested += amt;
      totalShares   += shares;
      const avgCost  = totalShares > 0 ? totalInvested / totalShares : 0;
      const currentVal = totalShares * p;
      rows.push({ month: i, amt, shares, totalInvested, totalShares, avgCost, currentVal, targetPrice });
    }
    return rows;
  }, [monthly, price, months, targetPct, mode]);

  const fmt = (v) => Math.round(v).toLocaleString('ko-KR');
  const last = schedule[schedule.length - 1];

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="flex gap-2 mb-1">
        {[['fixed','고정 매수'], ['increasing','증액 매수']].map(([v, l]) => (
          <button key={v} onClick={() => setMode(v)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${mode === v ? 'bg-brand-400 text-white' : 'bg-surface-900 text-slate-400'}`}>
            {l}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: '월 매수금액 (원)', value: monthly, set: setMonthly },
          { label: '현재가 (원)',      value: price,   set: setPrice },
          { label: '매수 기간 (개월)', value: months,  set: setMonths },
          { label: '목표 수익률 (%)',  value: targetPct, set: setTargetPct },
        ].map(({ label, value, set }) => (
          <div key={label} className="bg-surface-900 rounded-xl px-3 py-2.5">
            <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
            <input type="number" value={value} onChange={e => set(e.target.value)}
              className="w-full bg-transparent text-white text-sm outline-none" />
          </div>
        ))}
      </div>

      {last && (
        <div className="bg-surface-900 rounded-xl p-4 space-y-2">
          <p className="text-[11px] text-slate-500 mb-2 font-semibold">최종 ({months}개월 후)</p>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">총 투자금</span>
            <span className="text-white">{fmt(last.totalInvested)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">보유 주수</span>
            <span className="text-white">{last.totalShares.toLocaleString()}주</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">평균 단가</span>
            <span className="text-white">{fmt(last.avgCost)}원</span>
          </div>
          <div className="flex justify-between text-sm border-t border-slate-800 pt-2">
            <span className="text-slate-400">목표가 ({targetPct}% 수익)</span>
            <span className="text-brand-400">{fmt(last.targetPrice)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">목표 평가금</span>
            <span className="text-green-400">{fmt(last.totalShares * last.targetPrice)}원</span>
          </div>
        </div>
      )}

      {schedule.length > 0 && (
        <div className="bg-surface-900 rounded-xl p-4">
          <p className="text-[11px] text-slate-500 mb-3 font-semibold">월별 매수 스케줄</p>
          <div className="space-y-2 max-h-56 overflow-y-auto scrollbar-hide">
            {schedule.map(r => (
              <div key={r.month} className="flex items-center gap-2 text-xs">
                <span className="text-slate-500 w-8">{r.month}월</span>
                <span className="text-slate-300 w-20">{fmt(r.amt)}원</span>
                <span className="text-slate-400 w-14">{r.shares}주 취득</span>
                <span className="text-slate-500">누적 {r.totalShares}주 / 평단 {fmt(r.avgCost)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
