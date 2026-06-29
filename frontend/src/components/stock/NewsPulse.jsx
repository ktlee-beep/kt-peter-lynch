import { useState } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const CAUSE_LABELS = {
  '실적':     { label: '실적', cls: 'bg-profit/20 text-profit border-profit/30' },
  '수급':     { label: '수급', cls: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  '섹터테마': { label: '섹터/테마', cls: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  '매크로':   { label: '매크로', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  '기술적':   { label: '기술적', cls: 'bg-slate-600/50 text-slate-300 border-slate-500/30' },
  '미확인':   { label: '미확인', cls: 'bg-slate-700/50 text-slate-400 border-slate-600/30' },
};

export default function NewsPulse({ code, changeRate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const absCR = Math.abs(changeRate ?? 0);
  const isSignificant = absCR >= 3;
  const isBig = absCR >= 5;

  const analyze = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/gemini/news-pulse?code=${code}`, { headers: authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  if (!isSignificant) return null;

  const causeStyle = data ? (CAUSE_LABELS[data.causeType] || CAUSE_LABELS['미확인']) : null;

  return (
    <div className="bg-surface-900 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isBig && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />}
          <span className="text-xs font-semibold text-slate-300">급등락 원인 분석</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            (changeRate ?? 0) > 0 ? 'text-profit bg-profit/10' : 'text-loss bg-loss/10'
          }`}>
            {(changeRate ?? 0) > 0 ? '+' : ''}{(changeRate ?? 0).toFixed(2)}%
          </span>
        </div>
        <button
          onClick={analyze}
          disabled={loading}
          className="px-3 py-1 text-[11px] bg-brand-500/20 text-brand-400 rounded-lg disabled:opacity-40"
        >
          {loading ? '분석 중...' : data ? '재분석' : '원인 분석'}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <span className="text-xs text-slate-500">주가 변동 원인 파악 중...</span>
        </div>
      )}

      {error && (
        <div className="px-4 py-3">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {!loading && data && (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            {causeStyle && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${causeStyle.cls}`}>
                {causeStyle.label}
              </span>
            )}
            <span className={`text-[10px] ${data.confidence === '높음' ? 'text-profit' : data.confidence === '낮음' ? 'text-slate-500' : 'text-yellow-400'}`}>
              신뢰도 {data.confidence}
            </span>
          </div>

          <p className="text-sm text-slate-200 leading-relaxed">{data.cause}</p>

          <div className={`px-3 py-2 rounded-lg border ${data.isSustainable ? 'bg-profit/5 border-profit/20' : 'bg-loss/5 border-loss/20'}`}>
            <span className={`text-[10px] font-semibold ${data.isSustainable ? 'text-profit' : 'text-loss'}`}>
              {data.isSustainable ? '지속 가능성 있음' : '단기 요인일 가능성'}
            </span>
            {data.sustainReason && (
              <p className="text-[11px] text-slate-400 mt-0.5">{data.sustainReason}</p>
            )}
          </div>

          {data.recommendation && (
            <div className="bg-surface-800 rounded-lg px-3 py-2">
              <p className="text-[10px] text-slate-500 mb-0.5">대응 전략</p>
              <p className="text-xs text-slate-300">{data.recommendation}</p>
            </div>
          )}

          {data.fromCache && <p className="text-[9px] text-slate-700 text-right">오늘자 캐시</p>}
        </div>
      )}

      {!loading && !data && !error && (
        <div className="px-4 py-4 text-center">
          <p className="text-xs text-slate-600">
            {isBig ? '5% 이상 급등락 감지됨' : '3% 이상 변동 감지됨'}
          </p>
          <p className="text-[10px] text-slate-700 mt-0.5">AI가 원인을 분석하고 대응 전략을 제시합니다</p>
        </div>
      )}
    </div>
  );
}
