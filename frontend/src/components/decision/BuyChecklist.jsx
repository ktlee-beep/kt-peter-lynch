import { useState } from 'react';

const ITEMS = [
  { id: 'story',    label: '사업 이야기가 명확하다',          hint: '"이 회사는 X를 팔아서 Y가 된다" 한 문장으로 설명 가능한가?' },
  { id: 'peg',      label: 'PEG < 1 (이상적) 또는 < 1.5',    hint: 'PEG = PER ÷ 연간 EPS 성장률 (%). 1 미만이면 성장에 비해 저평가.' },
  { id: 'roe',      label: 'ROE > 15% (3년 평균)',            hint: '자기자본 대비 이익 창출 능력. 15% 이상이면 우량 기업.' },
  { id: 'debt',     label: '부채비율 < 100% (제조업 기준)',   hint: '이자보상배율도 확인. 업종 특성 고려 필요.' },
  { id: 'growth',   label: '성장 스토리가 뒷받침된다',        hint: '매출/이익 성장 트렌드, 시장 점유율 확대 가능성.' },
  { id: 'moat',     label: '경쟁우위(해자)가 있다',           hint: '브랜드, 특허, 네트워크 효과, 전환 비용 중 하나 이상.' },
  { id: 'mgmt',     label: '경영진을 신뢰할 수 있다',         hint: '오너십, IR 투명성, 자사주 매입/배당 이력.' },
  { id: 'margin',   label: '안전마진 > 30%',                  hint: '내가 계산한 적정가 대비 현재가가 30% 이상 낮은가?' },
  { id: 'sell',     label: '매도 기준이 정해져 있다',         hint: '"언제 팔 것인가?"를 지금 결정했는가? (목표가, 스토리 변화)' },
  { id: 'split',    label: '분할 매수 계획이 있다',           hint: '한 번에 몰빵하지 않는다. 3~5회 분할이 기본.' },
];

export default function BuyChecklist() {
  const [checked, setChecked] = useState({});

  const toggle = (id) => setChecked(prev => ({ ...prev, [id]: !prev[id] }));
  const reset = () => setChecked({});

  const total = ITEMS.length;
  const done = ITEMS.filter(i => checked[i.id]).length;
  const pct = Math.round((done / total) * 100);
  const ready = done >= 7;

  return (
    <section className="px-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">매수 체크리스트</h3>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-bold ${ready ? 'text-profit' : done >= 5 ? 'text-yellow-400' : 'text-slate-400'}`}>
            {done}/{total}
          </span>
          <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">초기화</button>
        </div>
      </div>

      <div className="h-1.5 bg-surface-800 rounded-full mb-4 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${ready ? 'bg-profit' : done >= 5 ? 'bg-yellow-400' : 'bg-brand-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="space-y-2">
        {ITEMS.map(item => {
          const isChecked = !!checked[item.id];
          return (
            <button
              key={item.id}
              onClick={() => toggle(item.id)}
              className={`w-full flex items-start gap-3 p-3 rounded-xl text-left transition-colors ${
                isChecked ? 'bg-profit/10 border border-profit/20' : 'bg-surface-900 border border-transparent'
              }`}
            >
              <div className={`w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5 border-2 transition-colors ${
                isChecked ? 'bg-profit border-profit' : 'border-slate-600'
              }`}>
                {isChecked && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium leading-snug ${isChecked ? 'text-profit' : 'text-slate-200'}`}>
                  {item.label}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{item.hint}</p>
              </div>
            </button>
          );
        })}
      </div>

      {ready ? (
        <div className="mt-4 px-4 py-3 bg-profit/10 border border-profit/20 rounded-xl text-center">
          <p className="text-sm font-semibold text-profit">매수 조건 충족</p>
          <p className="text-xs text-slate-400 mt-0.5">7개 이상 확인됐습니다. 분할 매수를 시작하세요.</p>
        </div>
      ) : (
        <div className="mt-4 px-4 py-3 bg-surface-900 rounded-xl text-center">
          <p className="text-xs text-slate-500">{7 - done}개를 더 충족해야 매수 조건이 성립합니다</p>
        </div>
      )}
    </section>
  );
}
