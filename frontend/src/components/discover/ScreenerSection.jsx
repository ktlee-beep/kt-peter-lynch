import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders, useAuth } from '../../contexts/AuthContext';
import { zoneMeta, ZONE_KEYS, parkColor, gradeLetter } from '../../lib/matrix';

const PRESETS = [
  // '선점'은 서버 preset 키가 'park'다(server.js /api/screener). 라벨만 한국어로 바꾼다.
  { key: 'park',   label: '선점',      desc: '박세익 60+ · 선점 구간' },
  { key: 'lynch',  label: '피터 린치', desc: 'PER≤20 · ROE≥10 · 부채≤150%' },
  { key: 'value',  label: '가치주',    desc: 'PER≤10 · PBR≤1' },
  { key: 'growth', label: '성장주',    desc: 'ROE≥15 · 린치점수≥60' },
];

const SORTS = [
  { key: 'lynch_score', label: '린치점수' },
  { key: 'combined',    label: '종합점수' },
  { key: 'park',        label: '박세익 점수' },
  { key: 'rs',          label: 'RS 높은순' },
  { key: 'drop',        label: '고점대비 낙폭순' },
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

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-slate-400">{label}</span>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value || null)}
        className="bg-surface-900 text-[11px] text-slate-300 rounded-lg px-2 py-1 outline-none border border-slate-800"
      >
        <option value="">제한없음</option>
        {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </div>
  );
}

function ResultItem({ item }) {
  const navigate = useNavigate();
  const pos = item.changeRate > 0, neg = item.changeRate < 0;
  const fmtPct = (v) => v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  const zm = item.matrixZone ? zoneMeta(item.matrixZone) : null;
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
        <div className="flex gap-2 mt-0.5 flex-wrap items-center">
          {item.sector && (
            <span className="text-[9px] px-1.5 py-px rounded bg-slate-800 text-slate-400">{item.sector}</span>
          )}
          {item.per  != null && <span className="text-[10px] text-slate-500">PER {item.per.toFixed(1)}배</span>}
          {item.pbr  != null && <span className="text-[10px] text-slate-500">PBR {item.pbr.toFixed(2)}배</span>}
          {item.roe  != null && <span className="text-[10px] text-slate-500">ROE {item.roe.toFixed(1)}%</span>}
          {/* 저평가 가점의 비교 대상. 이게 없으면 박세익 점수에서 저평가 축이 빠진 것이라
              같은 점수라도 의미가 다르다 — 화면에서 구분되지 않으면 오독한다. */}
          {item.perBasisMedian != null
            ? <span className="text-[10px] text-slate-600">기준 {item.perBasis} {item.perBasisMedian.toFixed(1)}</span>
            : item.parkScore != null && <span className="text-[10px] text-amber-600/70">저평가 기준 없음</span>}
        </div>
        {/* 박세익 축 — 점수·존·낙폭. 셋 다 없는 종목(구 스캔 행)에서는 줄 자체를 만들지 않는다. */}
        {(item.parkScore != null || zm || typeof item.pctFrom52wHigh === 'number') && (
          <div className="flex gap-1.5 mt-1 items-center flex-wrap">
            {zm && <span className={`text-[9px] px-1.5 py-px rounded ${zm.cls}`}>{zm.label}</span>}
            {item.parkScore != null && (
              <span className={`text-[10px] font-medium ${parkColor(item.parkScore)}`}>
                박세익 {Math.round(item.parkScore)}
                {item.parkGrade ? ` ${gradeLetter(item.parkGrade)}` : ''}
              </span>
            )}
            {typeof item.pctFrom52wHigh === 'number' && (
              <span className="text-[10px] text-slate-500">고점대비 {item.pctFrom52wHigh.toFixed(1)}%</span>
            )}
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-bold text-white">{item.close?.toLocaleString('ko-KR')}원</div>
        <div className={`text-xs ${pos ? 'text-profit' : neg ? 'text-loss' : 'text-slate-500'}`}>
          {fmtPct(item.changeRate)}
        </div>
        <div className="text-[10px] text-brand-400 mt-0.5">린치 {Math.round(item.lynchScore ?? 0)}</div>
        {/* RS는 백분위다. partial(일부 창만 산출)은 별표로 구분한다 — 상장 1년 미만 종목의
            RS를 12개월 종목과 같은 숫자로 읽으면 안 된다. */}
        {item.rsPct != null && (
          <div className="text-[10px] text-slate-500">RS {Math.round(item.rsPct)}{item.rsPartial ? '*' : ''}</div>
        )}
      </div>
    </button>
  );
}

export default function ScreenerSection() {
  const { user } = useAuth();
  const isMaster = user?.role === 'master';

  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState(null);
  const [perMax,  setPerMax]  = useState(null);
  const [pbrMax,  setPbrMax]  = useState(null);
  const [roeMin,  setRoeMin]  = useState(null);
  const [debtMax, setDebtMax] = useState(null);
  const [lynchMin, setLynchMin] = useState(null);
  const [parkMin, setParkMin] = useState(null);
  const [zone,    setZone]    = useState(null);
  const [rsMin,   setRsMin]   = useState(null);
  const [sector,  setSector]  = useState(null);
  // 허용 목록은 서버가 응답에 실어 보낸다(server.js sectorOptions) — 클라이언트가 복제하면
  // 서버의 400 검증과 어긋나는 날 "고를 수는 있는데 400"이 된다.
  const [sectorOptions, setSectorOptions] = useState([]);
  const [sectorSummary, setSectorSummary] = useState([]);
  const [sortBy,  setSortBy]  = useState('lynch_score');
  const [page,    setPage]    = useState(1);
  const [results, setResults] = useState(null);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  // 서버가 돌려주는 안내문을 그대로 담는다. "스캔 데이터 없음"과 "박세익 미계측"은
  // 원인도 대응도 다른데, 불리언 하나로 받으면 화면에서 같은 문장이 된다.
  const [notice,  setNotice]  = useState(null);
  const [scanStatus, setScanStatus] = useState(null);
  const [scanTriggerLoading, setScanTriggerLoading] = useState(false);

  useEffect(() => {
    fetch('/api/scan/status', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setScanStatus(d.lastBatch || null))
      .catch(() => {});
  }, []);

  const triggerScan = async () => {
    setScanTriggerLoading(true);
    try {
      const r = await fetch('/api/scan/trigger-admin', {
        method: 'POST',
        headers: { ...authHeaders() },
      });
      const d = await r.json();
      if (r.ok) {
        setScanStatus(prev => ({ ...prev, status: 'running', started_at: new Date().toISOString() }));
        alert('스캔이 시작됐습니다. 완료까지 약 3~5분 소요됩니다. 스크리닝 버튼을 다시 눌러주세요.');
      } else {
        alert(d.error || '스캔 시작 실패');
      }
    } catch {
      alert('스캔 시작 요청 실패');
    } finally {
      setScanTriggerLoading(false);
    }
  };

  // 페이지 진입 시 린치 프리셋으로 자동 실행
  useEffect(() => { runScreener(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 슬라이더 값은 프리셋이 켜져 있는 동안 표시용이다(서버가 preset을 받으면 개별 필터를
  // 무시한다). 그래도 서버 정의와 같은 값을 넣어둔다 — 프리셋을 끄는 순간 화면에 보이던
  // 조건이 그대로 이어져야 "왜 결과가 바뀌지"가 생기지 않는다.
  const applyPreset = (key) => {
    setPreset(key);
    setParkMin(null); setZone(null); setRsMin(null);
    if (key === 'lynch')  { setPerMax(20);  setPbrMax(3);   setRoeMin(10);  setDebtMax(150); setLynchMin(50); }
    if (key === 'value')  { setPerMax(10);  setPbrMax(1);   setRoeMin(8);   setDebtMax(200); setLynchMin(null); }
    if (key === 'growth') { setPerMax(40);  setPbrMax(5);   setRoeMin(15);  setDebtMax(100); setLynchMin(60); }
    // 선점은 밸류에이션 상한을 걸지 않는다(server.js preset 'park' 주석). 박세익 스코어가
    // 이미 저평가를 채점하므로 PER/PBR을 겹쳐 걸면 실적이 좋아 PER이 오른 종목부터 잘린다.
    if (key === 'park') {
      setPerMax(null); setPbrMax(null); setRoeMin(null); setDebtMax(null); setLynchMin(null);
      setParkMin(60); setZone('SEONJEOM'); setSortBy('park');
    }
  };

  const resetFilters = () => {
    setPreset(null);
    setPerMax(null); setPbrMax(null); setRoeMin(null); setDebtMax(null); setLynchMin(null);
    setParkMin(null); setZone(null); setRsMin(null); setSector(null);
  };

  const runScreener = useCallback(async (pg = 1) => {
    setLoading(true); setError(null); setNotice(null);
    const params = new URLSearchParams({ sort: sortBy, page: pg, limit: 20 });
    // 섹터는 프리셋과 함께 걸린다(server.js — 프리셋은 점수 기준, 섹터는 모집단).
    if (sector != null) params.set('sector', sector);
    if (preset) { params.set('preset', preset); }
    else {
      if (perMax   != null) params.set('per_max',   perMax);
      if (pbrMax   != null) params.set('pbr_max',   pbrMax);
      if (roeMin   != null) params.set('roe_min',   roeMin);
      if (debtMax  != null) params.set('debt_max',  debtMax);
      if (lynchMin != null) params.set('lynch_min', lynchMin);
      if (parkMin  != null) params.set('park_min',  parkMin);
      if (zone     != null) params.set('zone',      zone);
      if (rsMin    != null) params.set('rs_min',    rsMin);
    }
    try {
      const r = await fetch(`/api/screener?${params}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '스크리너 오류');
      setResults(d.items ?? []);
      setTotal(d.total ?? 0);
      setPage(pg);
      setSectorSummary(d.sectorSummary ?? []);
      if (Array.isArray(d.sectorOptions) && d.sectorOptions.length) setSectorOptions(d.sectorOptions);
      if (d.message) setNotice(d.message);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [preset, perMax, pbrMax, roeMin, debtMax, lynchMin, parkMin, zone, rsMin, sector, sortBy]);

  const LIMIT = 20;

  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-900 border-y border-slate-800"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">가치투자 스크리너</span>
          {results !== null && !notice && <span className="text-[11px] text-brand-400">{total}개 종목</span>}
          {scanStatus?.analysis_date && !open && (
            <span className="text-[10px] text-slate-600">
              {new Date(scanStatus.started_at).toLocaleDateString('ko-KR')} 스캔
            </span>
          )}
        </div>
        <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="bg-surface-950">
          {/* Presets */}
          <div className="px-4 pt-3 pb-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-slate-600">프리셋</p>
              {preset && (
                <button onClick={resetFilters} className="text-[10px] text-slate-500">초기화</button>
              )}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {PRESETS.map(p => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className={`py-2 rounded-xl text-[11px] font-medium transition-colors ${
                    preset === p.key ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30' : 'bg-surface-900 text-slate-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset && (
              <p className="text-[10px] text-slate-600 mt-1.5">
                {PRESETS.find(p => p.key === preset)?.desc}
              </p>
            )}
          </div>

          {/* Filters */}
          <div className="px-4 pb-3 space-y-3">
            <FilterSlider   label="PER 최대"    value={perMax}   onChange={setPerMax}   min={0} max={100} step={1} unit="배" />
            <FilterSlider   label="PBR 최대"    value={pbrMax}   onChange={setPbrMax}   min={0} max={10}  step={0.5} unit="배" />
            <FilterSliderMin label="ROE 최소"   value={roeMin}   onChange={setRoeMin}   min={0} max={50}  step={1} unit="%" />
            <FilterSlider   label="부채비율 최대" value={debtMax} onChange={setDebtMax} min={0} max={500} step={10} unit="%" />
            <FilterSliderMin label="린치점수 최소" value={lynchMin} onChange={setLynchMin} min={0} max={100} step={5} />

            {/* 저평가 선점 축 — 박세익 스코어·매트릭스 존·RS 백분위 */}
            <div className="pt-2 border-t border-slate-800/60 space-y-3">
              <p className="text-[10px] text-slate-600">저평가 선점</p>
              <FilterSliderMin label="박세익 점수 최소" value={parkMin} onChange={setParkMin} min={0} max={100} step={5} />
              <FilterSliderMin label="RS 백분위 최소"   value={rsMin}   onChange={setRsMin}   min={0} max={100} step={5} />
              <FilterSelect
                label="매트릭스 존"
                value={zone}
                onChange={setZone}
                options={ZONE_KEYS.map(k => ({ key: k, label: zoneMeta(k).label }))}
              />
              {zone && <p className="text-[10px] text-slate-600">{zoneMeta(zone).desc}</p>}
              {/* 섹터는 프리셋과 무관하게 걸린다 — 아래 안내문의 예외라 바로 옆에 둔다. */}
              <FilterSelect
                label="섹터"
                value={sector}
                onChange={setSector}
                options={sectorOptions.map(s => ({ key: s, label: s }))}
              />
              {preset && (
                <p className="text-[10px] text-amber-500/80">
                  프리셋이 켜져 있어 개별 필터는 적용되지 않습니다(섹터는 예외 — 함께 적용됩니다).
                  직접 조합하려면 초기화하세요.
                </p>
              )}
            </div>
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
          {notice && (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-slate-400 leading-relaxed">{notice}</p>
              <p className="text-xs text-slate-600 mt-1">
                {scanStatus
                  ? `마지막 스캔: ${new Date(scanStatus.started_at).toLocaleDateString('ko-KR')} (${scanStatus.status})`
                  : '스캔 이력 없음'}
              </p>
              {isMaster && (
                <button
                  onClick={triggerScan}
                  disabled={scanTriggerLoading}
                  className="mt-3 px-4 py-2 bg-brand-500/20 text-brand-400 text-xs font-medium rounded-xl border border-brand-500/30 disabled:opacity-50"
                >
                  {scanTriggerLoading ? '요청 중...' : '지금 스캔 실행'}
                </button>
              )}
            </div>
          )}
          {results !== null && !notice && (
            <>
              {results.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-slate-500">조건에 맞는 종목이 없습니다</p>
                  <p className="text-xs text-slate-600 mt-1">
                    재무 데이터가 갱신되지 않았을 수 있습니다. 스캔을 다시 실행해보세요.
                  </p>
                  {isMaster && (
                    <button
                      onClick={triggerScan}
                      disabled={scanTriggerLoading}
                      className="mt-3 px-4 py-2 bg-brand-500/20 text-brand-400 text-xs font-medium rounded-xl border border-brand-500/30 disabled:opacity-50"
                    >
                      {scanTriggerLoading ? '요청 중...' : '지금 스캔 실행'}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {/* "어느 섹터가 저평가인가"는 종목을 20개씩 넘겨보며 답할 질문이 아니다.
                      필터가 걸린 전체 결과 기준이라 현재 페이지에 안 보이는 종목도 포함된다. */}
                  {sectorSummary.length > 0 && (
                    <div className="px-4 pb-3 border-b border-slate-800/50">
                      <p className="text-[10px] text-slate-500 mb-1.5">섹터별 분포 — 선점 종목 순</p>
                      <div className="space-y-1">
                        {sectorSummary.slice(0, 6).map(s => (
                          <div key={s.sector} className="flex items-center gap-2 text-[10px]">
                            <span className="w-20 shrink-0 truncate text-slate-300">{s.sector}</span>
                            <span className="text-slate-500 shrink-0">{s.count}종목</span>
                            {s.seonjeom > 0 && <span className="text-brand-400 shrink-0">선점 {s.seonjeom}</span>}
                            {/* 채점된 종목이 전체보다 적으면 중앙값의 모수를 함께 밝힌다 —
                                적자·이력부족 게이트로 빠진 종목은 점수 자체가 없다. */}
                            {s.medPark != null && (
                              <span className="text-slate-500 shrink-0">
                                중앙 {s.medPark.toFixed(0)}점{s.scored < s.count ? ` (${s.scored}/${s.count})` : ''}
                              </span>
                            )}
                            {s.medPer != null && <span className="text-slate-600 shrink-0">PER {s.medPer.toFixed(1)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="divide-y divide-slate-800/50">
                    {results.map(item => <ResultItem key={item.code} item={item} />)}
                  </div>
                  {results.some(i => i.rsPartial) && (
                    <p className="px-4 pt-2 text-[10px] text-slate-600">
                      * 상장 기간이 짧아 20·60·120일 중 일부 구간만으로 산출한 RS입니다.
                    </p>
                  )}
                </>
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
