import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

function fmtEok(v) {
  if (v === null || v === undefined) return '-';
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}조`;
  return `${v.toLocaleString('ko-KR')}억`;
}
function fmtPct(v) {
  if (v === null || v === undefined) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function BarChart({ rows, field, label, color, unit = '억원', formatVal = fmtEok }) {
  if (!rows?.length) return null;
  const values = rows.map(r => r[field]);
  const valid = values.filter(v => v !== null && v !== undefined);
  if (!valid.length) return null;
  const max = Math.max(...valid.map(Math.abs));
  if (max === 0) return null;

  return (
    <div>
      <p className="text-[10px] text-slate-500 mb-2">{label} <span className="text-slate-700">({unit})</span></p>
      <div className="flex items-end gap-1.5 h-24">
        {rows.map((r, i) => {
          const v = r[field];
          const pct = v !== null ? Math.abs(v) / max : 0;
          const neg = v !== null && v < 0;
          return (
            <div key={r.year} className="flex-1 flex flex-col items-center gap-0.5">
              <span className={`text-[9px] ${neg ? 'text-loss' : 'text-slate-400'}`}>
                {v !== null ? formatVal(v) : '-'}
              </span>
              <div
                className="w-full rounded-t-sm transition-all"
                style={{
                  height: v !== null ? `${Math.max(pct * 72, 2)}px` : '2px',
                  backgroundColor: v === null ? '#1e293b' : neg ? '#ef4444' : color,
                  opacity: i === rows.length - 1 ? 1 : 0.7,
                }}
              />
              <span className="text-[9px] text-slate-600">{String(r.year).slice(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineChart({ rows, field, label, color, formatVal = fmtPct }) {
  if (!rows?.length) return null;
  const values = rows.map(r => r[field]).filter(v => v !== null);
  if (values.length < 2) return null;

  const min = Math.min(...values) - 5;
  const max = Math.max(...values) + 5;
  const range = max - min || 1;
  const W = 260, H = 60, padX = 20;
  const pts = rows
    .map((r, i) => {
      if (r[field] === null) return null;
      const x = padX + (i / (rows.length - 1)) * (W - padX * 2);
      const y = H - ((r[field] - min) / range) * H;
      return `${x},${y}`;
    })
    .filter(Boolean);

  return (
    <div>
      <p className="text-[10px] text-slate-500 mb-2">{label}</p>
      <svg viewBox={`0 0 ${W} ${H + 20}`} className="w-full">
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" />
        {rows.map((r, i) => {
          if (r[field] === null) return null;
          const x = padX + (i / (rows.length - 1)) * (W - padX * 2);
          const y = H - ((r[field] - min) / range) * H;
          return (
            <g key={r.year}>
              <circle cx={x} cy={y} r="3" fill={color} />
              <text x={x} y={y - 6} textAnchor="middle" fontSize="8" fill="#94a3b8">{formatVal(r[field])}</text>
              <text x={x} y={H + 14} textAnchor="middle" fontSize="8" fill="#475569">{String(r.year).slice(2)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const CHART_TABS = ['매출/이익', '수익성', '안전성'];

export default function FinancialCharts({ code }) {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('매출/이익');

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    fetch(`/api/financials?code=${code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return; }
        setRows(d.rows || []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [code]);

  if (loading) return (
    <div className="px-4 pt-4 pb-2 space-y-2">
      {[1,2,3].map(i => <div key={i} className="h-28 bg-surface-800 rounded-xl animate-pulse" />)}
    </div>
  );

  if (error) return (
    <div className="px-4 pt-4">
      <div className="bg-surface-900 rounded-xl px-4 py-5 text-center">
        <p className="text-xs text-slate-500">재무 데이터 없음</p>
        <p className="text-[10px] text-slate-700 mt-1">{error}</p>
      </div>
    </div>
  );

  if (!rows) return null;

  const validRows = rows.filter(r => r.revenue !== null);

  return (
    <div className="px-4 pt-4">
      <div className="flex gap-1 mb-3">
        {CHART_TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 text-[11px] rounded-md transition-colors ${
              tab === t ? 'bg-brand-500/20 text-brand-400' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {validRows.length === 0 ? (
        <div className="bg-surface-900 rounded-xl px-4 py-5 text-center">
          <p className="text-xs text-slate-500">DART 연간 재무 데이터가 없습니다</p>
        </div>
      ) : (
        <div className="bg-surface-900 rounded-xl px-4 py-4 space-y-5">
          {tab === '매출/이익' && (
            <>
              <BarChart rows={validRows} field="revenue" label="매출액" color="#3b82f6" />
              <BarChart rows={validRows} field="operatingProfit" label="영업이익" color="#22c55e" />
              <BarChart rows={validRows} field="netIncome" label="당기순이익" color="#a855f7" />
            </>
          )}
          {tab === '수익성' && (
            <>
              <LineChart rows={validRows} field="roe" label="ROE (%)" color="#f59e0b" />
              <LineChart rows={validRows} field="opMargin" label="영업이익률 (%)" color="#22c55e" />
            </>
          )}
          {tab === '안전성' && (
            <>
              <LineChart rows={validRows} field="debtRatio" label="부채비율 (%)" color="#ef4444" formatVal={v => `${v.toFixed(0)}%`} />
              <LineChart rows={validRows} field="currentRatio" label="유동비율 (%)" color="#3b82f6" formatVal={v => `${v.toFixed(0)}%`} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
