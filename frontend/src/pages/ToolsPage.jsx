import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CompoundCalc from '../components/tools/CompoundCalc';
import TaxCalc from '../components/tools/TaxCalc';
import DCAPlanner from '../components/tools/DCAPlanner';
import RebalanceCalc from '../components/tools/RebalanceCalc';
import BacktestTool from '../components/tools/BacktestTool';
import IndexAnalysis from '../components/tools/IndexAnalysis';
import BuyChecklist from '../components/decision/BuyChecklist';
import SellChecklist from '../components/decision/SellChecklist';
import PositionCalculator from '../components/decision/PositionCalculator';
import RiskRewardCalc from '../components/decision/RiskRewardCalc';
import AlertSettings from '../components/decision/AlertSettings';

const CATEGORIES = [
  {
    label: '매매 결정',
    sub: '사기 전 · 팔기 전 점검',
    tools: [
      { id: 'buy',       emoji: '✅', name: '매수 체크리스트', desc: '린치 10문 점검', component: true },
      { id: 'sell',      emoji: '🚪', name: '매도 체크리스트', desc: '팔아야 할 신호', component: true },
      { id: 'position',  emoji: '🎯', name: '포지션 계산기',   desc: '얼마나 살까', component: true },
      { id: 'riskreward', emoji: '⚖️', name: '손익비 계산기',  desc: '리스크 대비 보상', component: true },
      { id: 'alerts',    emoji: '🔔', name: '알림 설정',       desc: '가격·RSI 감시', component: true },
    ],
  },
  {
    label: '트레이딩 도구',
    sub: '전략 검증 · 리포트',
    tools: [
      { id: 'report',   emoji: '📑', name: '종목 리포트',  desc: '종목 선택 후 발행', link: '/discover' },
      { id: 'backtest', emoji: '🧪', name: '백테스팅',     desc: '3전략 비교', component: true },
      { id: 'opening',  emoji: '🎬', name: '시초가 시뮬',  desc: '5가지 시나리오', component: true },
    ],
  },
  {
    label: '포트폴리오 관리',
    sub: '보유 종목 · 세금 · 리밸런싱',
    tools: [
      { id: 'rebalance', emoji: '🔄', name: '리밸런싱',     desc: '비중 조정', component: true },
      { id: 'tax',       emoji: '🧾', name: '세금 계산기',  desc: '양도세·거래세', component: true },
      { id: 'dca',       emoji: '📅', name: 'DCA 계획',     desc: '분할매수 스케줄', component: true },
    ],
  },
  {
    label: '장기투자 플래너',
    sub: 'ETF · 복리 · 계좌 전략',
    tools: [
      { id: 'index',    emoji: '🌐', name: '지수 분석',       desc: '코스피·나스닥 이동평균', component: true },
      { id: 'compound', emoji: '📈', name: '복리 시뮬레이터', desc: '적립식 장기 계산', component: true },
    ],
  },
];

const COMPONENTS = {
  buy: BuyChecklist,
  sell: SellChecklist,
  position: PositionCalculator,
  riskreward: RiskRewardCalc,
  alerts: AlertSettings,
  backtest: BacktestTool,
  rebalance: RebalanceCalc,
  tax: TaxCalc,
  dca: DCAPlanner,
  index: IndexAnalysis,
  compound: CompoundCalc,
};
const STUB_IDS = ['opening'];
const ALL_TOOLS = CATEGORIES.flatMap(c => c.tools);

export default function ToolsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [active, setActive] = useState(null);
  const navigate = useNavigate();

  // /tools?tool=buy 형태 딥링크 (종목 페이지 "매수 검토" 버튼 등)
  useEffect(() => {
    const t = searchParams.get('tool');
    if (t && ALL_TOOLS.some(x => x.id === t && !x.link)) {
      setActive(t);
      setSearchParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTool = (tool) => {
    if (tool.link) { navigate(tool.link); return; }
    setActive(tool.id);
  };

  if (active) {
    const name = ALL_TOOLS.find(t => t.id === active)?.name || '';
    const Comp = COMPONENTS[active];
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 pt-5 pb-3 bg-surface-950">
          <button onClick={() => setActive(null)} className="text-slate-400 hover:text-white p-1 -ml-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-base font-semibold text-white">{name}</span>
        </div>
        <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
          {STUB_IDS.includes(active) ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-sm">
              <span className="text-3xl mb-3">🚧</span>준비 중입니다
            </div>
          ) : Comp ? (
            <div className="pt-4"><Comp /></div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-3 bg-surface-950">
        <h1 className="text-xl font-bold text-white">도구</h1>
        <p className="text-xs text-slate-500 mt-0.5">매매 결정 · 계산기 · 전략 검증</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
        {CATEGORIES.map(cat => (
          <div key={cat.label} className="px-4 mt-5">
            <div className="mb-3">
              <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider">{cat.label}</span>
              <span className="text-[10px] text-slate-500 ml-2">{cat.sub}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {cat.tools.map(tool => (
                <button
                  key={tool.id}
                  onClick={() => handleTool(tool)}
                  className="bg-surface-900 rounded-xl p-4 text-left hover:bg-slate-800 active:scale-95 transition-all"
                >
                  <div className="text-2xl mb-2">{tool.emoji}</div>
                  <div className="text-sm font-semibold text-white">{tool.name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{tool.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="h-6" />
      </div>
    </div>
  );
}
