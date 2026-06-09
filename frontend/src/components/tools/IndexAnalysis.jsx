import { useState } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const INDICES = [
  { id: 'KOSPI',   label: '코스피',  code: '^KS11' },
  { id: 'KOSDAQ',  label: '코스닥',  code: '^KQ11' },
  { id: 'SP500',   label: 'S&P 500', code: '^GSPC' },
  { id: 'NASDAQ',  label: '나스닥',  code: '^IXIC' },
];

const MA_RULES = [
  { key: 'ma20', label: '20일선', color: 'text-yellow-400' },
  { key: 'ma60', label: '60일선', color: 'text-blue-400'   },
  { key: 'ma120',label: '120일선',color: 'text-green-400'  },
  { key: 'ma240',label: '240일선',color: 'text-purple-400' },
];

const PHASE_MAP = {
  all_above:   { label: '강세장',   color: 'text-green-400',  bg: 'bg-green-400/10',  desc: '모든 이동평균선 위 — 추세 매수 유효' },
  mixed:       { label: '중립',     color: 'text-yellow-400', bg: 'bg-yellow-400/10', desc: '혼조 — 선택적 매수, 방어 비중 유지'   },
  all_below:   { label: '약세장',   color: 'text-red-400',    bg: 'bg-red-400/10',    desc: '모든 이동평균선 아래 — 신규 매수 자제'},
  recovering:  { label: '회복 중',  color: 'text-blue-400',   bg: 'bg-blue-400/10',   desc: '단기선 회복, 중장기 아직 저항'        },
};

export default function IndexAnalysis() {
  const [idx, setIdx]   = useState('KOSPI');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const load = async () => {
    const code = INDICES.find(i => i.id === idx)?.code;
    if (!code) return;
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/index/ma?code=${encodeURIComponent(code)}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json());
    } catch (e) {
      setError('데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const label = INDICES.find(i => i.id === idx)?.label;
  const phase = data ? (PHASE_MAP[data.phase] || PHASE_MAP.mixed) : null;

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {INDICES.map(i => (
          <button key={i.id} onClick={() => { setIdx(i.id); setData(null); }}
            className={`py-2.5 rounded-xl text-sm font-medium transition-colors ${idx === i.id ? 'bg-brand-400 text-white' : 'bg-surface-900 text-slate-400'}`}>
            {i.label}
          </button>
        ))}
      </div>

      <button onClick={load} disabled={loading}
        className="w-full py-3 rounded-xl bg-brand-400 text-white text-sm font-semibold disabled:opacity-50">
        {loading ? '조회 중...' : `${label} 이동평균 조회`}
      </button>

      {error && (
        <div className="bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && phase && (
        <>
          <div className={`${phase.bg} border border-slate-800 rounded-xl p-4`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-lg font-bold ${phase.color}`}>{phase.label}</span>
              <span className="text-xs text-slate-500">{label}</span>
            </div>
            <p className="text-xs text-slate-400">{phase.desc}</p>
          </div>

          <div className="bg-surface-900 rounded-xl p-4 space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="text-sm text-slate-400">현재가</span>
              <span className="text-lg font-bold text-white">
                {(data.current || 0).toLocaleString()}
              </span>
            </div>
            {MA_RULES.map(ma => {
              const val = data[ma.key];
              if (!val) return null;
              const above = (data.current || 0) > val;
              return (
                <div key={ma.key} className="flex items-center justify-between text-sm">
                  <span className={`${ma.color} font-medium`}>{ma.label}</span>
                  <span className="text-white">{val.toLocaleString()}</span>
                  <span className={above ? 'text-green-400 text-xs' : 'text-red-400 text-xs'}>
                    {above ? '▲ 위' : '▼ 아래'}
                  </span>
                </div>
              );
            })}
          </div>

          {data.signal && (
            <div className="bg-surface-900 rounded-xl p-4">
              <p className="text-[11px] text-slate-500 mb-2">피터 린치 매수 신호</p>
              <p className={`text-sm font-medium ${data.signal === 'BUY' ? 'text-green-400' : data.signal === 'CAUTION' ? 'text-yellow-400' : 'text-red-400'}`}>
                {data.signal === 'BUY' ? '매수 적합 — 지수 건강한 상태' :
                 data.signal === 'CAUTION' ? '주의 — 선별 매수' :
                 '매수 자제 — 하락 추세'}
              </p>
            </div>
          )}
        </>
      )}

      {!data && !loading && (
        <div className="bg-surface-900 rounded-xl p-6 text-center">
          <p className="text-slate-500 text-sm">조회 버튼을 눌러 이동평균을 확인하세요</p>
          <p className="text-slate-600 text-xs mt-1">20 / 60 / 120 / 240일 이동평균 기반 시장 국면 분석</p>
        </div>
      )}
    </div>
  );
}
