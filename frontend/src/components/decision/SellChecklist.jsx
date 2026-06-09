import { useState } from 'react';

const SELL_ITEMS = [
  { id: 'story_broken',   label: '투자 thesis가 훼손됐다',         hint: '처음 샀을 때의 이야기가 더 이상 유효하지 않다.', level: 'critical' },
  { id: 'growth_end',     label: '성장 스토리가 끝났다',            hint: '경쟁 심화, 시장 포화, 성장 드라이버 소멸 신호.', level: 'critical' },
  { id: 'target_reached', label: '목표주가에 도달했다',             hint: '설정한 적정가(PEG/DCF)에 근접 또는 초과.', level: 'major' },
  { id: 'better_opp',     label: '더 좋은 기회가 생겼다',           hint: 'PEG/안전마진 기준 더 저평가된 종목 발견.', level: 'major' },
  { id: 'overvalued',     label: 'PEG > 2 (과도한 고평가)',         hint: '성장률 대비 주가가 2배 이상 비싸다.', level: 'major' },
  { id: 'mgmt_issue',     label: '경영진 신뢰 문제 발생',           hint: '회계 부정, 배임, 자사주 대량 매도, IR 불투명.', level: 'critical' },
  { id: 'industry',       label: '산업 구조적 쇠퇴',               hint: '업종 자체의 장기 하락 트렌드 (예: 레거시 미디어).', level: 'major' },
  { id: 'debt_spike',     label: '부채비율 급등 or 이자보상배율 <1', hint: '자금 조달 위기 또는 현금 소진 속도 위험.', level: 'critical' },
  { id: 'holding_time',   label: '3~5년이 지났는데 이야기가 실현 안 됨', hint: '기회비용 점검. 다른 곳에 자금이 더 유효할 수 있다.', level: 'minor' },
  { id: 'position_size',  label: '한 종목이 포트폴리오의 25% 초과', hint: '집중 투자는 허용하되 리밸런싱 기준 점검.', level: 'minor' },
];

const LEVEL_COLORS = {
  critical: 'text-loss',
  major: 'text-yellow-400',
  minor: 'text-slate-400',
};
const LEVEL_LABELS = {
  critical: '결정적',
  major: '중요',
  minor: '검토',
};

export default function SellChecklist() {
  const [checked, setChecked] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sell-checklist') || '{}'); }
    catch { return {}; }
  });

  const toggle = (id) => setChecked(prev => {
    const next = { ...prev, [id]: !prev[id] };
    localStorage.setItem('sell-checklist', JSON.stringify(next));
    return next;
  });
  const reset = () => {
    setChecked({});
    localStorage.removeItem('sell-checklist');
  };

  const criticals = SELL_ITEMS.filter(i => i.level === 'critical' && checked[i.id]).length;
  const majors    = SELL_ITEMS.filter(i => i.level === 'major' && checked[i.id]).length;
  const done      = SELL_ITEMS.filter(i => checked[i.id]).length;

  const shouldSell = criticals >= 1 || majors >= 2;
  const consider   = !shouldSell && (majors >= 1 || done >= 3);

  return (
    <section className="px-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">매도 기준 체크리스트</h3>
        <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">초기화</button>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4 text-center">
        {[
          { key: 'critical', label: '결정적', count: SELL_ITEMS.filter(i => i.level === 'critical').length },
          { key: 'major',    label: '중요',   count: SELL_ITEMS.filter(i => i.level === 'major').length },
          { key: 'minor',    label: '검토',   count: SELL_ITEMS.filter(i => i.level === 'minor').length },
        ].map(({ key, label, count }) => {
          const chk = SELL_ITEMS.filter(i => i.level === key && checked[i.id]).length;
          return (
            <div key={key} className="bg-surface-900 rounded-xl py-2.5">
              <p className={`text-base font-bold ${LEVEL_COLORS[key]}`}>{chk}/{count}</p>
              <p className="text-[9px] text-slate-600 mt-0.5">{label}</p>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 mb-4">
        {SELL_ITEMS.map(item => {
          const isChecked = !!checked[item.id];
          const levelColor = LEVEL_COLORS[item.level];
          return (
            <button
              key={item.id}
              onClick={() => toggle(item.id)}
              className={`w-full flex items-start gap-3 p-3 rounded-xl text-left transition-colors ${
                isChecked ? 'bg-loss/10 border border-loss/20' : 'bg-surface-900 border border-transparent'
              }`}
            >
              <div className={`w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5 border-2 transition-colors ${
                isChecked ? 'bg-loss border-loss' : 'border-slate-600'
              }`}>
                {isChecked && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className={`text-sm font-medium leading-snug ${isChecked ? 'text-loss' : 'text-slate-200'}`}>
                    {item.label}
                  </p>
                  <span className={`text-[9px] ${levelColor} flex-shrink-0`}>{LEVEL_LABELS[item.level]}</span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{item.hint}</p>
              </div>
            </button>
          );
        })}
      </div>

      {shouldSell ? (
        <div className="px-4 py-3 bg-loss/10 border border-loss/20 rounded-xl text-center">
          <p className="text-sm font-semibold text-loss">매도 신호 감지</p>
          <p className="text-xs text-slate-400 mt-0.5">결정적 신호 또는 중요 신호 2개 이상 확인됐습니다.</p>
        </div>
      ) : consider ? (
        <div className="px-4 py-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-center">
          <p className="text-sm font-semibold text-yellow-400">매도 검토 권고</p>
          <p className="text-xs text-slate-400 mt-0.5">Thesis를 재검토하고 보유 근거를 점검하세요.</p>
        </div>
      ) : (
        <div className="px-4 py-3 bg-surface-900 rounded-xl text-center">
          <p className="text-xs text-slate-500">매도 신호 없음 — 보유 지속</p>
        </div>
      )}
    </section>
  );
}
