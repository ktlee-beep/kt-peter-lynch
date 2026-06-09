import { useState, useMemo } from 'react';

export default function RiskRewardCalc() {
  const [entryPrice, setEntryPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [winRate, setWinRate] = useState('50');

  const num = (v) => parseFloat(String(v).replace(/,/g, '')) || 0;

  const calc = useMemo(() => {
    const entry = num(entryPrice);
    const target = num(targetPrice);
    const stop = num(stopLoss);
    if (!entry || !target || !stop || target <= entry || stop >= entry) return null;

    const reward = ((target - entry) / entry) * 100;
    const risk = ((entry - stop) / entry) * 100;
    const rrRatio = risk > 0 ? reward / risk : 0;

    const wr = parseFloat(winRate) / 100;
    const expectedValue = (wr * reward) - ((1 - wr) * risk);
    const suitable = rrRatio >= 2 && expectedValue > 0;

    return { reward, risk, rrRatio, expectedValue, suitable };
  }, [entryPrice, targetPrice, stopLoss, winRate]);

  return (
    <section className="px-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">손익비 계산기</h3>

      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: '매수 단가', value: entryPrice, setter: setEntryPrice },
            { label: '목표가',   value: targetPrice, setter: setTargetPrice },
            { label: '손절가',   value: stopLoss,    setter: setStopLoss },
          ].map(({ label, value, setter }) => (
            <div key={label} className="bg-surface-900 rounded-xl px-3 py-2.5">
              <label className="text-[10px] text-slate-500">{label}</label>
              <input
                type="text" inputMode="numeric"
                value={value}
                onChange={e => setter(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="0"
                className="block w-full bg-transparent text-sm font-bold text-white outline-none mt-0.5 placeholder-slate-700"
              />
            </div>
          ))}
        </div>

        <div className="bg-surface-900 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <label className="text-[10px] text-slate-500">예상 승률 (%)</label>
            <span className="text-xs text-slate-400">{winRate}%</span>
          </div>
          <input
            type="range" min="10" max="90" step="5"
            value={winRate}
            onChange={e => setWinRate(e.target.value)}
            className="w-full mt-2 accent-brand-400"
          />
          <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
            <span>10%</span><span>50%</span><span>90%</span>
          </div>
        </div>
      </div>

      {calc ? (
        <div className={`mt-3 border rounded-xl px-4 py-4 space-y-3 ${
          calc.suitable ? 'bg-profit/10 border-profit/20' : 'bg-yellow-500/10 border-yellow-500/20'
        }`}>
          <div className="flex justify-between">
            <span className="text-xs text-slate-400">기대 수익률</span>
            <span className="text-sm font-bold text-profit">+{calc.reward.toFixed(2)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-slate-400">최대 손실률</span>
            <span className="text-sm font-bold text-loss">-{calc.risk.toFixed(2)}%</span>
          </div>
          <div className="h-px bg-slate-800" />
          <div className="flex justify-between">
            <span className="text-xs text-slate-400">손익비 (RR)</span>
            <span className={`text-base font-bold ${calc.rrRatio >= 2 ? 'text-profit' : 'text-yellow-400'}`}>
              1 : {calc.rrRatio.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-slate-400">기대값 ({winRate}% 승률)</span>
            <span className={`text-sm font-bold ${calc.expectedValue > 0 ? 'text-profit' : 'text-loss'}`}>
              {calc.expectedValue > 0 ? '+' : ''}{calc.expectedValue.toFixed(2)}%
            </span>
          </div>
          <div className={`text-center text-sm font-semibold mt-1 ${calc.suitable ? 'text-profit' : 'text-yellow-400'}`}>
            {calc.suitable ? '투자 적합 (RR ≥ 2 · 기대값 양수)' : 'RR 비율 또는 기대값을 재검토하세요'}
          </div>
        </div>
      ) : (
        <div className="mt-3 px-4 py-4 bg-surface-900 rounded-xl text-center">
          <p className="text-xs text-slate-500">
            매수 단가, 목표가, 손절가를 입력하세요<br/>
            <span className="text-slate-600">(손절가 &lt; 매수가 &lt; 목표가)</span>
          </p>
        </div>
      )}
    </section>
  );
}
