import { useState, useMemo } from 'react';

const DEFAULT_STOCKS = [
  { id: 1, name: '삼성전자',  targetPct: 30, currentAmt: 3_000_000 },
  { id: 2, name: 'SK하이닉스', targetPct: 20, currentAmt: 1_500_000 },
  { id: 3, name: 'NAVER',      targetPct: 20, currentAmt: 2_500_000 },
  { id: 4, name: '카카오',     targetPct: 15, currentAmt: 800_000  },
  { id: 5, name: '기타 현금', targetPct: 15, currentAmt: 1_200_000 },
];

export default function RebalanceCalc() {
  const [stocks, setStocks] = useState(DEFAULT_STOCKS);
  const [addName, setAddName] = useState('');
  const [addAmt, setAddAmt]   = useState('');
  const [extra, setExtra]     = useState('0');

  const total   = useMemo(() => stocks.reduce((s, x) => s + x.currentAmt, 0), [stocks]);
  const tgtSum  = useMemo(() => stocks.reduce((s, x) => s + x.targetPct, 0), [stocks]);
  const withExtra = total + (parseFloat(extra) || 0);

  const rows = useMemo(() => stocks.map(s => {
    const targetAmt = withExtra * (s.targetPct / 100);
    const diff = targetAmt - s.currentAmt;
    return { ...s, targetAmt, diff };
  }), [stocks, withExtra]);

  const fmt = (v) => {
    const n = Math.round(Math.abs(v));
    if (n >= 1e4) return `${Math.round(n / 1e4)}만`;
    return n.toLocaleString();
  };

  const update = (id, field, val) =>
    setStocks(prev => prev.map(s => s.id === id ? { ...s, [field]: parseFloat(val) || 0 } : s));

  const remove = (id) => setStocks(prev => prev.filter(s => s.id !== id));

  const addStock = () => {
    if (!addName.trim()) return;
    setStocks(prev => [...prev, { id: Date.now(), name: addName, targetPct: 0, currentAmt: parseFloat(addAmt) || 0 }]);
    setAddName(''); setAddAmt('');
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="bg-surface-900 rounded-xl px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-[11px] text-slate-500">현재 총 자산</p>
          <p className="text-lg font-bold text-white">{(total / 1e4).toFixed(0)}만원</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-slate-500">목표 비중 합계</p>
          <p className={`text-lg font-bold ${tgtSum === 100 ? 'text-green-400' : 'text-orange-400'}`}>{tgtSum}%</p>
        </div>
      </div>

      <div className="bg-surface-900 rounded-xl px-3 py-2.5">
        <label className="text-[11px] text-slate-500 block mb-1">추가 투자금 (원)</label>
        <input type="number" value={extra} onChange={e => setExtra(e.target.value)}
          className="w-full bg-transparent text-white text-sm outline-none" placeholder="0" />
      </div>

      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.id} className="bg-surface-900 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <input value={r.name} onChange={e => update(r.id, 'name', e.target.value)}
                className="bg-transparent text-sm font-medium text-white outline-none w-28" />
              <button onClick={() => remove(r.id)} className="text-slate-600 hover:text-red-400 text-xs">삭제</button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-slate-500 mb-1">현재금액(만)</p>
                <input type="number" value={r.currentAmt / 10000} onChange={e => update(r.id, 'currentAmt', (parseFloat(e.target.value) || 0) * 10000)}
                  className="w-full bg-slate-800 rounded px-2 py-1 text-white outline-none" />
              </div>
              <div>
                <p className="text-slate-500 mb-1">목표비중(%)</p>
                <input type="number" value={r.targetPct} onChange={e => update(r.id, 'targetPct', e.target.value)}
                  className="w-full bg-slate-800 rounded px-2 py-1 text-white outline-none" />
              </div>
              <div>
                <p className="text-slate-500 mb-1">조정필요</p>
                <div className={`px-2 py-1 rounded font-medium ${r.diff > 0 ? 'text-green-400' : r.diff < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                  {r.diff > 0 ? '+' : ''}{fmt(r.diff)}만
                </div>
              </div>
            </div>
            <div className="mt-2 bg-slate-800 rounded-full h-1.5">
              <div className="bg-brand-400 h-1.5 rounded-full" style={{ width: `${Math.min((r.currentAmt / Math.max(withExtra, 1)) * 100, 100)}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-slate-600 mt-1">
              <span>현재 {((r.currentAmt / Math.max(total, 1)) * 100).toFixed(1)}%</span>
              <span>목표 {r.targetPct}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-surface-900 rounded-xl p-3 flex gap-2">
        <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="종목명"
          className="flex-1 bg-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none" />
        <input type="number" value={addAmt} onChange={e => setAddAmt(e.target.value)} placeholder="금액(원)"
          className="w-24 bg-slate-800 rounded-lg px-3 py-2 text-sm text-white outline-none" />
        <button onClick={addStock} className="bg-brand-400 text-white rounded-lg px-3 py-2 text-sm font-medium">추가</button>
      </div>
    </div>
  );
}
