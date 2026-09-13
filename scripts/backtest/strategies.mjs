// 전략 레지스트리 — 스냅샷 하나를 받아 'BUY' | 'SELL' | 'HOLD'를 낸다.
//
// harness.mjs(전략 비교)와 measure-composite.mjs(신설 엔진 후보 검증)가 같은 정의를
// 쓴다. 현행 엔진 재현본이 두 벌 존재하면 어느 쪽을 측정했는지 알 수 없게 된다.
import { combinedSignal } from '../../analysis.js';
import { PSCORE_NEUTRAL } from './engine.mjs';

export const STRATEGIES = {
  // 현행 온디맨드 신호 엔진. analysis.js:164 combinedSignal을 실제로 호출한다.
  // pScore(박세익 축)는 백테스트로 재현할 수 없다 — 과거 시점의 재무제표를 복원하지
  // 못하므로 현재 재무를 과거에 적용하면 look-ahead가 된다. 그래서 중립값으로 고정하고
  // 가격·거래량 축의 변화만 비교한다.
  combined_v1: {
    label: '현행 combinedSignal (12조건 flat, BUY>=4)',
    run: (s) => combinedSignal(
      s.lScore, PSCORE_NEUTRAL, s.macdCross, s.bb,
      {
        ichimoku: s.ichimoku, stochastic: s.stochastic, obv: s.obv,
        candlePatterns: s.candlePatterns, rsiDivergence: s.rsiDiv, williamsR: s.williamsR,
      },
      s.adx,
    ).signal,
  },

  // 현행 야간 스캔 엔진의 재현본. cron.js:346-371이 인라인이라 import할 수 없어 옮겨
  // 적었다. 사용자가 스크리너에서 실제로 보는 것은 이쪽이므로 베이스라인에 반드시 필요하다.
  //
  // 경고: 이것은 복제본이다. cron.js의 조건이 바뀌면 여기도 같이 바꿔야 하고, 그러지
  // 않으면 조용히 다른 것을 측정하게 된다. cron 쪽 로직을 함수로 추출해 양쪽이 같은
  // 코드를 부르도록 바꾸는 것이 정답이며, 그 전까지는 임시 조치다.
  cron_scan_v1: {
    label: '현행 크론 스캔 재현 (7조건, BUY>=3)',
    run: (s) => {
      let buy = 0, sell = 0;
      if ((s.rsi >= 50 && s.rsi <= 70) || s.rsi < 35) buy++;
      if (s.rsi > 75) sell++;
      if (s.macdCross === 'golden') buy += 2;
      if (s.macdCross === 'dead') sell += 2;
      // cron.js:357은 정배열에 명시적 null 가드가 있다. 그 동작을 그대로 옮긴다.
      if (s.ma5 != null && s.ma20 != null && s.ma60 != null && s.ma5 > s.ma20 && s.ma20 > s.ma60) buy += 2;
      if (s.ma5 != null && s.ma20 != null && s.ma5 < s.ma20) sell++;
      if (s.bb && s.bb.percentB < 15) buy++;
      if (s.bb && s.bb.percentB > 88) sell++;
      if (s.volRatio != null && s.volRatio >= 2.0) buy++;
      if (s.near52wHigh) buy++;
      // cron.js:369-371은 else if가 아니다. 매수·매도가 동시에 3점을 넘으면 매도가
      // 매수를 덮어쓴다. 그 동작까지 재현한다.
      let sig = 'HOLD';
      if (buy >= 3) sig = 'BUY';
      if (sell >= 3) sig = 'SELL';
      return sig;
    },
  },

  // 대조군. 신호와 무관하게 매일 진입했을 때의 수익이다. 어떤 전략이든 이것을 못 이기면
  // 그 신호는 정보가 없는 것이다. 백테스트에서 가장 자주 빠지는 기준선.
  always_buy: {
    label: '대조군 — 무조건 매수 (신호 없음)',
    run: () => 'BUY',
  },
};
