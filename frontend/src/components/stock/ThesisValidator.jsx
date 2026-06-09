import { useState } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const VERDICT_STYLES = {
  STRONG: { label: '강력한 Thesis', color: 'text-profit', bg: 'bg-profit/10', border: 'border-profit/30' },
  VALID:  { label: '타당한 Thesis', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  WEAK:   { label: '보완 필요',     color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20' },
};

export default function ThesisValidator({ code }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const validate = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const r = await fetch(`/api/gemini/validate-thesis?code=${code}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setResult(d);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const style = result ? VERDICT_STYLES[result.verdict] || VERDICT_STYLES.VALID : null;

  return (
    <div className="px-4 mt-4 pb-2">
      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] bg-brand-500/20 text-brand-400 px-1.5 py-0.5 rounded font-medium">AI</span>
            <span className="text-xs font-semibold text-slate-300">Thesis 검증</span>
          </div>
          <button
            onClick={validate}
            disabled={loading}
            className="px-3 py-1 text-[11px] bg-brand-500/20 text-brand-400 rounded-lg disabled:opacity-40 transition-opacity"
          >
            {loading ? '분석 중...' : result ? '재검증' : 'Gemini 검증'}
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 px-4 py-4">
            <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <span className="text-xs text-slate-500">Thesis 논리 검증 중...</span>
          </div>
        )}

        {error && (
          <div className="px-4 py-3">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {!loading && result && style && (
          <div className="p-4 space-y-3">
            <div className={`${style.bg} border ${style.border} rounded-xl px-3 py-2.5 text-center`}>
              <p className={`text-sm font-bold ${style.color}`}>{style.label}</p>
            </div>

            {result.strengths?.length > 0 && (
              <div>
                <p className="text-[10px] text-slate-500 mb-1.5">강점</p>
                <ul className="space-y-1">
                  {result.strengths.map((s, i) => (
                    <li key={i} className="text-[11px] text-profit/90 flex gap-1.5">
                      <span className="flex-shrink-0">+</span><span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.gaps?.length > 0 && (
              <div>
                <p className="text-[10px] text-slate-500 mb-1.5">빠진 근거</p>
                <ul className="space-y-1">
                  {result.gaps.map((g, i) => (
                    <li key={i} className="text-[11px] text-yellow-400/80 flex gap-1.5">
                      <span className="flex-shrink-0">?</span><span>{g}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.risks?.length > 0 && (
              <div>
                <p className="text-[10px] text-slate-500 mb-1.5">리스크</p>
                <ul className="space-y-1">
                  {result.risks.map((r, i) => (
                    <li key={i} className="text-[11px] text-red-400/80 flex gap-1.5">
                      <span className="flex-shrink-0">!</span><span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.suggestions?.length > 0 && (
              <div>
                <p className="text-[10px] text-slate-500 mb-1.5">개선 제안</p>
                <ul className="space-y-1">
                  {result.suggestions.map((s, i) => (
                    <li key={i} className="text-[11px] text-brand-400/80 flex gap-1.5">
                      <span className="flex-shrink-0">→</span><span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[9px] text-slate-700 text-right">Gemini 2.0 Flash · 저장된 Thesis 기준</p>
          </div>
        )}

        {!loading && !result && !error && (
          <div className="px-4 py-4 text-center">
            <p className="text-xs text-slate-600">저장된 Thesis를 Gemini AI로 검증합니다</p>
            <p className="text-[10px] text-slate-700 mt-0.5">논리적 타당성 · 리스크 · 보완점 분석</p>
          </div>
        )}
      </div>
    </div>
  );
}
