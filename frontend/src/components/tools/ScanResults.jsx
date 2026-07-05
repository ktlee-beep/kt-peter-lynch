import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';

const SIGNALS = [
  { id: 'BUY',  label: '매수 추천', color: 'text-green-400', activeBg: 'bg-green-500/20 text-green-400' },
  { id: 'HOLD', label: '관망',      color: 'text-yellow-400', activeBg: 'bg-yellow-500/20 text-yellow-400' },
  { id: 'SELL', label: '매도 경고', color: 'text-red-400',   activeBg: 'bg-red-500/20 text-red-400' },
];

function scoreColor(v) {
  if (v == null) return 'text-slate-500';
  if (v >= 70) return 'text-green-400';
  if (v >= 50) return 'text-yellow-400';
  return 'text-slate-400';
}

function ScoreCell({ label, value, max = 100 }) {
  return (
    <div className="flex flex-col items-center flex-1">
      <span className="text-[10px] text-slate-500">{label}</span>
      <span className={`text-xs font-semibold ${scoreColor(max === 9 ? (value ?? 0) / 9 * 100 : value)}`}>
        {value ?? '-'}{max === 9 ? '/9' : ''}
      </span>
    </div>
  );
}

export default function ScanResults() {
  const navigate = useNavigate();
  const [signal, setSignal]     = useState('BUY');
  const [results, setResults]   = useState([]);
  const [date, setDate]         = useState('');
  const [status, setStatus]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async (sig) => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/scan/results?signal=${sig}&limit=50`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      let items = d.results || [];
      let resultDate = d.date;
      if (!items.length) {
        for (let back = 1; back <= 7 && !items.length; back++) {
          const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const r2 = await fetch(`/api/scan/results?signal=${sig}&date=${day}&limit=50`, { headers: authHeaders() });
          const d2 = await r2.json();
          if (r2.ok && d2.results?.length) { items = d2.results; resultDate = day; }
        }
      }
      setResults(items);
      setDate(resultDate || '');
    } catch (e) {
      setError(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const r = await fetch('/api/scan/trigger', { method: 'POST', headers: authHeaders() });
      if (!r.ok) throw new Error('트리거 실패');
      // 15초마다 상태 폴링 → 완료되면 결과 갱신
      const poll = setInterval(async () => {
        try {
          const s = await fetch('/api/scan/status', { headers: authHeaders() }).then(r => r.json());
          setStatus(s);
          // 서버는 완료 시 'done' 기록 (db.js completeScanBatch) — 'completed'는 하위 호환 유지
          if (s.status === 'done' || s.status === 'completed' || s.status === 'idle') {
            clearInterval(poll);
            setScanning(false);
            load(signal);
          }
        } catch { /* ignore */ }
      }, 15000);
      // 최대 15분 후 강제 종료
      setTimeout(() => { clearInterval(poll); setScanning(false); load(signal); }, 15 * 60 * 1000);
    } catch (e) {
      setError(e.message);
      setScanning(false);
    }
  }, [scanning, signal, load]);

  useEffect(() => { load(signal); }, [signal, load]);

  useEffect(() => {
    fetch('/api/scan/status', { headers: authHeaders() })
      .then(r => r.json()).then(d => setStatus(d)).catch(() => {});
  }, []);

  return (
    <div className="px-4 py-2 space-y-3">
      <div className="bg-surface-900 rounded-xl p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] text-slate-500 leading-relaxed flex-1">
            매 영업일 20:00 전 종목 자동 스캔 — 피터 린치(펀더멘털+가격) · 제시 리버모어(추세+모멘텀) ·
            피오트로스키 F-Score 3중 채점 후 종합 시그널 산출
          </p>
          <button
            onClick={triggerScan}
            disabled={scanning}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-500/20 text-brand-400 disabled:opacity-50 disabled:cursor-not-allowed active:bg-brand-500/30 transition-colors"
          >
            {scanning ? (
              <>
                <span className="w-3 h-3 border border-brand-400 border-t-transparent rounded-full animate-spin" />
                스캔 중...
              </>
            ) : '지금 스캔'}
          </button>
        </div>
        {status?.lastBatch?.started_at && (
          <p className="text-[10px] text-slate-600 mt-1">
            마지막 스캔: {String(status.lastBatch.started_at).slice(0, 16).replace('T', ' ')} ({status.status})
          </p>
        )}
      </div>

      <div className="flex gap-2">
        {SIGNALS.map(s => (
          <button key={s.id} onClick={() => setSignal(s.id)}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
              signal === s.id ? s.activeBg : 'bg-surface-900 text-slate-500'
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {date && !loading && results.length > 0 && (
        <p className="text-[11px] text-slate-500 px-1">{date} 기준 · {results.length}종목 (신뢰도순)</p>
      )}

      {loading && (
        <div className="flex justify-center py-10">
          <div className="w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && !loading && (
        <div className="bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">
          조회 실패: {error}
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="bg-surface-900 rounded-xl p-6 text-center space-y-3">
          <p className="text-slate-400 text-sm">최근 7일 내 스캔 결과가 없습니다</p>
          <p className="text-slate-600 text-xs">매 영업일 20:00(KST)에 자동 스캔이 실행됩니다</p>
          <button
            onClick={triggerScan}
            disabled={scanning}
            className="mx-auto flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-brand-500/20 text-brand-400 disabled:opacity-50 disabled:cursor-not-allowed active:bg-brand-500/30 transition-colors"
          >
            {scanning ? (
              <>
                <span className="w-3.5 h-3.5 border border-brand-400 border-t-transparent rounded-full animate-spin" />
                스캔 중 (5~10분 소요)
              </>
            ) : '지금 스캔 실행'}
          </button>
        </div>
      )}

      {!loading && results.map(r => (
        <button key={r.code}
          onClick={() => navigate(`/stock?code=${r.code}`)}
          className="w-full bg-surface-900 rounded-xl p-3.5 text-left active:bg-slate-800 transition-colors">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-white truncate">{r.name || r.code}</span>
              <span className={`text-[10px] px-1.5 py-px rounded font-medium flex-shrink-0 ${
                r.market === 'KOSPI' ? 'bg-blue-500/20 text-blue-400' :
                r.market === 'KOSDAQ' ? 'bg-purple-500/20 text-purple-400' :
                'bg-slate-700 text-slate-400'
              }`}>{r.market || '기타'}</span>
              {r.sector && <span className="text-[10px] text-slate-500 flex-shrink-0">{r.sector}</span>}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {r.change_rate != null && (
                <span className={`text-xs font-medium ${r.change_rate >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {r.change_rate >= 0 ? '+' : ''}{Number(r.change_rate).toFixed(1)}%
                </span>
              )}
              <span className="text-[11px] text-brand-400 font-semibold">신뢰도 {r.confidence ?? '-'}%</span>
            </div>
          </div>
          <div className="flex items-center bg-surface-950 rounded-lg py-1.5">
            <ScoreCell label="린치" value={r.lynch_score} />
            <ScoreCell label="리버모어" value={r.livermore_score} />
            <ScoreCell label="F-Score" value={r.piotroski_score} max={9} />
            <ScoreCell label="종합" value={r.combined_score} />
          </div>
        </button>
      ))}
    </div>
  );
}
