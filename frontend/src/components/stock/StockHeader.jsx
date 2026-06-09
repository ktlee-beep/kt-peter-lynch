import { useNavigate } from 'react-router-dom';

export default function StockHeader({ data, inWatchlist, onWatchlistToggle, toggling }) {
  const navigate = useNavigate();

  const up = data?.changeRate > 0;
  const dn = data?.changeRate < 0;
  const colorCls = up ? 'text-profit' : dn ? 'text-loss' : 'text-slate-300';

  return (
    <div className="px-4 pt-4 pb-3 bg-surface-950 sticky top-0 z-10">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="flex-1 mx-3 min-w-0">
          {data ? (
            <>
              <h1 className="text-base font-bold text-white truncate">{data.name}</h1>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 font-mono">{data.code}</span>
                {data.market && (
                  <span className={`text-[10px] px-1 py-px rounded font-medium ${
                    data.market === 'KOSPI' ? 'bg-blue-500/20 text-blue-400' :
                    data.market === 'KOSDAQ' ? 'bg-purple-500/20 text-purple-400' :
                    'bg-slate-700 text-slate-400'
                  }`}>{data.market}</span>
                )}
              </div>
            </>
          ) : (
            <div className="h-4 bg-surface-800 rounded animate-pulse w-32" />
          )}
        </div>

        <button
          onClick={onWatchlistToggle}
          disabled={toggling || !data}
          className="p-2 rounded-full transition-colors disabled:opacity-50"
        >
          <svg
            className={`w-5 h-5 transition-colors ${inWatchlist ? 'text-brand-400 fill-brand-400' : 'text-slate-500'}`}
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={inWatchlist ? 0 : 1.5}
            fill={inWatchlist ? 'currentColor' : 'none'}
          >
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
            />
          </svg>
        </button>
      </div>

      {data ? (
        <div className="flex items-end gap-3">
          <span className="text-3xl font-bold text-white tracking-tight">
            {data.close?.toLocaleString('ko-KR')}
          </span>
          <div className={`flex items-center gap-1 pb-0.5 ${colorCls}`}>
            <span className="text-sm font-medium">
              {up ? '+' : ''}{data.change?.toLocaleString('ko-KR')}
            </span>
            <span className="text-sm font-medium">
              ({up ? '+' : ''}{data.changeRate?.toFixed(2)}%)
            </span>
          </div>
        </div>
      ) : (
        <div className="h-9 bg-surface-800 rounded animate-pulse w-48" />
      )}
    </div>
  );
}
