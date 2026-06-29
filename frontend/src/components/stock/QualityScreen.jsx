import { useState } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const GRADE_CONFIG = {
  A: { label: 'A등급 (우수)', cls: 'text-profit border-profit/40 bg-profit/10' },
  B: { label: 'B등급 (양호)', cls: 'text-blue-400 border-blue-500/40 bg-blue-500/10' },
  C: { label: 'C등급 (주의)', cls: 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10' },
  F: { label: 'F등급 (부적합)', cls: 'text-loss border-loss/40 bg-loss/10' },
  'N/A': { label: '데이터 부족', cls: 'text-slate-400 border-slate-600 bg-slate-800' },
};

function CheckRow({ item }) {
  const icon = item.pass === null
    ? <span className="text-slate-600 text-xs w-4">—</span>
    : item.pass
    ? <span className="text-profit text-sm w-4">✓</span>
    : <span className="text-loss text-sm w-4">✗</span>;

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      {icon}
      <span className={`text-xs flex-1 ${item.pass === null ? 'text-slate-600' : item.pass ? 'text-slate-300' : 'text-slate-400'}`}>
        {item.label}
      </span>
      <span className={`text-[10px] font-mono ${item.pass === null ? 'text-slate-600' : item.pass ? 'text-profit/80' : 'text-loss/80'}`}>
        {item.value}
      </span>
    </div>
  );
}

export default function QualityScreen({ code, preloadData }) {
  const [data, setData] = useState(preloadData || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/quality-screen?code=${code}`, { headers: authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const gradeConf = data ? (GRADE_CONFIG[data.grade] || GRADE_CONFIG['N/A']) : null;

  return (
    <div className="bg-surface-900 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded font-medium">QS</span>
          <span className="text-xs font-semibold text-slate-300">품질 스크린 (7개 필터)</span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1 text-[11px] bg-surface-800 text-slate-400 rounded-lg disabled:opacity-40 hover:text-slate-200 transition-colors"
        >
          {loading ? '계산 중...' : data ? '새로고침' : '스크린 실행'}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <span className="text-xs text-slate-500">7개 필터 계산 중...</span>
        </div>
      )}

      {error && <div className="px-4 py-3"><p className="text-xs text-red-400">{error}</p></div>}

      {!loading && data && gradeConf && (
        <div className="px-4 pt-3 pb-4">
          <div className={`flex items-center justify-between px-3 py-2.5 rounded-xl border mb-3 ${gradeConf.cls}`}>
            <span className="text-sm font-bold">{gradeConf.label}</span>
            <span className="text-[10px] font-medium opacity-80">
              {data.passCount}/{data.total} 통과
            </span>
          </div>
          <div className="divide-y divide-slate-800/60">
            {(data.checks || []).map(item => (
              <CheckRow key={item.key} item={item} />
            ))}
          </div>
          <p className="text-[10px] text-slate-700 text-center mt-2">재무 데이터 기반 기계적 스크리닝 — AI 판단 아님</p>
        </div>
      )}

      {!loading && !data && !error && (
        <div className="px-4 py-4 text-center">
          <p className="text-xs text-slate-600">7개 재무 필터로 투자 가치를 사전 스크리닝합니다</p>
          <p className="text-[10px] text-slate-700 mt-0.5">영업이익률·성장성·밸류에이션·부채·ROE·F-Score·린치점수</p>
        </div>
      )}
    </div>
  );
}
