import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

function heatColor(change) {
  if (change > 2)  return { bg: 'bg-profit/30',   text: 'text-profit' };
  if (change > 0.5) return { bg: 'bg-profit/15',  text: 'text-profit' };
  if (change > -0.5) return { bg: 'bg-slate-800', text: 'text-slate-400' };
  if (change > -2) return { bg: 'bg-loss/15',     text: 'text-loss' };
  return { bg: 'bg-loss/30', text: 'text-loss' };
}

export default function SectorBrowser() {
  const [open, setOpen] = useState(false);
  const [sectors, setSectors] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open || sectors !== null) return;
    setLoading(true);
    fetch('/api/sectors', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setSectors(d.sectors || []); setLoading(false); })
      .catch(() => { setSectors([]); setLoading(false); });
  }, [open]);

  const selectedSector = selected ? sectors?.find(s => s.name === selected) : null;

  return (
    <section className="px-4 mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-1"
      >
        <span className="text-xs font-semibold text-slate-300">섹터 브라우저</span>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2">
          {loading && (
            <div className="flex items-center justify-center py-6 gap-2">
              <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-slate-500">로딩 중...</span>
            </div>
          )}

          {!loading && sectors !== null && sectors.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-xs text-slate-600">섹터 데이터 없음 — 스캔 완료 후 사용 가능</p>
            </div>
          )}

          {!loading && sectors !== null && sectors.length > 0 && !selected && (
            <div className="grid grid-cols-3 gap-1.5">
              {sectors.map(s => {
                const { bg, text } = heatColor(s.avgChange);
                return (
                  <button
                    key={s.name}
                    onClick={() => setSelected(s.name)}
                    className={`${bg} rounded-xl px-2 py-3 text-center hover:opacity-80 transition-opacity`}
                  >
                    <p className={`text-[11px] font-semibold ${text}`}>{s.name}</p>
                    <p className={`text-[10px] font-medium mt-0.5 ${text}`}>
                      {s.avgChange > 0 ? '+' : ''}{s.avgChange.toFixed(2)}%
                    </p>
                    <p className="text-[9px] text-slate-600 mt-0.5">{s.count}종목</p>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && selected && selectedSector && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setSelected(null)}
                  className="text-[10px] text-slate-500 hover:text-slate-300"
                >
                  ← 섹터 목록
                </button>
                <span className="text-xs font-semibold text-white">{selected}</span>
                <span className={`text-[10px] font-medium ml-auto ${
                  selectedSector.avgChange >= 0 ? 'text-profit' : 'text-loss'
                }`}>
                  평균 {selectedSector.avgChange > 0 ? '+' : ''}{selectedSector.avgChange.toFixed(2)}%
                </span>
              </div>
              <div className="space-y-1">
                {selectedSector.stocks.map(s => (
                  <button
                    key={s.code}
                    onClick={() => navigate(`/stock?code=${s.code}`)}
                    className="w-full bg-surface-900 rounded-xl px-3 py-2.5 flex items-center justify-between hover:bg-slate-800 transition-colors"
                  >
                    <div className="text-left">
                      <p className="text-xs font-medium text-white">{s.name}</p>
                      <p className="text-[10px] text-slate-600">{s.code}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-white">{s.price?.toLocaleString('ko-KR')}</p>
                      <p className={`text-[10px] ${(s.changeRate || 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {(s.changeRate || 0) > 0 ? '+' : ''}{(s.changeRate || 0).toFixed(2)}%
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
