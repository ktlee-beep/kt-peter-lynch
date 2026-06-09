import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

function pegLabel(peg) {
  if (peg === null || peg === undefined) return { text: '-', color: 'text-slate-500' };
  if (peg < 0)  return { text: '적자 (N/A)', color: 'text-slate-500' };
  if (peg < 0.5) return { text: '극도 저평가', color: 'text-profit' };
  if (peg < 1)   return { text: '저평가 (PEG<1)', color: 'text-profit' };
  if (peg < 1.5) return { text: '적정가치', color: 'text-blue-400' };
  if (peg < 2)   return { text: '약간 고평가', color: 'text-yellow-400' };
  return { text: '고평가 (PEG≥2)', color: 'text-loss' };
}

export default function EPSPEGCard({ code, per }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!code) return;
    fetch(`/api/financials?code=${code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!d.error) setRows(d.rows); })
      .catch(() => {});
  }, [code]);

  if (!rows) return null;

  // Compute approximate EPS from netIncome (억원) and marketCap / price
  // CAGR of net income as EPS proxy (we don't have share count)
  const netIncomes = rows.filter(r => r.netIncome !== null).map(r => r.netIncome);
  if (netIncomes.length < 2) return null;

  const first = netIncomes[0], last = netIncomes[netIncomes.length - 1];
  const years = netIncomes.length - 1;
  let cagr = null;
  if (first > 0 && last > 0 && years > 0) {
    cagr = (Math.pow(last / first, 1 / years) - 1) * 100;
  } else if (first <= 0 && last > 0) {
    cagr = 100; // Recovery case
  }

  const peg = (per != null && cagr != null && cagr > 0) ? per / cagr : null;
  const { text: pegText, color: pegColor } = pegLabel(peg);

  const maxAbs = Math.max(...netIncomes.map(Math.abs));

  return (
    <div className="px-4 mt-3">
      <div className="bg-surface-900 rounded-xl px-4 py-4">
        <p className="text-xs font-semibold text-slate-300 mb-3">EPS 성장률 + PEG</p>

        {/* Bar chart of net income */}
        <div className="flex items-end gap-2 h-16 mb-1">
          {rows.filter(r => r.netIncome !== null).map((r, i, arr) => {
            const pct = maxAbs > 0 ? Math.abs(r.netIncome) / maxAbs : 0;
            const neg = r.netIncome < 0;
            return (
              <div key={r.year} className="flex-1 flex flex-col items-center gap-0.5">
                <span className={`text-[9px] ${neg ? 'text-loss' : 'text-slate-400'}`}>
                  {r.netIncome >= 10000 ? `${(r.netIncome/10000).toFixed(1)}조` : `${r.netIncome.toLocaleString()}억`}
                </span>
                <div
                  className="w-full rounded-t-sm"
                  style={{
                    height: `${Math.max(pct * 48, 2)}px`,
                    backgroundColor: neg ? '#ef4444' : '#a855f7',
                    opacity: i === arr.length - 1 ? 1 : 0.6,
                  }}
                />
                <span className="text-[9px] text-slate-600">{String(r.year).slice(2)}</span>
              </div>
            );
          })}
        </div>

        <div className="h-px bg-slate-800 my-3" />

        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[10px] text-slate-500">순이익 CAGR</p>
            <p className={`text-sm font-bold mt-0.5 ${cagr == null ? 'text-slate-500' : cagr > 0 ? 'text-profit' : 'text-loss'}`}>
              {cagr == null ? '-' : `${cagr > 0 ? '+' : ''}${cagr.toFixed(1)}%`}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-slate-500">PER</p>
            <p className="text-sm font-bold text-white mt-0.5">{per != null ? `${per.toFixed(1)}배` : '-'}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-500">PEG</p>
            <p className={`text-sm font-bold mt-0.5 ${pegColor}`}>
              {peg != null ? peg.toFixed(2) : '-'}
            </p>
          </div>
        </div>

        <div className={`mt-2 text-center text-xs font-semibold ${pegColor}`}>{pegText}</div>

        <p className="text-[9px] text-slate-700 text-center mt-2">
          PEG = PER ÷ 순이익 CAGR. PEG &lt; 1 → 성장 대비 저평가
        </p>
      </div>
    </div>
  );
}
