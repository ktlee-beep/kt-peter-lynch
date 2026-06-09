import { useState } from 'react';
import BuyChecklist from '../components/decision/BuyChecklist';
import SellChecklist from '../components/decision/SellChecklist';
import PositionCalculator from '../components/decision/PositionCalculator';
import RiskRewardCalc from '../components/decision/RiskRewardCalc';
import AlertSettings from '../components/decision/AlertSettings';

const TABS = ['매수', '매도', '포지션', '손익비', '알림'];

export default function DecisionPage() {
  const [tab, setTab] = useState('매수');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-3 bg-surface-950">
        <h1 className="text-xl font-bold text-white">결정 지원</h1>
        <p className="text-xs text-slate-500 mt-0.5">매수 전 체크리스트 · 포지션 계산 · 손익비</p>
      </div>

      <div className="flex border-b border-slate-800 bg-surface-950">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              tab === t
                ? 'text-brand-400 border-b-2 border-brand-400'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pb-20 pt-4 scrollbar-hide">
        {tab === '매수' && <BuyChecklist />}
        {tab === '매도' && <SellChecklist />}
        {tab === '포지션' && <PositionCalculator />}
        {tab === '손익비' && <RiskRewardCalc />}
        {tab === '알림' && <AlertSettings />}
        <div className="h-4" />
      </div>
    </div>
  );
}
