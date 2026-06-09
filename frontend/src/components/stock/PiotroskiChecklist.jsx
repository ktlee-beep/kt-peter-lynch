const HINTS = {
  '영업이익 흑자': '영업이익 > 0 — 본업에서 돈을 버는가?',
  '매출 성장': '전년 대비 매출 증가 — 사업이 성장하는가?',
  '영업이익 증가': '전년 대비 영업이익 증가 — 효율이 개선되는가?',
  '영업이익률 8% 이상': '영업이익 / 매출 ≥ 8% — 이익의 질이 좋은가?',
  '매출성장률 3% 이상': '매출 YoY ≥ 3% — 최소 성장 기준 충족?',
  'ROE 8% 이상': '자기자본수익률 ≥ 8% — 주주에게 이익을 돌리는가?',
  'ROA 양수': '자산이익률 > 0 — 자산을 효율적으로 운용하는가?',
  '유동비율 > 1': '유동자산 / 유동부채 > 1 — 단기 부채 상환 능력 있는가?',
  '부채비율 양호': '부채 / 자본 < 100% — 재무 안전성이 충분한가?',
};

function gradeColor(grade) {
  if (!grade) return 'text-slate-500';
  if (grade.startsWith('A')) return 'text-profit';
  if (grade.startsWith('B')) return 'text-blue-400';
  if (grade.startsWith('C')) return 'text-yellow-400';
  return 'text-loss';
}

export default function PiotroskiChecklist({ fScore }) {
  if (!fScore) return null;
  const { score, available, total, grade, details, investable } = fScore;

  return (
    <section className="px-4 mt-4 mb-2">
      <div className="bg-surface-900 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-300">피오트로스키 F-Score</p>
            <p className="text-[10px] text-slate-600 mt-0.5">재무건전성 9항목 체크</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-white">{score}<span className="text-sm text-slate-500">/{available}</span></p>
            <p className={`text-xs font-semibold ${gradeColor(grade)}`}>{grade}</p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-4 pt-3 pb-1">
          <div className="h-2 bg-surface-800 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${available > 0 ? (score / available) * 100 : 0}%`,
                backgroundColor: score / available >= 0.7 ? '#22c55e' : score / available >= 0.5 ? '#eab308' : '#ef4444',
              }}
            />
          </div>
        </div>

        {/* Checklist */}
        <div className="divide-y divide-slate-800/50">
          {(details || []).map((d, i) => (
            <div key={i} className="px-4 py-2.5 flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center ${
                d.noData ? 'bg-slate-800' : d.pass ? 'bg-profit/20' : 'bg-loss/20'
              }`}>
                {d.noData ? (
                  <span className="text-[9px] text-slate-600">?</span>
                ) : d.pass ? (
                  <svg className="w-2.5 h-2.5 text-profit" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                  </svg>
                ) : (
                  <svg className="w-2.5 h-2.5 text-loss" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
                  </svg>
                )}
              </div>
              <div className="min-w-0">
                <p className={`text-xs ${d.noData ? 'text-slate-600' : d.pass ? 'text-slate-200' : 'text-slate-400'}`}>
                  {d.text}
                </p>
                {HINTS[d.text] && (
                  <p className="text-[10px] text-slate-700 mt-0.5">{HINTS[d.text]}</p>
                )}
                {d.noData && <p className="text-[10px] text-slate-700">데이터 없음</p>}
              </div>
            </div>
          ))}
        </div>

        {investable !== undefined && (
          <div className={`px-4 py-3 border-t border-slate-800 text-center text-xs font-semibold ${
            investable ? 'text-profit' : 'text-slate-500'
          }`}>
            {investable ? '재무 기준 투자 적합' : '데이터 부족 또는 기준 미달'}
          </div>
        )}
      </div>
    </section>
  );
}
