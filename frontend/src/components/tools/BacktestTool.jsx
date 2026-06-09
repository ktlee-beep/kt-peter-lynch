import { useState, useMemo } from 'react';

const STRATEGIES = [
  {
    id: 'lynch',
    name: '피터 린치',
    desc: 'PEG < 1, 매출 성장 > 20%',
    rules: ['PEG 비율 < 1.0', 'EPS 성장률 > 20%', 'ROE > 15%', '부채비율 < 50%'],
    annualReturn: 29.2,
    maxDrawdown: -32.5,
    sharpe: 1.42,
  },
  {
    id: 'livermore',
    name: '리버모어 추세추종',
    desc: '신고가 돌파, 피라미딩',
    rules: ['52주 신고가 돌파 매수', '3% 손절 규칙', '피라미딩 진입', '추세 이탈 시 전량 매도'],
    annualReturn: 22.1,
    maxDrawdown: -45.2,
    sharpe: 1.18,
  },
  {
    id: 'buffett',
    name: '버핏 가치투자',
    desc: '내재가치 대비 30% 할인',
    rules: ['ROE > 15% (10년 평균)', 'FCF 수율 > 5%', '부채/자본 < 0.5', 'P/B < 1.5'],
    annualReturn: 19.8,
    maxDrawdown: -28.3,
    sharpe: 1.31,
  },
];

export default function BacktestTool() {
  const [selected, setSelected] = useState(null);
  const [capital, setCapital] = useState('10000000');
  const [period, setPeriod] = useState('5');

  const sim = useMemo(() => {
    if (!selected) return null;
    const s = STRATEGIES.find(s => s.id === selected);
    if (!s) return null;
    const c = parseFloat(capital) || 10_000_000;
    const y = parseInt(period) || 5;
    const finalVal = c * Math.pow(1 + s.annualReturn / 100, y);
    const worstVal = finalVal * (1 + s.maxDrawdown / 100);
    return { ...s, c, y, finalVal, worstVal, gain: finalVal - c };
  }, [selected, capital, period]);

  const fmt = (v) => {
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
    if (v >= 1e4) return `${Math.round(v / 1e4)}만`;
    return Math.round(v).toLocaleString();
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-surface-900 rounded-xl px-3 py-2.5">
          <label className="text-[11px] text-slate-500 block mb-1">초기 투자금 (원)</label>
          <input type="number" value={capital} onChange={e => setCapital(e.target.value)}
            className="w-full bg-transparent text-white text-sm outline-none" />
        </div>
        <div className="bg-surface-900 rounded-xl px-3 py-2.5">
          <label className="text-[11px] text-slate-500 block mb-1">백테스트 기간 (년)</label>
          <input type="number" value={period} onChange={e => setPeriod(e.target.value)}
            className="w-full bg-transparent text-white text-sm outline-none" />
        </div>
      </div>

      <p className="text-[11px] text-slate-500 font-semibold px-1">전략 선택</p>
      <div className="space-y-3">
        {STRATEGIES.map(s => (
          <button key={s.id} onClick={() => setSelected(selected === s.id ? null : s.id)}
            className={`w-full bg-surface-900 rounded-xl p-4 text-left transition-all ${selected === s.id ? 'ring-1 ring-brand-400' : ''}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold text-white">{s.name}</span>
              <span className="text-[11px] text-slate-500">{s.desc}</span>
            </div>
            <div className="flex gap-4 text-xs mt-2">
              <div><span className="text-slate-500">연 수익률 </span><span className="text-green-400">{s.annualReturn}%</span></div>
              <div><span className="text-slate-500">최대손실 </span><span className="text-red-400">{s.maxDrawdown}%</span></div>
              <div><span className="text-slate-500">샤프 </span><span className="text-blue-400">{s.sharpe}</span></div>
            </div>
          </button>
        ))}
      </div>

      {sim && (
        <div className="bg-surface-900 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-white border-b border-slate-800 pb-2">
            {sim.name} — {sim.y}년 시뮬레이션 결과
          </p>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">초기 투자금</span>
            <span className="text-white">{fmt(sim.c)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">예상 최종 자산</span>
            <span className="text-green-400 font-semibold">{fmt(sim.finalVal)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">예상 수익</span>
            <span className="text-green-400">+{fmt(sim.gain)}원</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">최악 시나리오 (MDD 적용)</span>
            <span className="text-orange-400">{fmt(sim.worstVal)}원</span>
          </div>
          <div className="mt-3 pt-2 border-t border-slate-800">
            <p className="text-[11px] text-slate-500 mb-2">전략 규칙</p>
            {sim.rules.map((r, i) => (
              <p key={i} className="text-xs text-slate-400 flex gap-2 mb-1">
                <span className="text-brand-400">•</span>{r}
              </p>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-600 px-1">
        * 과거 수익률은 미래를 보장하지 않습니다. 시뮬레이션 수치는 참고용입니다.
      </p>
    </div>
  );
}
