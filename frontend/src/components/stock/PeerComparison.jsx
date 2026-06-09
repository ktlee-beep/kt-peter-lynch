import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

function fmt(v, digits = 1) {
  return v == null ? '-' : v.toFixed(digits);
}

export default function PeerComparison({ code }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!code) return;
    fetch(`/api/peers?code=${code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [code]);

  if (loading) return null;
  if (!data?.peers?.length) return null;

  const peers = data.peers;

  return (
    <div className="px-4 mt-4">
      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-300">동종업계 비교</p>
            <p className="text-[10px] text-slate-600 mt-0.5">{data.sector} · {peers.length}개 종목</p>
          </div>
        </div>

        {/* Table header */}
        <div className="grid grid-cols-5 px-3 py-2 border-b border-slate-800/50">
          {['종목', 'PER', 'PBR', 'ROE', '린치'].map((h, i) => (
            <p key={h} className={`text-[10px] text-slate-600 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</p>
          ))}
        </div>

        {/* Rows */}
        <div className="divide-y divide-slate-800/40">
          {peers.map(p => (
            <button
              key={p.code}
              onClick={() => navigate(`/stock?code=${p.code}`)}
              className={`w-full grid grid-cols-5 px-3 py-2.5 text-right hover:bg-slate-800/40 transition-colors ${
                p.isTarget ? 'bg-brand-500/5' : ''
              }`}
            >
              <div className="text-left">
                <p className={`text-[11px] font-medium truncate ${p.isTarget ? 'text-brand-400' : 'text-white'}`}>
                  {p.name}
                </p>
                <p className={`text-[9px] mt-0.5 ${(p.changeRate || 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {(p.changeRate || 0) > 0 ? '+' : ''}{(p.changeRate || 0).toFixed(2)}%
                </p>
              </div>
              <p className={`text-[11px] self-center ${p.per != null && p.per < 15 ? 'text-profit' : p.per != null && p.per > 30 ? 'text-loss' : 'text-slate-300'}`}>
                {fmt(p.per)}
              </p>
              <p className={`text-[11px] self-center ${p.pbr != null && p.pbr < 1 ? 'text-profit' : 'text-slate-300'}`}>
                {fmt(p.pbr)}
              </p>
              <p className={`text-[11px] self-center ${p.roe != null && p.roe > 15 ? 'text-profit' : 'text-slate-300'}`}>
                {p.roe != null ? `${fmt(p.roe)}%` : '-'}
              </p>
              <p className={`text-[11px] self-center font-medium ${
                p.lynchScore >= 60 ? 'text-profit' : p.lynchScore >= 40 ? 'text-blue-400' : 'text-slate-500'
              }`}>
                {p.lynchScore ?? '-'}
              </p>
            </button>
          ))}
        </div>

        <p className="text-[9px] text-slate-700 text-center py-2">
          최근 7일 스캔 데이터 기준 · 클릭 시 종목 분석 페이지
        </p>
      </div>
    </div>
  );
}
