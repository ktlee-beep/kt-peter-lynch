import { useState, useRef, useEffect, useCallback } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const RECENT_KEY = 'kt_recent_searches';
const MAX_RECENT = 5;

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function saveRecent(stock) {
  const prev = getRecent().filter(s => s.code !== stock.code);
  localStorage.setItem(RECENT_KEY, JSON.stringify([stock, ...prev].slice(0, MAX_RECENT)));
}

export default function StockSearchBar({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [recent, setRecent] = useState(getRecent);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const inputRef = useRef(null);
  const composing = useRef(false);
  const timer = useRef(null);
  const containerRef = useRef(null);

  const search = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const r = await fetch(`/api/stock/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
      const d = await r.json();
      setResults(d.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    if (!composing.current) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => search(val), 280);
    }
    setOpen(true);
  };

  const handleCompositionStart = () => { composing.current = true; };
  const handleCompositionEnd = (e) => {
    composing.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(e.target.value), 280);
  };

  const handleSelect = (stock) => {
    saveRecent(stock);
    setRecent(getRecent());
    setQuery('');
    setResults([]);
    setOpen(false);
    onSelect?.(stock);
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    inputRef.current?.focus();
  };

  useEffect(() => {
    const onPointerDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const showRecent = open && !query.trim() && recent.length > 0;
  const showResults = open && query.trim().length > 0;
  const dropdownItems = showResults ? results : showRecent ? recent : [];

  return (
    <div ref={containerRef} className="relative px-4">
      <div className="flex items-center bg-surface-900 rounded-xl px-3 gap-2">
        <svg className="w-4 h-4 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0Z" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          value={query}
          onChange={handleChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onFocus={() => setOpen(true)}
          placeholder="종목명 또는 코드 검색"
          className="flex-1 bg-transparent py-3 text-sm text-white placeholder-slate-500 outline-none"
        />
        {query && (
          <button onClick={handleClear} className="text-slate-500 hover:text-slate-300 p-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {loading && (
          <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
        )}
      </div>

      {open && (showRecent || showResults) && (
        <div className="absolute left-4 right-4 z-50 mt-1 bg-surface-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          {showRecent && (
            <div className="px-3 pt-2 pb-1">
              <span className="text-[11px] text-slate-500 font-medium">최근 검색</span>
            </div>
          )}
          {dropdownItems.length === 0 && showResults && !loading && (
            <p className="px-4 py-3 text-sm text-slate-500">검색 결과가 없습니다</p>
          )}
          {dropdownItems.map((s) => (
            <button
              key={s.code}
              onPointerDown={(e) => { e.preventDefault(); handleSelect(s); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800 active:bg-slate-700 transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm text-white font-medium">{s.name}</span>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[11px] text-slate-500 font-mono">{s.code}</span>
                  <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${
                    s.market === 'KOSPI' ? 'bg-blue-500/20 text-blue-400' :
                    s.market === 'KOSDAQ' ? 'bg-purple-500/20 text-purple-400' :
                    'bg-slate-700 text-slate-400'
                  }`}>{s.market || '기타'}</span>
                  {s.sector && (
                    <span className="text-[10px] text-slate-500">{s.sector}</span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
