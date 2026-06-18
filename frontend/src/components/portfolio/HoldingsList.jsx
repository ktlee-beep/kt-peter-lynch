import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

function fmtKRW(n) {
  if (n == null) return null;
  const abs = Math.abs(n);
  if (abs >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (abs >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`;
  return n.toLocaleString('ko-KR');
}

function pctLabel(n) {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function HoldingItem({ holding, priceInfo, alert, onAlertSaved }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [stopInput, setStopInput] = useState('');
  const [saving, setSaving] = useState(false);

  const price = priceInfo?.currentPrice ?? null;
  const currentValue = priceInfo?.currentValue ?? null;
  const pnl = priceInfo?.pnl ?? null;
  const pnlPct = priceInfo?.pnlPct ?? null;
  const investedValue = holding.avgPrice * holding.shares;
  const up = pnl > 0;
  const dn = pnl < 0;
  const colorCls = up ? 'text-profit' : dn ? 'text-loss' : 'text-slate-400';

  const target = alert?.target_price ?? null;
  const stop = alert?.stop_loss ?? null;
  const hasLevels = target != null || stop != null;

  const targetGap = (target != null && price) ? ((target - price) / price) * 100 : null;
  const stopGap   = (stop   != null && price) ? ((stop   - price) / price) * 100 : null;

  let barPos = null;
  if (target != null && stop != null && target > stop && price) {
    barPos = Math.min(100, Math.max(0, ((price - stop) / (target - stop)) * 100));
  }

  let badge = null;
  if (price && target != null && price >= target) badge = { text: '목표 도달', cls: 'bg-profit/20 text-profit' };
  else if (price && stop != null && price <= stop) badge = { text: '손절 이탈', cls: 'bg-loss/20 text-loss' };

  const openEdit = useCallback((e) => {
    e.stopPropagation();
    setTargetInput(target != null ? String(target) : '');
    setStopInput(stop != null ? String(stop) : '');
    setEditing(true);
  }, [target, stop]);

  const cancelEdit = useCallback((e) => {
    e.stopPropagation();
    setEditing(false);
  }, []);

  const saveEdit = useCallback(async (e) => {
    e.stopPropagation();
    setSaving(true);
    try {
      const body = {
        code: holding.code,
        target_price: targetInput !== '' ? Number(targetInput) : null,
        stop_loss: stopInput !== '' ? Number(stopInput) : null,
        is_active: true,
      };
      await fetch('/api/alert-settings', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onAlertSaved?.(holding.code, {
        ...(alert || {}),
        target_price: body.target_price,
        stop_loss: body.stop_loss,
      });
      setEditing(false);
    } catch {}
    setSaving(false);
  }, [holding.code, targetInput, stopInput, alert, onAlertSaved]);

  return (
    <div
      className="bg-surface-900 rounded-xl px-4 py-3 cursor-pointer hover:bg-slate-800 active:bg-slate-700 transition-colors"
      onClick={() => !editing && navigate(`/stock?code=${holding.code}`)}
    >
      {/* 종목명 + 손익 */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-white truncate">{holding.name}</p>
            {badge && !editing && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${badge.cls}`}>{badge.text}</span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">
            {holding.shares}주 · 평단 {holding.avgPrice.toLocaleString('ko-KR')}원
          </span>
        </div>
        <div className="text-right flex-shrink-0">
          {price != null ? (
            <>
              <p className="text-sm font-bold text-white">{fmtKRW(currentValue)}</p>
              <p className={`text-[11px] ${colorCls}`}>
                {up ? '+' : ''}{fmtKRW(pnl)}
                {pnlPct != null && (
                  <span className="ml-1">({up ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-bold text-white">{fmtKRW(investedValue)}</p>
              <div className="w-20 h-3 bg-slate-800 rounded animate-pulse mt-1" />
            </>
          )}
        </div>
      </div>

      {/* 인라인 편집 폼 */}
      {editing ? (
        <div
          className="mt-2.5 pt-2.5 border-t border-slate-800/80"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[9px] text-profit mb-0.5 block">목표가</label>
              <input
                type="number"
                inputMode="numeric"
                placeholder={price ? String(Math.round(price * 1.1)) : '예: 80000'}
                value={targetInput}
                onChange={e => setTargetInput(e.target.value)}
                className="w-full bg-slate-800 text-white text-xs rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-profit/50 placeholder:text-slate-600"
              />
            </div>
            <div className="flex-1">
              <label className="text-[9px] text-loss mb-0.5 block">손절가</label>
              <input
                type="number"
                inputMode="numeric"
                placeholder={price ? String(Math.round(price * 0.9)) : '예: 65000'}
                value={stopInput}
                onChange={e => setStopInput(e.target.value)}
                className="w-full bg-slate-800 text-white text-xs rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-loss/50 placeholder:text-slate-600"
              />
            </div>
          </div>
          <div className="flex gap-1.5 mt-2">
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving}
              className="flex-1 text-[11px] font-medium py-1.5 rounded-lg bg-brand-500 text-white disabled:opacity-50"
            >
              {saving ? '저장 중...' : '저장'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="px-3 text-[11px] py-1.5 rounded-lg bg-slate-800 text-slate-400"
            >
              취소
            </button>
          </div>
        </div>
      ) : hasLevels ? (
        <div className="mt-2.5 pt-2.5 border-t border-slate-800/80">
          {barPos != null && (
            <div className="relative h-1.5 rounded-full bg-gradient-to-r from-loss/40 via-slate-700 to-profit/40 mb-1.5">
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-white shadow"
                style={{ left: `${barPos}%` }}
              />
            </div>
          )}
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-500">
              손절 {stop != null
                ? <span className="text-loss font-medium">{fmtKRW(stop)}</span>
                : <span className="text-slate-600">미설정</span>}
              {stopGap != null && <span className="text-loss ml-1">{pctLabel(stopGap)}</span>}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">
                목표 {target != null
                  ? <span className="text-profit font-medium">{fmtKRW(target)}</span>
                  : <span className="text-slate-600">미설정</span>}
                {targetGap != null && <span className="text-profit ml-1">{pctLabel(targetGap)}</span>}
              </span>
              <button
                type="button"
                onClick={openEdit}
                className="text-slate-600 hover:text-brand-400 transition-colors"
                title="수정"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openEdit}
          className="mt-2 text-[10px] text-slate-600 hover:text-brand-400 transition-colors"
        >
          + 목표가·손절가 설정
        </button>
      )}
    </div>
  );
}

export default function HoldingsList({ holdings, priceMap, alertMap, onAlertSaved }) {
  if (!holdings) {
    return (
      <div className="space-y-2 px-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-surface-900 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="w-14 h-14 rounded-2xl bg-surface-900 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
          </svg>
        </div>
        <p className="text-sm text-slate-400 font-medium">보유 종목이 없습니다</p>
        <p className="text-xs text-slate-600 mt-1">매수 거래를 입력하면 여기에 표시됩니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-4">
      {holdings.map(h => (
        <HoldingItem
          key={h.code}
          holding={h}
          priceInfo={priceMap?.[h.code]}
          alert={alertMap?.[h.code]}
          onAlertSaved={onAlertSaved}
        />
      ))}
    </div>
  );
}
