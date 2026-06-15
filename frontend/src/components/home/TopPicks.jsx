import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

const TABS = [
  { id: 'kr', label: '한국' },
  { id: 'sector', label: '섹터' },
  { id: 'us', label: '미국' },
];

const scoreColor = (s) => s >= 70 ? 'text-green-400' : s >= 50 ? 'text-brand-400' : 'text-slate-400';
const chgColor = (c) => c > 0 ? 'text-green-400' : c < 0 ? 'text-red-400' : 'text-slate-400';
const fmtChg = (c) => c == null ? '' : `${c > 0 ? '+' : ''}${Number(c).toFixed(1)}%`;

export default function TopPicks() {
  const [tab, setTab] = useState('kr');
  const [cache, setCache] = useState({});   // { kr: [...], sector: [...], us: {...} }
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (cache[tab] !== undefined) return;
    let cancelled = false;
    const url = tab === 'kr' ? '/api/scan/results?signal=BUY&limit=8'
      : tab === 'sector' ? '/api/sectors'
      : '/api/scan/us';
    setLoading(true);
    fetch(url, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const val = tab === 'kr' ? (d.results || [])
          : tab === 'sector' ? (d.sectors || [])
          : (d.stocks || []);
        setCache(c => ({ ...c, [tab]: val }));
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setCache(c => ({ ...c, [tab]: [] })); setLoading(false); } });
    return () => { cancelled = true; };
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = cache[tab];

  return (
    <div className="px-4 mt-3">
      <div className="bg-surface-900 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded font-medium">추천</span>
            <span className="text-sm font-bold text-white">오늘 살 만한 것</span>
          </div>
          <div className="flex gap-1 bg-surface-950 rounded-lg p-0.5">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                  tab === t.id ? 'bg-brand-500 text-white font-medium' : 'text-slate-400'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {loading || data === undefined ? (
          <div className="py-6 flex justify-center">
            <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : data.length === 0 ? (
          <p className="py-5 text-center text-xs text-slate-500">
            {tab === 'us' ? '미국 스캔 대기 중 (07:00 생성)' : '추천 종목이 없습니다'}
          </p>
        ) : tab === 'kr' ? (
          <ul className="space-y-1.5">
            {data.map((r, i) => (
              <li key={r.code}>
                <button
                  onClick={() => navigate(`/stock?code=${r.code}`)}
                  className="w-full flex items-center justify-between gap-2 bg-surface-950 hover:bg-slate-800 rounded-lg px-3 py-2 transition-colors text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-600 w-3.5">{i + 1}</span>
                      <span className="text-sm text-white truncate">{r.name || r.code}</span>
                      {r.sector && <span className="text-[9px] bg-slate-800 text-slate-400 px-1.5 rounded-full flex-shrink-0">{r.sector}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 flex-shrink-0 text-[11px]">
                    <span className="text-slate-500">린치 <span className={scoreColor(r.lynch_score)}>{r.lynch_score}</span></span>
                    <span className="text-slate-500">F <span className={scoreColor((r.piotroski_score || 0) * 11)}>{r.piotroski_score ?? '-'}</span></span>
                    <span className={`${chgColor(r.change_rate)} w-12 text-right`}>{fmtChg(r.change_rate)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : tab === 'sector' ? (
          <ul className="space-y-1.5">
            {data.slice(0, 6).map((s, i) => (
              <li key={s.sector} className="flex items-center justify-between gap-2 bg-surface-950 rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-600 w-3.5">{i + 1}</span>
                    <span className="text-sm text-white">{s.sector}</span>
                    <span className="text-[9px] bg-green-500/15 text-green-400 px-1.5 rounded-full">매수 {s.buyCount}</span>
                  </div>
                  {s.leader && (
                    <p className="text-[10px] text-slate-500 mt-0.5 ml-5">
                      대장주 {s.leader.name} <span className={scoreColor(s.leader.score)}>{s.leader.score}점</span>
                    </p>
                  )}
                </div>
                <span className="text-[11px] text-slate-500 flex-shrink-0">평균 <span className={scoreColor(s.avgScore)}>{s.avgScore}</span></span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-1.5">
            {data.slice(0, 8).map((s, i) => (
              <li key={s.ticker} className="flex items-center justify-between gap-2 bg-surface-950 rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-600 w-3.5">{i + 1}</span>
                    <span className="text-sm text-white truncate">{s.name}</span>
                    <span className="text-[9px] text-slate-600 flex-shrink-0">{s.ticker}</span>
                    {s.signal === 'BUY' && <span className="text-[9px] bg-green-500/15 text-green-400 px-1.5 rounded-full flex-shrink-0">BUY</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2.5 flex-shrink-0 text-[11px]">
                  <span className="text-slate-500">리버모어 <span className={scoreColor(s.livermoreScore)}>{s.livermoreScore}</span></span>
                  {s.pos52w != null && <span className="text-slate-600">52주 {s.pos52w}%</span>}
                  <span className={`${chgColor(s.changeRate)} w-12 text-right`}>{fmtChg(s.changeRate)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="text-[9px] text-slate-700 text-right mt-2">
          {tab === 'us' ? '다우30·나스닥 핵심 · 기술점수' : tab === 'sector' ? '한국 매수신호 섹터 집계' : '린치·리버모어·DART F-Score 스캔'} · 참고용
        </p>
      </div>
    </div>
  );
}
