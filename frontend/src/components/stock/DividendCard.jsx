export default function DividendCard({ fundamentals }) {
  const yield_ = fundamentals?.dividendYield;
  const per = fundamentals?.per;

  if (yield_ == null && per == null) return null;

  return (
    <div className="px-4 mt-3">
      <div className="bg-surface-900 rounded-xl px-4 py-4">
        <p className="text-xs font-semibold text-slate-300 mb-3">배당 정보</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-800/50 rounded-xl p-3">
            <p className="text-[10px] text-slate-500 mb-1">배당수익률</p>
            <p className={`text-base font-bold ${yield_ > 0 ? 'text-profit' : 'text-slate-500'}`}>
              {yield_ != null ? `${yield_.toFixed(2)}%` : '-'}
            </p>
            {yield_ > 0 && yield_ < 2 && (
              <p className="text-[9px] text-slate-600 mt-0.5">성장주 수준</p>
            )}
            {yield_ >= 2 && yield_ < 4 && (
              <p className="text-[9px] text-slate-600 mt-0.5">적정 배당</p>
            )}
            {yield_ >= 4 && (
              <p className="text-[9px] text-yellow-600 mt-0.5">고배당 주의 확인</p>
            )}
          </div>
          <div className="bg-slate-800/50 rounded-xl p-3">
            <p className="text-[10px] text-slate-500 mb-1">PER 기준 수익률</p>
            <p className="text-base font-bold text-slate-300">
              {per && per > 0 ? `${(100 / per).toFixed(1)}%` : '-'}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">이익 전부 배당 시</p>
          </div>
        </div>
        <p className="text-[9px] text-slate-700 text-center mt-3">
          Naver Finance 기준 · 실제 DPS는 종목 공시 확인
        </p>
      </div>
    </div>
  );
}
