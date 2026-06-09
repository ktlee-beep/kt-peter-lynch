import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

function fmtNet(v) {
  if (!v) return '-';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '+';
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}조`;
  if (abs >= 1000)  return `${sign}${(abs / 1000).toFixed(0)}천억`;
  return `${sign}${abs.toLocaleString()}억`;
}

const PERIOD_LABELS = { '1': '당일', '5': '5일', '20': '20일' };
const TYPE_LABELS   = { foreign: '외국인', inst: '기관' };

export default function SupplyRanking() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('foreign');
  const [period, setPeriod] = useState('1');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    setData(null);
    fetch(`/api/supply-ranking?type=${type}&period=${period}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setData({ items: [] }); setLoading(false); });
  }, [type, period]);

  useEffect(() => {
    if (open) load();
  }, [open, type, period, load]);

  return (
    <section className="px-4 mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-1"
      >
        <span className="text-xs font-semibold text-slate-300">외국인/기관 순매수 상위</span>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2">
          {/* Controls */}
          <div className="flex gap-1.5 mb-2">
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <button key={k} onClick={() => setType(k)}
                className={`px-3 py-1 text-[11px] font-medium rounded-lg transition-colors ${
                  type === k ? 'bg-brand-500/20 text-brand-400' : 'bg-surface-800 text-slate-500'
                }`}>
                {v}
              </button>
            ))}
            <div className="flex gap-1 ml-auto">
              {Object.entries(PERIOD_LABELS).map(([k, v]) => (
                <button key={k} onClick={() => setPeriod(k)}
                  className={`px-2 py-1 text-[10px] rounded-lg transition-colors ${
                    period === k ? 'bg-slate-700 text-slate-200' : 'bg-surface-800 text-slate-600'
                  }`}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-8 gap-2">
              <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-slate-500">60개 종목 수급 조회 중...</span>
            </div>
          )}

          {!loading && data?.items?.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-xs text-slate-600">수급 데이터 없음</p>
              <p className="text-[10px] text-slate-700 mt-1">Naver Finance API 일시 불가 또는 데이터 없음</p>
            </div>
          )}

          {!loading && data?.items?.length > 0 && (
            <>
              <div className="space-y-1">
                {data.items.map((item, i) => (
                  <button
                    key={item.code}
                    onClick={() => navigate(`/stock?code=${item.code}`)}
                    className="w-full bg-surface-900 rounded-xl px-3 py-2.5 flex items-center gap-3 hover:bg-slate-800 transition-colors"
                  >
                    <span className="text-[10px] text-slate-600 w-4 text-right flex-shrink-0">{i + 1}</span>
                    <div className="flex-1 text-left min-w-0">
                      <p className="text-xs font-medium text-white truncate">{item.name}</p>
                      <p className="text-[10px] text-slate-600">{item.code}</p>
                    </div>
                    <p className={`text-xs font-medium flex-shrink-0 ${item.net >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {fmtNet(item.net)}
                    </p>
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-slate-700 text-center mt-2">
                {data.total}개 종목 스캔 · {PERIOD_LABELS[period]} 기준 순매수 금액
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
