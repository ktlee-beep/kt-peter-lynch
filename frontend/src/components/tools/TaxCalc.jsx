import { useState, useMemo } from 'react';

const TAX_RATE = 0.0022; // 증권거래세 (코스피)
const LOCAL_TAX = 0.11;  // 지방소득세 = 양도세 × 10%

export default function TaxCalc() {
  const [buyPrice,   setBuyPrice]   = useState('50000');
  const [buyQty,     setBuyQty]     = useState('100');
  const [sellPrice,  setSellPrice]  = useState('70000');
  const [sellQty,    setSellQty]    = useState('100');
  const [market,     setMarket]     = useState('KOSPI');
  const [holdYears,  setHoldYears]  = useState('1');
  const [isLargeShareholder, setIsLargeShareholder] = useState(false);

  const result = useMemo(() => {
    const bp = parseFloat(buyPrice)  || 0;
    const bq = parseInt(buyQty)      || 0;
    const sp = parseFloat(sellPrice) || 0;
    const sq = parseInt(sellQty)     || 0;
    const hy = parseFloat(holdYears) || 0;

    const buyAmt  = bp * bq;
    const sellAmt = sp * sq;
    const gain    = sellAmt - buyAmt;

    // 증권거래세 (코스피 0.18% + 농특세 0.15% = 합 0.33%, 코스닥 0.18%)
    const txRate = market === 'KOSPI' ? 0.0033 : market === 'KOSDAQ' ? 0.0018 : 0.0033;
    const txTax  = sellAmt * txRate;

    // 양도세: 소액주주(대주주 아님) → 비과세 (국내 상장 주식)
    // 대주주 or 비상장: 22% (지방세 포함)
    let capitalTax = 0;
    if (isLargeShareholder && gain > 0) {
      const base = gain > 300_000_000 ? gain - 300_000_000 : gain;
      capitalTax = base * 0.22;
    }

    const totalTax = txTax + capitalTax;
    const netProfit = gain - totalTax;

    return { buyAmt, sellAmt, gain, txTax, capitalTax, totalTax, netProfit, txRate };
  }, [buyPrice, buyQty, sellPrice, sellQty, market, holdYears, isLargeShareholder]);

  const fmt = (v) => Math.round(v).toLocaleString('ko-KR');
  const color = (v) => v >= 0 ? 'text-green-400' : 'text-red-400';
  const sign = (v) => v >= 0 ? '+' : '';

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="flex gap-2">
        {['KOSPI', 'KOSDAQ', '코넥스'].map(m => (
          <button key={m} onClick={() => setMarket(m)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${market === m ? 'bg-brand-400 text-white' : 'bg-surface-900 text-slate-400'}`}>
            {m}
          </button>
        ))}
      </div>

      <div className="bg-surface-900 rounded-xl p-4 space-y-3">
        <p className="text-[11px] text-slate-500 font-semibold">매수</p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: '매수가 (원)', value: buyPrice, set: setBuyPrice },
            { label: '매수 수량 (주)', value: buyQty, set: setBuyQty },
          ].map(({ label, value, set }) => (
            <div key={label}>
              <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
              <input type="number" value={value} onChange={e => set(e.target.value)}
                className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none" />
            </div>
          ))}
        </div>
      </div>

      <div className="bg-surface-900 rounded-xl p-4 space-y-3">
        <p className="text-[11px] text-slate-500 font-semibold">매도</p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: '매도가 (원)', value: sellPrice, set: setSellPrice },
            { label: '매도 수량 (주)', value: sellQty, set: setSellQty },
          ].map(({ label, value, set }) => (
            <div key={label}>
              <label className="text-[11px] text-slate-500 block mb-1">{label}</label>
              <input type="number" value={value} onChange={e => set(e.target.value)}
                className="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between bg-surface-900 rounded-xl px-4 py-3">
        <div>
          <p className="text-sm text-white">대주주 여부</p>
          <p className="text-[11px] text-slate-500">지분 1% 이상 또는 10억 이상 보유</p>
        </div>
        <button onClick={() => setIsLargeShareholder(v => !v)}
          className={`w-12 h-6 rounded-full transition-colors ${isLargeShareholder ? 'bg-brand-400' : 'bg-slate-700'}`}>
          <div className={`w-5 h-5 bg-white rounded-full mx-0.5 transition-transform ${isLargeShareholder ? 'translate-x-6' : 'translate-x-0'}`} />
        </button>
      </div>

      <div className="bg-surface-900 rounded-xl p-4 space-y-2.5">
        <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">매수금액</span>
          <span className="text-white">{fmt(result.buyAmt)}원</span>
        </div>
        <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">매도금액</span>
          <span className="text-white">{fmt(result.sellAmt)}원</span>
        </div>
        <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">세전 수익</span>
          <span className={color(result.gain)}>{sign(result.gain)}{fmt(result.gain)}원</span>
        </div>
        <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">증권거래세 ({(result.txRate * 100).toFixed(2)}%)</span>
          <span className="text-red-400">-{fmt(result.txTax)}원</span>
        </div>
        {result.capitalTax > 0 && (
          <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
            <span className="text-slate-400">양도소득세 (22%)</span>
            <span className="text-red-400">-{fmt(result.capitalTax)}원</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-semibold pt-1">
          <span className="text-slate-300">세후 순수익</span>
          <span className={`text-base ${color(result.netProfit)}`}>{sign(result.netProfit)}{fmt(result.netProfit)}원</span>
        </div>
      </div>

      <p className="text-[11px] text-slate-600 px-1">
        * 국내 상장주식 소액주주는 양도세 비과세. 증권거래세는 매도 시 부과.
        코스피 0.18%+농특세 0.15% = 0.33%, 코스닥 0.18%.
      </p>
    </div>
  );
}
