import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const PHASE = {
  '매우긍정': { label: '강세장',   emoji: '', color: 'bg-green-500/15 border-green-500/30', text: 'text-green-400', desc: '공격적 포지션 유효. 추세 추종 전략 적합.' },
  '긍정':     { label: '상승 국면', emoji: '', color: 'bg-green-500/10 border-green-500/20', text: 'text-green-400', desc: '우량주 비중 유지. 신규 매수 기회 탐색.' },
  '중립':     { label: '중립 국면', emoji: '', color: 'bg-slate-500/15 border-slate-500/30', text: 'text-slate-300', desc: '선별적 접근. 현금 20~30% 유지 권고.' },
  '부정':     { label: '조정 국면', emoji: '', color: 'bg-yellow-500/10 border-yellow-500/20', text: 'text-yellow-400', desc: '비중 축소. 고베타 종목 손절 기준 엄격히.' },
  '매우부정': { label: '하락장',   emoji: '', color: 'bg-red-500/15 border-red-500/30',   text: 'text-red-400',   desc: '현금 비중 확대. 방어주·역발상 기회 탐색.' },
};

export default function MarketPhaseBanner() {
  const [macro, setMacro] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/macro', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!cancelled) setMacro(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!macro) {
    return <div className="mx-4 h-14 bg-surface-900 rounded-xl animate-pulse" />;
  }

  const phase = PHASE[macro.label] ?? PHASE['중립'];

  return (
    <div
      className={`mx-4 border rounded-xl px-4 py-3 cursor-pointer ${phase.color}`}
      onClick={() => setOpen(o => !o)}
    >
      <div className="flex items-center justify-between">
        <div>
          <span className={`text-xs font-semibold uppercase tracking-wider ${phase.text}`}>
            시장 국면
          </span>
          <div className={`text-base font-bold mt-0.5 ${phase.text}`}>
            {phase.label}
            <span className="ml-2 text-sm font-normal text-slate-400">점수 {macro.score > 0 ? '+' : ''}{macro.score}</span>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
        </svg>
      </div>

      {open && (
        <div className="mt-3 space-y-1.5 border-t border-slate-700/50 pt-3">
          <p className="text-xs text-slate-300">{phase.desc}</p>
          {(macro.notes || []).map((n, i) => (
            <div key={i} className="text-xs text-slate-400 flex gap-2">
              <span className="text-slate-600">•</span>
              <span>{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
