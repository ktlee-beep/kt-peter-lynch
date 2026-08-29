// 2축 매트릭스(박세익 실적축 × 리버모어 주가축)의 화면 표기를 한 곳에 모은다.
// 스크리너·선점 알림·종목 상세가 각자 라벨을 들고 있으면 존 이름 하나 바뀔 때 세 곳이
// 따로 놀고, 그 불일치는 화면을 나란히 놓기 전까지 드러나지 않는다.
//
// 키는 서버 analysis.js matrixZone()이 내보내는 6개가 전부다. 모르는 값이 오면 원문을
// 그대로 보여준다 — 서버가 존을 추가했을 때 조용히 '중립'으로 뭉개지면 안 된다.
export const ZONE_META = {
  SEONJEOM:   { label: '선점',       cls: 'bg-brand-500/20 text-brand-400',  desc: '실적 3년 우상향인데 주가는 아직 소외' },
  BREAKOUT:   { label: '돌파',       cls: 'bg-green-500/20 text-green-400',  desc: '실적 우상향 + 시장이 인식하기 시작' },
  STORY_WARN: { label: '스토리 주의', cls: 'bg-amber-500/20 text-amber-400', desc: '실적 근거 없이 주가만 오르는 중' },
  NEUTRAL:    { label: '중립',       cls: 'bg-slate-700/60 text-slate-300',  desc: '판단 유보 구간' },
  EXCLUDED:   { label: '제외',       cls: 'bg-red-500/20 text-red-400',      desc: '3년 내 영업적자 — 게이트 탈락' },
  NO_DATA:    { label: '미계측',     cls: 'bg-surface-800 text-slate-500',   desc: '3년 실적을 확인하지 못함' },
};

// 스크리너 존 셀렉트의 순서. 서버 ZONES와 같은 순서를 유지한다.
export const ZONE_KEYS = ['SEONJEOM', 'BREAKOUT', 'STORY_WARN', 'NEUTRAL', 'EXCLUDED', 'NO_DATA'];

export function zoneMeta(zone) {
  return ZONE_META[zone] || { label: zone || '-', cls: 'bg-surface-800 text-slate-500', desc: '' };
}

// 박세익 점수대 색. 임계값 80/60/40은 analysis.js calcParkScore의 등급 경계와 같다.
export function parkColor(score) {
  if (score == null) return 'text-slate-500';
  if (score >= 80) return 'text-brand-400';
  if (score >= 60) return 'text-green-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-slate-400';
}

// 등급 문자열은 'A (선점 유력)' 형태다. 좁은 칸에서는 앞의 문자만 쓴다.
export function gradeLetter(grade) {
  if (!grade) return null;
  const m = String(grade).match(/^[A-D]\+?/);
  return m ? m[0] : String(grade);
}

// 고점 대비 낙폭은 음수다. 0과 null을 구분해서 표기한다 —
// '-'는 산출 불가, '0.0%'는 신고가 부근이라는 뜻이라 의미가 전혀 다르다.
export function fmtDrop(pct) {
  return typeof pct === 'number' ? `${pct.toFixed(1)}%` : '-';
}

export function fmtPct(v, digits = 0) {
  return typeof v === 'number' ? v.toFixed(digits) : '-';
}

// 선점 트리거 3종. cron evaluateSeonjeomTriggers가 내보내는 hit 키와 1:1이다.
export const HIT_META = {
  RS_TURN:      { label: 'RS 전환',    cls: 'bg-brand-500/20 text-brand-400' },
  SUPPLY_TURN:  { label: '수급 전환',  cls: 'bg-green-500/20 text-green-400' },
  VOLUME_SURGE: { label: '거래량 급증', cls: 'bg-amber-500/20 text-amber-400' },
};

export function hitMeta(hit) {
  return HIT_META[hit] || { label: hit, cls: 'bg-surface-800 text-slate-400' };
}
