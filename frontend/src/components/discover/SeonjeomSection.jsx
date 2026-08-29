import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../../contexts/AuthContext';
import { zoneMeta, parkColor, hitMeta } from '../../lib/matrix';

// 선점 알림 — 박세익 60점 이상 종목 중 오늘 전환 신호가 겹친 종목.
// 계산은 야간 배치(cron evaluateSeonjeomTriggers)가 끝내두고 여기서는 읽기만 한다.
// 관심종목 알림(AlertsCard)과 성격이 다르다 — 이쪽은 아직 보유도 관심등록도 안 한
// 시장 전체 스크린 결과다.
export default function SeonjeomSection() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/seonjeom', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const items = data?.items ?? [];
  const baseline = data?.rsBaseline;

  return (
    <section className="px-4 mt-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-300">선점 알림</h3>
        {data?.date && (
          <span className="text-[11px] text-slate-500">
            {data.date} · {items.length}종목
          </span>
        )}
      </div>
      <p className="text-[10px] text-slate-600 mb-3">
        박세익 60점 이상 · RS 전환 / 수급 전환 / 거래량 급증 중 2개 이상 동시 발생
      </p>

      {loading && (
        <div className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 bg-surface-900 rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="bg-surface-900 rounded-xl py-5 text-center">
          <p className="text-sm text-red-400">선점 알림을 불러오지 못했습니다</p>
          <p className="text-xs text-slate-600 mt-1">{error}</p>
        </div>
      )}

      {/* 하루 지난 결과는 지우지 않고 표시한다(server.js /api/seonjeom 주석) —
          "오늘 0건"과 "배치가 안 돌았음"을 화면에서 구분할 수 있어야 한다. */}
      {!loading && !error && data?.stale && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 mb-2">
          <p className="text-[11px] text-amber-400">
            오늘 평가 결과가 아직 없습니다. 아래는 {data.date} 기준입니다.
          </p>
        </div>
      )}

      {!loading && !error && data?.message && (
        <div className="bg-surface-900 rounded-xl py-6 text-center">
          <p className="text-sm text-slate-500">{data.message}</p>
        </div>
      )}

      {!loading && !error && !data?.message && items.length === 0 && (
        <div className="bg-surface-900 rounded-xl py-6 text-center">
          <p className="text-sm text-slate-500">오늘 발동한 종목이 없습니다</p>
          <p className="text-xs text-slate-600 mt-1">조건 2개가 동시에 겹치는 날만 신호로 봅니다</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-1.5">
          {items.map(it => {
            const zm = zoneMeta(it.zone);
            return (
              <button
                key={it.code}
                onClick={() => navigate(`/stock?code=${it.code}`)}
                className="w-full bg-surface-900 rounded-xl px-3 py-2.5 text-left hover:bg-slate-800 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white truncate">{it.name || it.code}</span>
                      <span className="text-[10px] text-slate-600 font-mono shrink-0">{it.code}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {it.zone && <span className={`text-[9px] px-1.5 py-px rounded ${zm.cls}`}>{zm.label}</span>}
                      {it.parkScore != null && (
                        <span className={`text-[10px] font-medium ${parkColor(it.parkScore)}`}>
                          박세익 {Math.round(it.parkScore)}
                        </span>
                      )}
                      {it.rsPct != null && (
                        <span className="text-[10px] text-slate-500">RS {Math.round(it.rsPct)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 items-end shrink-0">
                    {(it.hits ?? []).map(h => {
                      const hm = hitMeta(h);
                      return (
                        <span key={h} className={`text-[9px] px-1.5 py-px rounded ${hm.cls}`}>{hm.label}</span>
                      );
                    })}
                  </div>
                </div>
                {(it.reasons ?? []).length > 0 && (
                  <p className="text-[10px] text-slate-600 mt-1.5 leading-relaxed">
                    {it.reasons.join(' · ')}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* RS 조건은 직전 스캔의 횡단면 분포에 의존한다. 기준선이 없거나 묵었으면
          "발동 0건"의 의미가 달라지므로 산출일·표본 수를 함께 노출한다. */}
      {!loading && !error && data && (
        <p className="text-[10px] text-slate-600 mt-2">
          {baseline?.date
            ? `RS 백분위 기준선: ${baseline.date} · ${baseline.n?.toLocaleString('ko-KR') ?? '?'}종목`
            : 'RS 백분위 기준선 없음 — RS 조건은 이번 평가에서 제외됐습니다'}
        </p>
      )}
    </section>
  );
}
