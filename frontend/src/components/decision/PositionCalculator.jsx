import { useState, useMemo } from 'react';

const SPLITS = [1, 2, 3, 4, 5];

export default function PositionCalculator() {
  const [totalAmount, setTotalAmount] = useState('');
  const [weight, setWeight] = useState('10');
  const [currentPrice, setCurrentPrice] = useState('');
  const [splitCount, setSplitCount] = useState(3);

  const num = (v) => parseInt(String(v).replace(/,/g, '')) || 0;

  const calc = useMemo(() => {
    const total = num(totalAmount);
    const w = parseFloat(weight) / 100;
    const price = num(currentPrice);
    if (!total || !w || !price) return null;

    const alloc = Math.round(total * w);
    const totalShares = Math.floor(alloc / price);
    const perSplit = splitCount > 0 ? Math.floor(totalShares / splitCount) : totalShares;
    const perSplitAmt = perSplit * price;

    return { alloc, totalShares, perSplit, perSplitAmt };
  }, [totalAmount, weight, currentPrice, splitCount]);

  return (
    <section className="px-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">포지션 계산기</h3>

      <div className="space-y-2">
        <div className="bg-surface-900 rounded-xl px-4 py-3">
          <label className="text-[10px] text-slate-500">총 투자 가능 금액 (원)</label>
          <input
            type="text" inputMode="numeric"
            value={totalAmount}
            onChange={e => setTotalAmount(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="10,000,000"
            className="block w-full bg-transparent text-base font-bold text-white outline-none mt-1 placeholder-slate-700"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-surface-900 rounded-xl px-4 py-3">
            <label className="text-[10px] text-slate-500">종목 비중 (%)</label>
            <input
              type="number" min="1" max="100"
              value={weight}
              onChange={e => setWeight(e.target.value)}
              className="block w-full bg-transparent text-base font-bold text-white outline-none mt-1"
            />
          </div>
          <div className="bg-surface-900 rounded-xl px-4 py-3">
            <label className="text-[10px] text-slate-500">현재 주가 (원)</label>
            <input
              type="text" inputMode="numeric"
              value={currentPrice}
              onChange={e => setCurrentPrice(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="0"
              className="block w-full bg-transparent text-base font-bold text-white outline-none mt-1 placeholder-slate-700"
            />
          </div>
        </div>

        <div className="bg-surface-900 rounded-xl px-4 py-3">
          <label className="text-[10px] text-slate-500 block mb-2">분할 매수 횟수</label>
          <div className="flex gap-1.5">
            {SPLITS.map(n => (
              <button
                key={n}
                onClick={() => setSplitCount(n)}
                className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  splitCount === n ? 'bg-brand-500 text-white' : 'bg-surface-800 text-slate-400'
                }`}
              >
                {n}회
              </button>
            ))}
          </div>
        </div>
      </div>

      {calc ? (
        <div className="mt-3 bg-brand-500/10 border border-brand-500/20 rounded-xl px-4 py-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-xs text-slate-400">종목 배분 금액</span>
            <span className="text-sm font-bold text-white">{calc.alloc.toLocaleString('ko-KR')}원</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-slate-400">총 매수 가능 수량</span>
            <span className="text-sm font-bold text-white">{calc.totalShares.toLocaleString('ko-KR')}주</span>
          </div>
          {splitCount > 1 && (
            <>
              <div className="h-px bg-slate-800" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">1회당 수량 ({splitCount}분할)</span>
                <span className="text-sm font-bold text-brand-400">{calc.perSplit.toLocaleString('ko-KR')}주</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">1회당 금액</span>
                <span className="text-sm font-bold text-brand-400">{calc.perSplitAmt.toLocaleString('ko-KR')}원</span>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-3 px-4 py-4 bg-surface-900 rounded-xl text-center">
          <p className="text-xs text-slate-500">금액, 비중, 주가를 입력하면 자동 계산됩니다</p>
        </div>
      )}
    </section>
  );
}
