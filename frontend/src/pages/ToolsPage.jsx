import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CompoundCalc from '../components/tools/CompoundCalc';
import TaxCalc from '../components/tools/TaxCalc';
import DCAPlanner from '../components/tools/DCAPlanner';
import RebalanceCalc from '../components/tools/RebalanceCalc';
import BacktestTool from '../components/tools/BacktestTool';
import IndexAnalysis from '../components/tools/IndexAnalysis';

const CATEGORIES = [
  {
    label: '트레이딩 도구',
    sub: '매매 신호 · 차트 · 전략 검증',
    tools: [
      { id: 'chart',    emoji: '📊', name: '차트 분석',    desc: '리버모어·린치 시그널', link: '/stock' },
      { id: 'scanner',  emoji: '🔭', name: '종목 스캐너',  desc: '자동 추천', link: '/discover' },
      { id: 'backtest', emoji: '🧪', name: '백테스팅',     desc: '3전략 비교', component: true },
      { id: 'opening',  emoji: '🎬', name: '시초가 시뮬',  desc: '5가지 시나리오', component: true },
    ],
  },
  {
    label: '포트폴리오 관리',
    sub: '보유 종목 · 세금 · 리밸런싱',
    tools: [
      { id: 'rebalance', emoji: '⚖️', name: '리밸런싱',     desc: '비중 조정', component: true },
      { id: 'tax',       emoji: '🧾', name: '세금 계산기',  desc: '양도세·거래세', component: true },
      { id: 'dca',       emoji: '📅', name: 'DCA 계획',     desc: '분할매수 스케줄', component: true },
    ],
  },
  {
    label: '장기투자 플래너',
    sub: 'ETF · 복리 · 게좌 전략',
    tools: [
      { id: 'index',    emoji: '🌐', name: '지수 분석',       desc: '코스피·나스닥 이동평균', component: true },
      { id: 'compound', emoji: '📈', name: '복리 시뮬레이터', desc: '적립식 장기 계산', component: true },
    ],
  },
];

const COMPONENTS = { backtest: BacktestTool, rebalance: RebalanceCalc, tax: TaxCalc, dca: DCAPlanner, index: IndexAnalysis, compound: CompoundCalc };
const STUB_IDS = ['opening'];

export default function ToolsPage() {
  const [active, setActive] = useState(null);
  const navigate = useNavigate();

  const handleTool = (tool) => {
    if (tool.link) { navigate(tool.link); return; }
    setActive(tool.id);
  };

  if (active) {
    const name = CATEGORIES.flatMap(c => c.tools).find(t => t.id === active)?.name || '';
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
            <Comp />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-3 bg-surface-950">
        <h1 className="text-xl font-bold text-white">도구</h1>
        <p className="text-xs text-slate-500 mt-0.5">{CATEGORIES.reduce((s, c) => s + c.tools.length, 0)}가지 도구 · {CATEGORIES.length}개 카테고리</p>
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
