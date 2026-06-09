import { useState, useMemo } from 'react';

export default function FairValueCalc({ currentPrice, currentPer, lynchScore }) {
  const [growthRate, setGrowthRate] = useState(15);

  const calc = useMemo(() => {
    if (!currentPrice || !currentPer || currentPer <= 0 || growthRate <= 0) return null;
    // PEG=1 기준 적정 PER = 예상 EPS 성장률
    const fairPer = growthRate;
    // 적정가 = 현재가 × (적정PER / 현재PER)
    const fairValue = Math.round(currentPrice * (fairPer / currentPer));
    const safetyMargin = ((fairValue - currentPrice) / fairValue) * 100;
    const peg = currentPer / growthRate;
    return { fairValue, safetyMargin, peg, fairPer };
  }, [currentPrice, currentPer, growthRate]);

  if (!currentPrice || !currentPer) return null;

  const statusColor = !calc ? 'text-slate-500'
    : calc.safetyMargin > 20 ? 'text-profit'
    : calc.safetyMargin > 0  ? 'text-blue-400'
    : 'text-loss';

  const barPct = calc
    ? Math.min(Math.max((currentPrice / calc.fairValue) * 100, 5), 200)
    : 50;

  return (
    <div className="px-4 mt-3">
      <div className="bg-surface-900 rounded-xl px-4 py-4">
        <p className="text-xs font-semibold text-slate-300 mb-3">적정가 계산기 (PEG 기준)</p>

        <div className="mb-4">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[11px] text-slate-400">예상 연간 EPS 성장률</span>
            <span className="text-[11px] text-brand-400 font-medium">{growthRate}%</span>
          </div>
          <input
            type="range" min="1" max="50" step="1"
            value={growthRate}
            onChange={e => setGrowthRate(parseInt(e.target.value))}
            className="w-full accent-brand-400"
          />
          <div className="flex justify-between text-[9px] text-slate-700">
            <span>1%</span><span>25%</span><span>50%</span>
          </div>
        </div>

        {calc && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center mb-3">
              <div>
                <p className="text-[10px] text-slate-500">현재가</p>
                <p className="text-sm font-bold text-white">{currentPrice.toLocaleString('ko-KR')}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">적정가 (PEG=1)</p>
                <p className={`text-sm font-bold ${statusColor}`}>{calc.fairValue.toLocaleString('ko-KR')}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">안전마진</p>
                <p className={`text-sm font-bold ${statusColor}`}>
                  {calc.safetyMargin > 0 ? '+' : ''}{calc.safetyMargin.toFixed(1)}%
                </p>
              </div>
            </div>

            {/* Price bar */}
            <div className="relative h-5 bg-surface-800 rounded-full overflow-hidden mb-2">
              <div
                className="absolute left-0 top-0 h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(barPct, 100)}%`,
                  backgroundColor: calc.safetyMargin > 0 ? '#22c55e40' : '#ef444440',
                }}
              />
              {/* Current price marker */}
              <div
                className="absolute top-0 h-full w-0.5 bg-white"
                style={{ left: `${Math.min(barPct, 100)}%` }}
              />
              <div className="absolute inset-0 flex items-center">
                <span className="text-[10px] text-slate-400 ml-2">현재가</span>
                <div className="flex-1 text-right mr-2">
                  <span className="text-[10px] text-slate-400">적정가</span>
                </div>
              </div>
            </div>

            <div className={`text-center text-xs font-semibold mt-1 ${statusColor}`}>
              {calc.safetyMargin > 20 ? `적정가 대비 ${calc.safetyMargin.toFixed(0)}% 싸게 거래 중`
               : calc.safetyMargin > 0  ? `적정가 대비 ${calc.safetyMargin.toFixed(0)}% 할인`
               : `적정가 대비 ${Math.abs(calc.safetyMargin).toFixed(0)}% 고평가`}
            </div>

            <p className="text-[9px] text-slate-700 text-center mt-1">
              현재 PER {currentPer.toFixed(1)}배 · 적정 PER {calc.fairPer}배 (성장률={growthRate}%)
            </p>
          </>
        )}
      </div>
    </div>
  );
}
