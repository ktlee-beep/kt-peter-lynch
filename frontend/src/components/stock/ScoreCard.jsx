function GaugeBar({ value, max = 100, colorClass }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 bg-surface-800 rounded-full overflow-hidden mt-1.5">
      <div className={`h-full rounded-full transition-all ${colorClass}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function gradeColor(grade) {
  if (!grade) return 'text-slate-400';
  if (grade.startsWith('A')) return 'text-profit';
  if (grade.startsWith('B')) return 'text-blue-400';
  if (grade.startsWith('C')) return 'text-yellow-400';
  return 'text-loss';
}

function ScoreBlock({ title, score, max, grade, reasons, colorBar }) {
  return (
    <div className="bg-surface-900 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400 font-medium">{title}</span>
        <span className={`text-sm font-bold ${gradeColor(grade)}`}>
          {score}/{max}
          {grade && <span className="ml-1 text-[11px]">({grade})</span>}
        </span>
      </div>
      <GaugeBar value={score} max={max} colorClass={colorBar} />
      {reasons?.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {reasons.slice(0, 3).map((r, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className="text-[11px] text-brand-400 mt-px flex-shrink-0">+</span>
              <span className="text-[11px] text-slate-400">{r}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ScoreCard({ data }) {
  if (!data) {
    return (
      <section className="px-4 mt-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">종합 점수</h3>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 bg-surface-900 rounded-xl animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  const pScore = data.pScore ?? 0;
  const lScore = data.lScore ?? 0;
  const fScore = data.fScore;

  return (
    <section className="px-4 mt-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-2">종합 점수</h3>
      <div className="space-y-2">
        <ScoreBlock
          title="피터 린치 점수"
          score={pScore}
          max={100}
          grade={data.pGrade}
          reasons={data.pReasons}
          colorBar="bg-brand-400"
        />
        <ScoreBlock
          title="리버모어 기술 점수"
          score={lScore}
          max={100}
          grade={data.lGrade}
          reasons={data.lReasons}
          colorBar="bg-blue-400"
        />
        {fScore && (
          <ScoreBlock
            title="피오트로스키 F-Score"
            score={fScore.score}
            max={fScore.total || 9}
            grade={fScore.grade}
            reasons={fScore.details?.filter(d => d.pass).map(d => d.text)}
            colorBar="bg-purple-400"
          />
        )}
      </div>
    </section>
  );
}
