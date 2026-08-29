import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';
import { zoneMeta, parkColor, hitMeta, fmtDrop } from '../../lib/matrix';

// 저평가 선점 진단 — 박세익 축(3년 실적) · 매트릭스 존 · RS 백분위 · 수급 추세.
// 값은 전부 야간 스캔이 저장한 blob에서 온다. 종합 탭의 다른 카드들과 달리 즉석 계산이
// 아니므로 기준일을 반드시 함께 보여준다 — 3년 실적 판정을 오늘 값으로 오해하면 안 된다.
function Bar({ score }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  return (
    <div className="h-1.5 bg-surface-800 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${pct >= 80 ? 'bg-brand-400' : pct >= 60 ? 'bg-green-400' : pct >= 40 ? 'bg-amber-400' : 'bg-slate-600'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Metric({ label, value, sub }) {
  return (
    <div className="bg-surface-800/50 rounded-lg px-2.5 py-2">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-sm font-semibold text-slate-200 mt-0.5">{value}</p>
      {sub && <p className="text-[9px] text-slate-600 mt-0.5">{sub}</p>}
    </div>
  );
}

// 수급 원자료의 날짜는 네이버 표기(YYYYMMDD)로 들어온다 — 스캔 기준일(YYYY-MM-DD)과
// 형식이 다르므로 그대로 찍으면 한 카드 안에서 두 가지 날짜 표기가 섞인다.
function fmtDay(d) {
  const s = String(d || '').replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : (d || '');
}

// 연속일은 부호로 방향을 표현한다(양수=순매수, 음수=순매도).
function streakText(n) {
  if (n == null || n === 0) return '연속 없음';
  return `${Math.abs(n)}일 연속 순${n > 0 ? '매수' : '매도'}`;
}

export default function SeonjeomCard({ code }) {
  const [data, setData]     = useState(null);
  const [supply, setSupply] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setLoading(true); setError(null);
    Promise.all([
      fetch(`/api/seonjeom/${code}`, { headers: authHeaders() }).then(r => r.json()),
      // 수급은 박세익 60점 이상 종목만 수집한다 — 없는 게 정상인 종목이 많으므로
      // 실패해도 카드 전체를 죽이지 않는다.
      fetch(`/api/supply/${code}`, { headers: authHeaders() }).then(r => r.json()).catch(() => null),
    ])
      .then(([d, s]) => {
        if (!alive) return;
        if (d?.error) throw new Error(d.error);
        setData(d); setSupply(s || null);
      })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);

  if (loading) return <div className="mx-4 mt-3 h-40 bg-surface-900 rounded-2xl animate-pulse" />;
  if (error) {
    return (
      <div className="mx-4 mt-3 bg-surface-900 rounded-2xl p-4">
        <p className="text-sm font-semibold text-white mb-1">저평가 선점 진단</p>
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const park = data.park;
  const zm = data.matrixZone ? zoneMeta(data.matrixZone) : null;
  const rs = data.rs;
  const trend = supply?.trend;

  return (
    <div className="mx-4 mt-3 bg-surface-900 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-white">저평가 선점 진단</p>
          {zm && <span className={`text-[10px] px-1.5 py-0.5 rounded ${zm.cls}`}>{zm.label}</span>}
        </div>
        {data.date && <span className="text-[10px] text-slate-600">{data.date} 스캔 기준</span>}
      </div>

      {data.message && (
        <p className="text-xs text-slate-500 leading-relaxed">{data.message}</p>
      )}

      {park && (
        <>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-xs text-slate-400">박세익 점수</span>
            <span className="text-xs">
              <span className={`font-bold ${parkColor(park.score)}`}>{park.score ?? '-'}</span>
              <span className="text-slate-600"> / 100</span>
              {park.grade && <span className="text-slate-500 ml-1.5">{park.grade}</span>}
            </span>
          </div>
          <Bar score={park.score} />
          {zm?.desc && <p className="text-[10px] text-slate-600 mt-1.5">{zm.desc}</p>}

          {(park.reasons ?? []).length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {park.reasons.map((r, i) => (
                <li key={i} className="text-[11px] text-slate-500 flex gap-1.5">
                  <span className="text-slate-700">·</span>{r}
                </li>
              ))}
            </ul>
          )}
          {/* 게이트 탈락은 감점이 아니라 즉시 배제다. 점수 0과 같은 칸에 두면 안 된다. */}
          {park.gated === 'LOSS_3Y' && (
            <p className="text-[11px] text-red-400 mt-2">3년 내 영업적자 — 선점 후보에서 배제</p>
          )}

          <div className="grid grid-cols-3 gap-2 mt-3">
            <Metric label="고점 대비" value={fmtDrop(data.pctFrom52wHigh)} sub="52주 최고가 기준" />
            <Metric
              label="RS 백분위"
              value={rs?.pct != null ? `${Math.round(rs.pct)}` : '-'}
              sub={rs?.partial ? '일부 구간만 산출' : '직전 스캔 분포 기준'}
            />
            <Metric
              label="RS 지수"
              value={rs?.score != null ? `x${rs.score.toFixed(2)}` : '-'}
              sub="1.00 = 시장과 동일"
            />
          </div>
        </>
      )}

      {/* 오늘 트리거 */}
      <div className="mt-3 pt-3 border-t border-slate-800">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">선점 트리거</span>
          {data.evaluatedAt && <span className="text-[10px] text-slate-600">{data.evaluatedAt} 평가</span>}
        </div>
        {data.trigger ? (
          <>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {(data.trigger.hits ?? []).map(h => {
                const hm = hitMeta(h);
                return <span key={h} className={`text-[10px] px-1.5 py-0.5 rounded ${hm.cls}`}>{hm.label}</span>;
              })}
            </div>
            {(data.trigger.reasons ?? []).length > 0 && (
              <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                {data.trigger.reasons.join(' · ')}
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-slate-600 mt-1">
            {data.evaluatedAt ? '이번 평가에서 미발동' : '선점 평가가 아직 실행되지 않았습니다'}
          </p>
        )}
      </div>

      {/* 수급 추세 */}
      <div className="mt-3 pt-3 border-t border-slate-800">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">수급 추세</span>
          {trend?.latestDate && (
            <span className="text-[10px] text-slate-600">{fmtDay(trend.latestDate)} · {trend.days}일</span>
          )}
        </div>
        {!trend ? (
          <p className="text-[11px] text-slate-600 mt-1">
            {supply?.message || '수급 데이터 없음'}
          </p>
        ) : (
          <>
            <div className="mt-2 space-y-1.5">
              {[
                { label: '외국인', streak: trend.foreignStreak, turn: trend.foreignTurn, accel: trend.accelForeign },
                { label: '기관',   streak: trend.instStreak,    turn: trend.instTurn,    accel: trend.accelInst },
              ].map(row => (
                <div key={row.label} className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400 w-10 shrink-0">{row.label}</span>
                  <span className={`text-[11px] ${row.streak > 0 ? 'text-profit' : row.streak < 0 ? 'text-loss' : 'text-slate-500'}`}>
                    {streakText(row.streak)}
                  </span>
                  {row.turn && (
                    <span className="text-[9px] px-1.5 py-px rounded bg-green-500/20 text-green-400">순매수 전환</span>
                  )}
                  {row.accel != null && (
                    <span className="text-[10px] text-slate-600">
                      20일 평균 대비 {row.accel > 0 ? '유입 가속' : row.accel < 0 ? '유입 둔화' : '변화 없음'}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {/* 원자료 단위(주식 수/금액)가 문서화돼 있지 않다. 단위를 모르는 수를 금액처럼
                보여주는 대신 방향·연속일만 쓴다(analysis.js calcSupplyTrend 주석). */}
            {trend.unitVerified === false && (
              <p className="text-[10px] text-slate-600 mt-2">
                [확인 필요] 순매수 원자료 단위 미확인 — 방향·연속일만 표시합니다.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
