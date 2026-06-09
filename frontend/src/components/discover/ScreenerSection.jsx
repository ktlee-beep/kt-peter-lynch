import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

const PRESETS = [
  { key: 'lynch',  label: '피터 린치', desc: 'PER≤20 · ROE≥10 · 부채≤150%' },
  { key: 'value',  label: '가치주',    desc: 'PER≤10 · PBR≤1' },
  { key: 'growth', label: '성장주',    desc: 'ROE≥15 · 린치점수≥60' },
];

const SORTS = [
  { key: 'lynch_score', label: '린치점수' },
  { key: 'combined',    label: '종합점수' },
  { key: 'per',         label: 'PER 낮은순' },
  { key: 'roe',         label: 'ROE 높은순' },
];

function FilterSlider({ label, value, onChange, min, max, step = 1, unit = '' }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className="text-[11px] text-brand-400 font-medium">
          {value === null ? '제한없음' : `${value}${unit} 이하`}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value ?? max}
        onChange={e => {
          const v = parseFloat(e.target.value);
          onChange(v >= max ? null : v);
        }}
        className="w-full accent-brand-400"
      />
      <div className="flex justify-between text-[9px] text-slate-700">
        <span>{min}{unit}</span><span>제한없음</span>
      </div>
    </div>
  );
}

function FilterSliderMin({ label, value, onChange, min, max, step = 1, unit = '' }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className="text-[11px] text-brand-400 font-medium">
          {value === null ? '제한없음' : `${value}${unit} 이상`}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value ?? min}
        onChange={e => {
          const v = parseFloat(e.target.value);
          onChange(v <= min ? null : v);
        }}
        className="w-full accent-brand-400"
      />
      <div className="flex justify-between text-[9px] text-slate-700">
        <span>제한없음</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

function ResultItem({ item }) {
  const navigate = useNavigate();
  const pos = item.changeRate > 0, neg = item.changeRate < 0;
  const fmtPct = (v) => v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  return (
    <button
      onClick={() => navigate(`/stock?code=${item.code}`)}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-800 transition-colors text-left"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white truncate">{item.name}</span>
          <span className="text-[10px] text-slate-600 shrink-0">{item.code}</span>
        </div>
        <div className="flex gap-2 mt-0.5 flex-wrap">
          {item.per  != null && <span className="text-[10px] text-slate-500">PER {item.per.toFixed(1)}배</span>}
          {item.pbr  != null && <span className="text-[10px] text-slate-500">PBR {item.pbr.toFixed(2)}배</span>}
          {item.roe  != null && <span className="text-[10px] text-slate-500">ROE {item.roe.toFixed(1)}%</span>}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-bold text-white">{item.close?.toLocaleString('ko-KR')}원</div>
        <div className={`text-xs ${pos ? 'text-profit' : neg ? 'text-loss' : 'text-slate-500'}`}>
          {fmtPct(item.changeRate)}
        </div>
        <div className="text-[10px] text-brand-400 mt-0.5">린치 {Math.round(item.lynchScore ?? 0)}</div>
      </div>
    </button>
  );
}

export default function ScreenerSection() {
  const [open, setOpen] = useState(true);
  const [preset, setPreset] = useState('lynch');
  const [perMax,  setPerMax]  = useState(20);
  const [pbrMax,  setPbrMax]  = useState(3);
  const [roeMin,  setRoeMin]  = useState(10);
  const [debtMax, setDebtMax] = useState(150);
  const [lynchMin, setLynchMin] = useState(50);
  const [sortBy,  setSortBy]  = useState('lynch_score');
  const [page,    setPage]    = useState(1);
  const [results, setResults] = useState(null);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [noData,  setNoData]  = useState(false);

  // 페이지 진입 시 린치 프리셋으로 자동 실행
  useEffect(() => { runScreener(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyPreset = (key) => {
    setPreset(key);
    if (key === 'lynch')  { setPerMax(20);  setPbrMax(3);   setRoeMin(10);  setDebtMax(150); setLynchMin(50); }
    if (key === 'value')  { setPerMax(10);  setPbrMax(1);   setRoeMin(8);   setDebtMax(200); setLynchMin(null); }
    if (key === 'growth') { setPerMax(40);  setPbrMax(5);   setRoeMin(15);  setDebtMax(100); setLynchMin(60); }
  };

  const runScreener = useCallback(async (pg = 1) => {
    setLoading(true); setError(null); setNoData(false);
    const params = new URLSearchParams({ sort: sortBy, page: pg, limit: 20 });
    if (preset) { params.set('preset', preset); }
    else {
      if (perMax   != null) params.set('per_max',   perMax);
      if (pbrMax   != null) params.set('pbr_max',   pbrMax);
      if (roeMin   != null) params.set('roe_min',   roeMin);
      if (debtMax  != null) params.set('debt_max',  debtMax);
      if (lynchMin != null) params.set('lynch_min', lynchMin);
    }
    try {
      const r = await fetch(`/api/screener?${params}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '스크리너 오류');
      if (d.message) { setNoData(true); setResults([]); }
      else { setResults(d.items); setTotal(d.total); setPage(pg); }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [preset, perMax, pbrMax, roeMin, debtMax, lynchMin, sortBy]);

  const LIMIT = 20;

  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-900 border-y border-slate-800"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">가치투자 스크리너</span>
          {results !== null && <span className="text-[11px] text-brand-400">{total}개 종목</span>}
        </div>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="bg-surface-950">
          {/* Presets */}
          <div className="px-4 pt-3 pb-2">
            <p className="text-[10px] text-slate-600 mb-2">프리셋</p>
            <div className="flex gap-2">
              {PRESETS.map(p => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className={`flex-1 py-2 rounded-xl text-[11px] font-medium transition-colors ${
                    preset === p.key ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30' : 'bg-surface-900 text-slate-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              {preset && (
                <button onClick={() => { setPreset(null); setPerMax(null); setPbrMax(null); setRoeMin(null); setDebtMax(null); setLynchMin(null); }}
                  className="px-2 text-[11px] text-slate-600 bg-surface-900 rounded-xl">초기화</button>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="px-4 pb-3 space-y-3">
            <FilterSlider   label="PER 최대"    value={perMax}   onChange={setPerMax}   min={0} max={100} step={1} unit="배" />
            <FilterSlider   label="PBR 최대"    value={pbrMax}   onChange={setPbrMax}   min={0} max={10}  step={0.5} unit="배" />
            <FilterSliderMin label="ROE 최소"   value={roeMin}   onChange={setRoeMin}   min={0} max={50}  step={1} unit="%" />
            <FilterSlider   label="부채비율 최대" value={debtMax} onChange={setDebtMax} min={0} max={500} step={10} unit="%" />
            <FilterSliderMin label="린치점수 최소" value={lynchMin} onChange={setLynchMin} min={0} max={100} step={5} />
          </div>

          {/* Sort + Run */}
          <div className="px-4 pb-3 flex items-center gap-2">
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              className="flex-1 bg-surface-900 text-xs text-slate-300 rounded-lg px-3 py-2 outline-none border border-slate-800"
            >
              {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button
              onClick={() => runScreener(1)}
              disabled={loading}
              className="px-4 py-2 bg-brand-500 text-white text-sm font-semibold rounded-xl disabled:opacity-50"
            >
              {loading ? '검색 중...' : '스크리닝'}
            </button>
          </div>

          {/* Results */}
          {error && <p className="px-4 py-3 text-xs text-red-400">{error}</p>}
          {noData && (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-slate-500">스캔 데이터가 없습니다</p>
              <p className="text-xs text-slate-700 mt-1">일일 스캔(20:00 KST) 후 사용 가능합니다</p>
            </div>
          )}
          {results !== null && !noData && (
            <>
              {results.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-slate-500">조건에 맞는 종목이 없습니다</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-800/50">
                  {results.map(item => <ResultItem key={item.code} item={item} />)}
                </div>
              )}
              {/* Pagination */}
              {total > LIMIT && (
                <div className="flex justify-center gap-3 px-4 py-3">
                  <button
                    onClick={() => runScreener(page - 1)}
                    disabled={page <= 1 || loading}
                    className="px-3 py-1.5 text-xs bg-surface-900 text-slate-400 rounded-lg disabled:opacity-30"
                  >이전</button>
                  <span className="px-3 py-1.5 text-xs text-slate-500">{page} / {Math.ceil(total / LIMIT)}</span>
                  <button
                    onClick={() => runScreener(page + 1)}
                    disabled={page >= Math.ceil(total / LIMIT) || loading}
                    className="px-3 py-1.5 text-xs bg-surface-900 text-slate-400 rounded-lg disabled:opacity-30"
                  >다음</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
