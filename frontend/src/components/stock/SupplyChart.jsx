import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

function fmtEok(v) {
  if (v == null || isNaN(v)) return '-';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '+';
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}조`;
  if (abs >= 1000)  return `${sign}${(abs / 1000).toFixed(0)}천억`;
  return `${sign}${abs.toLocaleString()}억`;
}

const INVESTOR_COLORS = {
  foreign: '#22c55e',
  inst:    '#60a5fa',
  indiv:   '#f87171',
};
const INVESTOR_LABELS = { foreign: '외국인', inst: '기관', indiv: '개인' };

export default function SupplyChart({ code }) {
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState('bar'); // bar | line
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    fetch(`/api/supply?code=${code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setRows(d.rows || []); setLoading(false); })
      .catch(() => { setRows([]); setLoading(false); });
  }, [code]);

  if (loading) return null;
  if (!rows || !rows.length) return null;

  const display = rows.slice(0, 20).reverse(); // oldest→newest

  // Compute cumulative
  const cumul = { foreign: 0, inst: 0, indiv: 0 };
  const cumulRows = display.map(r => {
    cumul.foreign += r.foreign;
    cumul.inst    += r.inst;
    cumul.indiv   += r.indiv;
    return { ...r, cf: cumul.foreign, ci: cumul.inst, cd: cumul.indiv };
  });

  // Bar chart scale
  const maxAbs = Math.max(...display.flatMap(r => [Math.abs(r.foreign), Math.abs(r.inst), Math.abs(r.indiv)]));

  return (
    <div className="px-4 mt-4">
      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-300">수급 현황 (최근 20일)</p>
          <div className="flex gap-1">
            {['bar', 'line'].map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                  tab === t ? 'bg-brand-500/20 text-brand-400' : 'text-slate-600 hover:text-slate-400'
                }`}
              >
                {t === 'bar' ? '막대' : '누적'}
              </button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="flex gap-4 px-4 pt-3 pb-1">
          {Object.entries(INVESTOR_LABELS).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: INVESTOR_COLORS[k] }} />
              <span className="text-[10px] text-slate-400">{v}</span>
            </div>
          ))}
        </div>

        {tab === 'bar' && (
          <div className="px-4 pb-4">
            <div className="flex items-end gap-px" style={{ height: 80 }}>
              {display.map((r, i) => (
                <div key={r.date || i} className="flex-1 flex flex-col items-center" style={{ height: 80 }}>
                  {/* Positive bars stack up from center */}
                  <div className="flex-1 flex flex-col justify-end gap-px">
                    {(['foreign', 'inst', 'indiv']).map(k => {
                      const v = r[k];
                      if (v <= 0) return <div key={k} />;
                      const h = maxAbs > 0 ? Math.max((v / maxAbs) * 36, 1) : 0;
                      return <div key={k} style={{ height: h, backgroundColor: INVESTOR_COLORS[k], opacity: 0.85 }} className="w-full" />;
                    })}
                  </div>
                  {/* Negative bars stack down from center */}
                  <div className="flex-1 flex flex-col justify-start gap-px">
                    {(['foreign', 'inst', 'indiv']).map(k => {
                      const v = r[k];
                      if (v >= 0) return <div key={k} />;
                      const h = maxAbs > 0 ? Math.max((Math.abs(v) / maxAbs) * 36, 1) : 0;
                      return <div key={k} style={{ height: h, backgroundColor: INVESTOR_COLORS[k], opacity: 0.5 }} className="w-full" />;
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[9px] text-slate-700">{display[0]?.date?.slice(4, 8)}</span>
              <span className="text-[9px] text-slate-700">{display[display.length - 1]?.date?.slice(4, 8)}</span>
            </div>
          </div>
        )}

        {tab === 'line' && (
          <div className="px-4 pb-4">
            <div className="relative" style={{ height: 80 }}>
              {(['foreign', 'inst', 'indiv']).map(k => {
                const vals = cumulRows.map(r => r[`c${k[0]}`] || (k === 'indiv' ? r.cd : k === 'inst' ? r.ci : r.cf));
                const min = Math.min(...vals), max = Math.max(...vals);
                const range = max - min || 1;
                const pts = vals.map((v, i) => {
                  const x = (i / (vals.length - 1)) * 100;
                  const y = 100 - ((v - min) / range) * 100;
                  return `${x},${y}`;
                }).join(' ');
                return (
                  <svg key={k} className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <polyline points={pts} fill="none" stroke={INVESTOR_COLORS[k]} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  </svg>
                );
              })}
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[9px] text-slate-700">{cumulRows[0]?.date?.slice(4, 8)}</span>
              <span className="text-[9px] text-slate-700">{cumulRows[cumulRows.length - 1]?.date?.slice(4, 8)}</span>
            </div>
          </div>
        )}

        {/* Latest summary */}
        <div className="grid grid-cols-3 gap-0 border-t border-slate-800">
          {(['foreign', 'inst', 'indiv']).map(k => {
            const v = rows[0]?.[k] ?? 0;
            return (
              <div key={k} className="py-2 text-center border-r last:border-r-0 border-slate-800">
                <p className="text-[9px] text-slate-600">{INVESTOR_LABELS[k]} (최근)</p>
                <p className="text-xs font-medium mt-0.5" style={{ color: v >= 0 ? INVESTOR_COLORS[k] : '#94a3b8' }}>
                  {fmtEok(v)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
