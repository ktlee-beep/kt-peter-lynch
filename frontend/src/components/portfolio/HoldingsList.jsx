import { useNavigate } from 'react-router-dom';

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

function HoldingItem({ holding, priceInfo, alert }) {
  const navigate = useNavigate();

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

  // 현재가 기준 목표/손절까지 거리(%)
  const targetGap = (target != null && price) ? ((target - price) / price) * 100 : null;
  const stopGap   = (stop   != null && price) ? ((stop   - price) / price) * 100 : null;

  // 손절~목표 구간에서 현재가 위치 (둘 다 있고 목표>손절일 때만)
  let barPos = null;
  if (target != null && stop != null && target > stop && price) {
    barPos = Math.min(100, Math.max(0, ((price - stop) / (target - stop)) * 100));
  }

  // 행동 배지
  let badge = null;
  if (price && target != null && price >= target) badge = { text: '목표 도달', cls: 'bg-profit/20 text-profit' };
  else if (price && stop != null && price <= stop) badge = { text: '손절 이탈', cls: 'bg-loss/20 text-loss' };

  return (
    <div
      className="bg-surface-900 rounded-xl px-4 py-3 cursor-pointer hover:bg-slate-800 active:bg-slate-700 transition-colors"
      onClick={() => navigate(`/stock?code=${holding.code}`)}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-white truncate">{holding.name}</p>
            {badge && (
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

      {hasLevels ? (
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
            <span className="text-slate-500">
              목표 {target != null
                ? <span className="text-profit font-medium">{fmtKRW(target)}</span>
                : <span className="text-slate-600">미설정</span>}
              {targetGap != null && <span className="text-profit ml-1">{pctLabel(targetGap)}</span>}
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/tools?tool=alerts'); }}
          className="mt-2 text-[10px] text-slate-600 hover:text-brand-400 transition-colors"
        >
          + 목표가·손절가 설정
        </button>
      )}
    </div>
  );
}

export default function HoldingsList({ holdings, priceMap, alertMap }) {
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
        <HoldingItem key={h.code} holding={h} priceInfo={priceMap?.[h.code]} alert={alertMap?.[h.code]} />
      ))}
    </div>
  );
}
