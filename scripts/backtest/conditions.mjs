// 개별 조건 카탈로그 — 각 조건 하나만으로 매수했을 때의 성과를 재기 위한 정의.
//
// 목적: 신호 가중치를 추정이 아니라 측정으로 정한다. 현행 시스템의 가중치(MACD +2,
// 정배열 +1 등)와 이효석 서열(추세 > 지지/저항 > 이동평균 > 거래량 > 캔들)은 둘 다
// 근거가 "그렇게 알려져 있다"이지 이 유니버스에서 검증된 값이 아니다. 여기서 각 조건을
// 단독 전략으로 돌려 대조군(무조건 매수) 대비 초과수익을 재면, 정보량이 없는 조건은
// 사양에서 뺄 수 있고 남은 조건의 가중치도 측정값에 비례해 줄 수 있다.
//
// 반환 규약: true(신호) / false(비신호) / null(판정 불가).
// null은 신호로도 비신호로도 세지 않는다 — 지표가 아직 계산되지 않은 구간을 false로
// 뭉개면 "조건이 거짓이었다"와 "잴 수 없었다"가 섞인다.
//
// 축 분류는 이효석 서열을 따른다. 서열 자체가 맞는지도 측정 대상이다.

const bullish = (s) => s.candlePatterns.some(p => p.signal === 'bullish');
const bearish = (s) => s.candlePatterns.some(p => p.signal === 'bearish');

export const CONDITIONS = {
  // ── A. 추세 (서열 1위) ─────────────────────────────────────────────
  // 현행 시스템에는 추세를 직접 재는 조건이 없다. 이평 배열로 대리하고 있을 뿐이다.
  // 스윙 고점·저점 갱신은 이번에 새로 만든 것이고, 채택 여부는 아래 측정이 정한다.
  'A_추세_상승구조':      s => s.swing.uptrend,
  'A_추세_고점갱신':      s => s.swing.higherHigh,
  'A_추세_저점갱신':      s => s.swing.higherLow,
  'A_추세_60일선위':      s => s.ma60 == null ? null : s.close > s.ma60,
  'A_추세_정배열':        s => (s.ma5 == null || s.ma20 == null || s.ma60 == null) ? null
                                : (s.ma5 > s.ma20 && s.ma20 > s.ma60),
  'A_추세_ADX강세':       s => s.adx.adx == null ? null : (s.adx.adx >= 25 && s.adx.direction === 'up'),

  // ── B. 지지/저항 (서열 2위) ────────────────────────────────────────
  'B_저항_박스상단돌파':  s => s.boxBreak,
  'B_저항_박스하단이탈':  s => s.boxBreakDown,
  'B_저항_52주신고가권':  s => s.near52wHigh,
  'B_저항_저항선돌파':    s => s.prevLevels.resistance == null ? null : s.close > s.prevLevels.resistance,
  'B_지지_지지선근접':    s => s.levels.support == null ? null
                                : (s.close > s.levels.support && s.close <= s.levels.support * 1.03),
  'B_되돌림_얕음38':      s => s.retrace == null ? null : s.retrace <= 0.382,
  'B_되돌림_깊음62':      s => s.retrace == null ? null : s.retrace >= 0.618,

  // ── C. 이동평균 (서열 3위) — 현행 시스템이 가장 크게 가중하는 축 ──
  // MACD골든은 "상태"이고 MACD당일골든은 "사건"이다. 현행 시스템(cron.js:352)은 상태에
  // +2를 주는데, 상태는 수십 봉 이어지므로 사실상 상시 가점이다. 둘을 나눠 잰다.
  'C_이평_MACD골든':      s => s.macdCross === 'golden',
  'C_이평_MACD당일골든':  s => s.macdFreshGolden,
  // 'MACD히스토그램 > 0'은 넣었다가 뺐다. lastCross==='golden'과 완전히 같은 값이 나온다
  // — 마지막 교차의 방향이 곧 히스토그램의 부호이기 때문이다. 같은 조건을 두 번 세면
  // 다중비교만 늘어난다.
  'C_이평_20일선위':      s => s.ma20 == null ? null : s.close > s.ma20,
  'C_이평_5선20선상회':   s => (s.ma5 == null || s.ma20 == null) ? null : s.ma5 > s.ma20,
  'C_이평_일목구름위':    s => s.ichimoku.priceVsCloud == null ? null : s.ichimoku.priceVsCloud === 'above',
  'C_이평_전환기준골든':  s => s.ichimoku.tkKjCross === 'golden',

  // ── D. 거래량 (서열 4위) — 이효석은 방향성 없는 확신 배율로 본다 ──
  // 급증 단독 / 급증+양봉 / 급증+음봉을 따로 재서 "방향성이 없다"는 주장 자체를 검증한다.
  'D_거래_급증2배':       s => s.volRatio == null ? null : s.volRatio >= 2,
  'D_거래_급증양봉':      s => s.volRatio == null ? null : (s.volRatio >= 2 && s.isGreen),
  'D_거래_급증음봉':      s => s.volRatio == null ? null : (s.volRatio >= 2 && !s.isGreen),
  'D_거래_급증저점권':    s => (s.volRatio == null || s.location == null) ? null
                                : (s.volRatio >= 2 && s.location <= 0.35),
  'D_거래_OBV매집':       s => s.obv.trend === 'accumulating',
  'D_거래_감소0.7':       s => s.volRatio == null ? null : s.volRatio < 0.7,

  // ── E. 캔들 (서열 5위) — 위치 게이트 유무를 나눠 잰다 ──────────────
  // 같은 망치형이라도 바닥권이면 반등, 고점권이면 경고다. 현행 코드는 위치를 보지 않는다.
  'E_캔들_상승패턴':      s => bullish(s),
  'E_캔들_상승_저점권':   s => s.location == null ? null : (bullish(s) && s.location <= 0.35),
  'E_캔들_상승_고점권':   s => s.location == null ? null : (bullish(s) && s.location >= 0.65),
  'E_캔들_하락패턴':      s => bearish(s),

  // ── F. 오실레이터 — 현행 combinedSignal이 쓰는 조건들 ──────────────
  'F_RSI_과매도30':       s => s.rsi < 30,
  'F_RSI_35미만':         s => s.rsi < 35,
  'F_RSI_중립45_65':      s => s.rsi >= 45 && s.rsi <= 65,
  'F_BB_하단20':          s => s.bb == null ? null : s.bb.percentB < 20,
  'F_BB_상단80':          s => s.bb == null ? null : s.bb.percentB > 80,
  'F_스토캐_과매도':      s => s.stochastic.signal === 'oversold',
  'F_스토캐_상향교차':    s => s.stochastic.signal === 'bullish_cross',
  'F_윌리엄스_과매도':    s => s.williamsR.signal === 'oversold',
  'F_RSI다이버전스':      s => s.rsiDiv.bullish,
};

// 축 라벨 — 리포트 그룹핑용.
export const AXIS = { A: '추세', B: '지지저항', C: '이동평균', D: '거래량', E: '캔들', F: '오실레이터' };
