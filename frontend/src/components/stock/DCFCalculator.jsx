import { useState, useMemo } from 'react';

function dcfValue(eps, growthRate, years, discountRate, terminalGrowth) {
  if (!eps || eps <= 0 || discountRate <= growthRate) return null;
  let pv = 0;
  let cf = eps;
  for (let t = 1; t <= years; t++) {
    cf = cf * (1 + growthRate);
    pv += cf / Math.pow(1 + discountRate, t);
  }
  // Terminal value
  const terminal = (cf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
  pv += terminal / Math.pow(1 + discountRate, years);
  return Math.round(pv);
}

const SCENARIOS = [
  { label: '낙관', key: 'bull', growthMult: 1.5, discountMult: 0.9, color: 'text-profit', bg: 'bg-profit/10' },
  { label: '기본', key: 'base', growthMult: 1.0, discountMult: 1.0, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  { label: '보수', key: 'bear', growthMult: 0.6, discountMult: 1.1, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
];

export default function DCFCalculator({ currentPrice, currentPer }) {
  const [growthRate, setGrowthRate] = useState(12);
  const [discountRate, setDiscountRate] = useState(10);
  const [years, setYears] = useState(10);
  const [terminalGrowth] = useState(2.5);

  const epsProxy = currentPrice && currentPer && currentPer > 0
    ? currentPrice / currentPer
    : null;

  const results = useMemo(() => {
    if (!epsProxy) return null;
    const g = growthRate / 100, r = discountRate / 100, tg = terminalGrowth / 100;
    return SCENARIOS.map(s => {
      const val = dcfValue(epsProxy, g * s.growthMult, years, r * s.discountMult, tg);
      const upside = val && currentPrice ? ((val - currentPrice) / currentPrice) * 100 : null;
      return { ...s, value: val, upside };
    });
  }, [epsProxy, growthRate, discountRate, years, terminalGrowth, currentPrice]);

  if (!currentPrice || !currentPer || currentPer <= 0) return null;

  return (
    <div className="px-4 mt-3">
      <div className="bg-surface-900 rounded-xl px-4 py-4">
        <p className="text-xs font-semibold text-slate-300 mb-3">적정가 계산기 — DCF</p>

        {/* Inputs */}
        <div className="space-y-3 mb-4">
          {[
            { label: '성장률 (고성장 기간)', value: growthRate, set: setGrowthRate, min: 1, max: 40, unit: '%' },
            { label: '할인율 (WACC)', value: discountRate, set: setDiscountRate, min: 5, max: 20, unit: '%' },
            { label: '성장 지속 기간', value: years, set: setYears, min: 3, max: 20, unit: '년' },
          ].map(({ label, value, set, min, max, unit }) => (
            <div key={label}>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[11px] text-slate-400">{label}</span>
                <span className="text-[11px] text-brand-400 font-medium">{value}{unit}</span>
              </div>
              <input type="range" min={min} max={max} step="1" value={value}
                onChange={e => set(parseInt(e.target.value))}
                className="w-full accent-brand-400" />
            </div>
          ))}
        </div>

        {/* EPS proxy note */}
        <p className="text-[9px] text-slate-700 mb-3 text-center">
          EPS 추정치: ₩{Math.round(epsProxy || 0).toLocaleString()} (현재가÷PER) · 터미널 성장률: {terminalGrowth}%
        </p>

        {/* Scenarios */}
        {results && (
          <div className="grid grid-cols-3 gap-2">
            {results.map(s => (
              <div key={s.key} className={`${s.bg} rounded-xl p-2.5 text-center`}>
                <p className="text-[10px] text-slate-500 mb-1">{s.label}</p>
                <p className={`text-sm font-bold ${s.color}`}>
                  {s.value ? `₩${s.value.toLocaleString()}` : '-'}
                </p>
                {s.upside !== null && (
                  <p className={`text-[10px] mt-0.5 font-medium ${s.color}`}>
                    {s.upside > 0 ? '+' : ''}{s.upside.toFixed(0)}%
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex justify-between text-[9px] text-slate-700">
          <span>현재가 ₩{currentPrice.toLocaleString()}</span>
          <span>PER {currentPer.toFixed(1)}배</span>
        </div>
      </div>
    </div>
  );
}
