// 풀백 셋업(마틴 룩 방식의 일봉 번역) 측정.
//
// 출처
//   [V]  유튜브 쇼츠 aZDVXXmgZWY (부자컨닝, 2026-10-08) — 측정의 계기. 요약본이라 규칙 근거로는 쓰지 않는다.
//   [S8] TraderLion 인터뷰 "+969% Return in 1 Year: The Pullback Strategy of a Trading Champion"
//        (2026-01-31, youtube VKNEJA5r8zw) — 본인 발언. 아래 규칙의 타임스탬프는 이 영상 자동자막 기준.
//   [S6] Trading Resource Hub 게스트 포스트 (2025-02-01) — 본인 기고.
//   USIC 2025 주식부문 +969.8% 1위는 대회 공식 순위표(financial-competitions.com, 2026-01-24)로 확인.
//
// 본인 발언에서 가져온 규칙
//   - 스윙 트레이더·추세추종자이고 분봉은 진입 타이밍용이다 [S8 00:13:15]. 그래서 일봉 번역이 성립한다.
//   - 상승 중인 9·21 EMA까지 밀린 눌림을 노린다 [S8 1:57:23, 00:26:01].
//   - 진입은 직전 봉 고점 돌파 [S8 1:57:23]. 손절은 60~70%가 당일 저가, 나머지는 돌파봉·직전 봉 저가 [S8 1:58:18].
//   - 손절폭은 ADR의 50% 이하, 최대 5% [S8 00:18:13].
//   - 3R·5R에서 강세에 15%씩 판다 — 엄격한 규칙은 아니라고 본인이 말함 [S8 00:01:06, 2:28:57].
//   - 나머지는 9 EMA 아래 첫 종가에 전량 청산 [S8 2:29:17, S6].
//   - 거래당 위험 계좌의 약 0.5% [S8 00:16:09] — 고정 위험 사이징이면 성과는 R배수 기대값으로 정해진다.
//   - 2025년 209승 731패, 승률 약 22% [S8 00:20:20].
//
// 일봉 번역 (장 마감 후 스캔 cron.js와 같은 시점에 판정 가능해야 한다)
//   셋업봉 t : 9·21 EMA가 전일까지 상승 중이었고(t-1 > t-2), t봉 저가가 9 EMA 이하로 밀린 날.
//             기울기를 당일(t)로 판정하면 수식상 종가 > 전일 9 EMA인 봉만 남아, 9 EMA 아래에서
//             마감하는 21 EMA 눌림이 통째로 빠진다. 그래서 전일까지로 판정한다.
//   진입 t+1 : t봉 고가보다 한 호가 위에서 매수(역지정가). 갭 상승이면 시가 체결. 닿지 않으면 취소.
//   손절     : t봉 저가보다 한 호가 아래 — "직전 봉 저가" 쪽 번역. 당일 저가(60~70% 쪽)는 일봉으로
//             재현할 수 없다.
//   1R       : 진입가 - 손절가. R배수는 비용을 뺀 순값이다. SPEC 청산의 1R은 진입가의 8%다.
//
// 청산 규칙 세 가지를 같은 진입에 붙인다.
//   SPEC  : SPEC-신호엔진-v2 4-2 — 20거래일 보유, 진입가 -8% 손절. 저장소 현행 기준.
//   LUK20 : 셋업봉 저가 손절 + 3R·5R 15% 분할, 나머지 20거래일 종가. 9 EMA 청산을 뺀 대조용.
//   LUK   : 셋업봉 저가 손절 + 3R·5R 15% 분할, 나머지는 진입 다음 날부터 9 EMA 아래 첫 종가.
//   LUKADR: LUK과 같되 분할이 진입가+3×ADR 15% 한 번뿐. 출력 "3R%" 열은 이 청산에서 3×ADR 도달률, "5R%"는 해당 없음(-).
//           LUK과의 차이는 첫 분할 위치와 5R 분할 제거 두 가지가 섞여 있다.
//
// 대조군은 청산마다 따로 둔다. 청산 규칙마다 평균 보유일이 4일에서 14일까지 달라서, 20일 고정
// 보유 대조군과 비교하면 국면(하락장 out 구간 등)에 따라 초과수익의 부호가 바뀐다.
//   무조건 : 필터 없이 모든 날 다음날 시가 진입, 손절은 t봉 저가 한 호가 아래, 청산 세 가지 동일 적용.
//
// [가정] — 출처에 없어서 정한 값. 결과를 보고 바꾸지 않는다(PLAN-차트TA-접목검토 8-2).
//   - ADR 기간 20일(룩은 기간을 밝히지 않음).
//   - 9 EMA 청산은 진입 다음 날부터 적용(진입 당일은 손절만).
//   - LUK 최대 보유 60거래일(측정을 끝내기 위한 상한). 모든 변형이 같은 표본을 쓰도록
//     셋업일 t는 데이터 끝에서 60봉 앞까지만 센다.
//   - 호가단위는 2023-01-25 통합 호가가격단위 표를 전 기간에 적용 [확인 필요: 2023년 이전 봉은 실제 단위와 다를 수 있다].
//
// 표본에서 빼는 것
//   - 스팩(종목명 '스팩'): 가격이 거의 움직이지 않아 손절폭이 0.2%대로 좁고, R배수 꼬리를 지배한다.
//   - 거래정지 봉: 캐시에 시가·고가·저가 0, 거래량 0, 종가는 전일 종가로 들어 있다. 셋업봉이나
//     진입봉이 정지봉이면 건너뛴다. 보유 중의 정지봉은 종가 한 점짜리 봉으로 바꾼다.
//   - 미조정 주가 급변: 전일 종가 대비 시가나 종가가 ±31%를 넘는 봉은 가격제한폭(±30%) 밖이므로
//     액면분할 등 미조정 흔적이다. 셋업 앞 60봉~청산 상한까지 이런 봉이 있으면 뺀다.
//
// in/out 분할은 종목별 인덱스가 아니라 공통 날짜로 한다 — 표본 날짜의 70% 지점.
//
// 일봉으로는 같은 날 안의 순서를 알 수 없다. 같은 날 손절선과 목표가가 모두 닿으면 손절이
// 먼저라고 본다 — SPEC-신호엔진-v2 rev.1-c "STOP이 이긴다"와 같은 보수적 처리다. 진입일 당일
// 저가가 손절선을 건드린 경우도 손절로 센다(돌파 전에 찍힌 저가일 수 있지만 구분할 수 없다).
// 그래서 LUK 계열의 승률과 R은 과소추정 쪽으로 기운다.
//
// 해석 시 감안할 것은 measure-conditions.mjs 상단 주석과 같다(다중비교, 표본 비독립, 생존편향,
// 재무축 부재). 하나 더 — 원본은 ADR 5% 이상인 미국 모멘텀 주도주를 장중에 골라 매매했다.
// 이 캐시는 국내 종목이고 종목 선정 단계(테마 주도주·갭 스캔)가 없다. 여기 숫자를
// 원본 방법의 성패로 읽지 않는다. 재는 것은 "이 번역이 이 유니버스에서 정보가 있는가"다.
//
// 사용:
//   node scripts/backtest/measure-pullback.mjs
//   node scripts/backtest/measure-pullback.mjs --window 600 --out pullback-v1.json
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, COST, r2, median } from './engine.mjs';
import { calcEMA } from '../../analysis.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WINDOW  = parseInt(argOf('window', '600'), 10);
const STOCKS  = parseInt(argOf('stocks', '0'), 10);
const OUT     = argOf('out', '');
const SPLIT   = 0.7;

// 출처 값
const EMA_FAST = 9, EMA_SLOW = 21;
const PARTIALS = [{ r: 3, frac: 0.15 }, { r: 5, frac: 0.15 }];
const STOP_MAX_PCT = 5, STOP_MAX_ADR = 0.5;
// 저장소 값 (SPEC-신호엔진-v2 4-2)
const HORIZON = 20, SPEC_STOP = 0.08;
// [가정]
const ADR_LEN = 20, MAX_HOLD = 60;
// 데이터 정제
const JUMP = 0.31, JUMP_GUARD = 60, TRIM = 0.01;

// KRX 호가가격단위(2023-01-25 통합) [확인 필요]
function tick(p) {
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}

// 분해 측정용 변형. 전체 셋업의 성과가 어느 부품에서 오는지 가른다.
//   무조건          : 필터 없음 — 청산별 대조군
//   추세만          : 9·21 EMA 상승일, 다음날 시가 진입 — 셋업이 넘어서야 할 기준선
//   풀백_돌파없음   : + 9 EMA 터치, 다음날 시가 진입 — 돌파 조건의 몫을 가른다
//   풀백_고가돌파   : + 다음날 t봉 고가 돌파 시 진입 — 진입 규칙까지 포함한 번역
//   풀백_돌파_손절폭: + 손절폭 ≤ min(5%, ADR×50%) — 룩의 손절폭 규칙까지 포함한 전체 번역
//   무조건_ADR5     : ADR% >= 5 인 날만의 대조군 — ADR 필터 변형은 유니버스가 달라 이쪽과 비교한다
//   풀백_고가돌파_ADR5: 풀백_고가돌파 + ADR% >= 5 (발표자료의 ADR>5% 종목 선정, 본인이 "not a hard rule"이라 밝힘)
const CONTROL = '무조건';
const CONTROL_ADR = '무조건_ADR5';
const VARIANTS = [CONTROL, '추세만', '풀백_돌파없음', '풀백_고가돌파', '풀백_돌파_손절폭', CONTROL_ADR, '풀백_고가돌파_ADR5'];
const BREAKOUT = new Set(['풀백_고가돌파', '풀백_돌파_손절폭', '풀백_고가돌파_ADR5']);
const ADR5 = new Set([CONTROL_ADR, '풀백_고가돌파_ADR5']);
const isControl = (v) => v === CONTROL || v === CONTROL_ADR;
const controlOf = (v) => ADR5.has(v) ? CONTROL_ADR : CONTROL;
// LUKADR: LUK과 같되 첫 분할을 3R이 아니라 진입가 + 3 x ADR(%) 이동에 둔다 (본인 트윗 R146 1886788327829070119,
// 2025-02-04 "first partial when the stock moves >3*ADR"). 분할 비율 15%는 LUK과 맞춘 [가정], 5R 분할은 없다.
const EXITS = ['SPEC', 'LUK20', 'LUK', 'LUKADR'];
const ADR_MIN = 5, ADR_MULT = 3, ADR_FRAC = 0.15;

// ── 청산 시뮬레이션 ───────────────────────────────────────────────────
// entryIdx 봉에서 entry에 샀다. 반환: ret(비용 차감 %), rMult(비용 차감 R배수), hold(보유 봉 수).
function simSpec(st, entryIdx, entry) {
  const { opens, lows, closes } = st;
  const stop = entry * (1 - SPEC_STOP);
  const last = entryIdx + HORIZON - 1;
  let exitPx = closes[last], hold = HORIZON;
  for (let k = entryIdx; k <= last; k++) {
    if (k > entryIdx && opens[k] <= stop) { exitPx = opens[k]; hold = k - entryIdx + 1; break; }
    if (lows[k] <= stop) { exitPx = stop; hold = k - entryIdx + 1; break; }
  }
  return finish(entry, entry * SPEC_STOP, exitPx - entry, hold, false, false);
}

// trail=false: 나머지를 HORIZON 종가에 청산. trail=true: 9 EMA 아래 첫 종가(최대 MAX_HOLD).
// targets: [{px, frac}] 분할 목표. 생략하면 PARTIALS(R배수)로 만든다.
function simLuk(st, ema9, entryIdx, entry, stop, trail, targets = null) {
  const { opens, highs, lows, closes } = st;
  const R = entry - stop;
  const last = entryIdx + (trail ? MAX_HOLD : HORIZON) - 1;

  let remain = 1, pnl = 0;   // pnl: 진입가 대비 손익(가격 단위) × 비중의 합
  const tg = targets ?? PARTIALS.map(p => ({ px: entry + p.r * R, frac: p.frac }));
  const taken = tg.map(() => false);
  let k = entryIdx;
  for (; k <= last; k++) {
    // 시가 갭: 진입일 이후 시가가 손절선 아래면 시가에 털린다(손절선보다 나쁜 체결).
    if (k > entryIdx && opens[k] <= stop) { pnl += (opens[k] - entry) * remain; remain = 0; break; }
    // 시가가 이미 목표가 위면 그 목표는 시가에 먼저 체결된 것이다.
    if (k > entryIdx) {
      tg.forEach((p, j) => {
        if (!taken[j] && opens[k] >= p.px) { pnl += (opens[k] - entry) * p.frac; remain -= p.frac; taken[j] = true; }
      });
    }
    // 장중: 손절 먼저(보수적).
    if (lows[k] <= stop) { pnl += (stop - entry) * remain; remain = 0; break; }
    tg.forEach((p, j) => {
      if (!taken[j] && highs[k] >= p.px) { pnl += (p.px - entry) * p.frac; remain -= p.frac; taken[j] = true; }
    });
    // 종가: 9 EMA 이탈이면 나머지 전량.
    if (trail && k > entryIdx && ema9[k] != null && closes[k] < ema9[k]) { pnl += (closes[k] - entry) * remain; remain = 0; break; }
  }
  if (remain > 0) { k = last; pnl += (closes[last] - entry) * remain; }
  return finish(entry, R, pnl, k - entryIdx + 1, taken[0], taken[1]);
}

function finish(entry, R, pnl, hold, hit3, hit5) {
  const costPx = entry * COST / 100;
  return { ret: (pnl - costPx) / entry * 100, rMult: (pnl - costPx) / R, hold, hit3, hit5 };
}

// ── 평가 루프 ─────────────────────────────────────────────────────────
const newBucket = () => ({ all: [], in: [], out: [] });

async function main() {
  const loaded = await loadCache(STOCKS);
  const stocks = loaded.filter(s => !/스팩/.test(s.name ?? ''));
  const spacs = loaded.length - stocks.length;

  let haltedBars = 0;
  for (const st of stocks) {
    st.halted = st.closes.map((_, i) => !(st.opens[i] > 0 && st.lows[i] > 0));
    st.halted.forEach((h, i) => { if (h) { st.opens[i] = st.highs[i] = st.lows[i] = st.closes[i]; haltedBars++; } });
    // 미조정 급변 봉의 누적합 — 구간 안에 하나라도 있는지 O(1)로 본다.
    const n = st.closes.length;
    st.jumpPre = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const pc = i > 0 ? st.closes[i - 1] : 0;
      const jump = pc > 0 && (Math.abs(st.opens[i] / pc - 1) > JUMP || Math.abs(st.closes[i] / pc - 1) > JUMP);
      st.jumpPre[i + 1] = st.jumpPre[i] + (jump ? 1 : 0);
    }
    st.start = Math.max(80, n - WINDOW);
    st.tEnd = n - MAX_HOLD;                  // 모든 청산이 데이터 안에서 끝나는 마지막 셋업일 + 1
  }

  // 공통 분할일: 표본 날짜(중복 제거)의 70% 지점
  const allDates = new Set();
  for (const st of stocks) for (let t = st.start; t < st.tEnd; t++) allDates.add(st.dates[t]);
  const sortedDates = [...allDates].sort();
  const splitDate = sortedDates[Math.floor(sortedDates.length * SPLIT)];

  console.log(`풀백 셋업 측정 · 종목 ${stocks.length}(스팩 ${spacs} 제외) · 창 ${WINDOW}봉 · 비용 ${COST}% · 정지봉 ${haltedBars} · 분할일 ${splitDate}`);

  const acc = {};
  for (const v of VARIANTS) {
    acc[v] = { setups: 0, noTrigger: 0, badR: 0, wideStop: 0, stopPct: [], adr: [] };
    for (const x of EXITS) acc[v][x] = newBucket();
  }
  let skipHalt = 0, skipJump = 0;

  for (const st of stocks) {
    const { opens, highs, lows, closes, dates, halted, jumpPre, start, tEnd } = st;
    if (start >= tEnd) continue;
    const ema9 = calcEMA(closes, EMA_FAST), ema21 = calcEMA(closes, EMA_SLOW);

    for (let t = start; t < tEnd; t++) {
      if (halted[t] || halted[t + 1]) { skipHalt++; continue; }
      const a0 = Math.max(0, t - JUMP_GUARD), b0 = t + MAX_HOLD;
      if (jumpPre[b0 + 1] - jumpPre[a0] > 0) { skipJump++; continue; }

      const seg = dates[t] < splitDate ? 'in' : 'out';
      const push = (b, x) => { b.all.push(x); b[seg].push(x); };

      const trend = ema9[t - 2] != null && ema21[t - 2] != null
        && ema9[t - 1] > ema9[t - 2] && ema21[t - 1] > ema21[t - 2];
      const pulled = trend && lows[t] <= ema9[t];

      let adr = 0;
      for (let k = t - ADR_LEN + 1; k <= t; k++) adr += (highs[k] / lows[k] - 1) * 100;
      adr /= ADR_LEN;

      const e = t + 1, stop = lows[t] - tick(lows[t]);
      for (const v of VARIANTS) {
        if (ADR5.has(v) && !(adr >= ADR_MIN)) continue;
        if (!isControl(v) && !trend) continue;
        if (!isControl(v) && v !== '추세만' && !pulled) continue;
        const a = acc[v];
        a.setups++;

        let entry = opens[e];
        if (BREAKOUT.has(v)) {
          const trigger = highs[t] + tick(highs[t]);
          if (!(highs[e] >= trigger)) { a.noTrigger++; continue; }
          entry = Math.max(opens[e], trigger);   // 갭 상승이면 시가 체결
        }
        if (!(entry > stop)) { a.badR++; continue; }   // 다음날 시가가 손절선 아래로 열린 날 — 1R을 정의할 수 없다
        const stopPct = (entry - stop) / entry * 100;
        if (v === '풀백_돌파_손절폭' && !(Number.isFinite(adr) && stopPct <= Math.min(STOP_MAX_PCT, adr * STOP_MAX_ADR))) { a.wideStop++; continue; }

        push(a.SPEC,  simSpec(st, e, entry));
        push(a.LUK20, simLuk(st, ema9, e, entry, stop, false));
        push(a.LUK,   simLuk(st, ema9, e, entry, stop, true));
        push(a.LUKADR, simLuk(st, ema9, e, entry, stop, true, [{ px: entry * (1 + ADR_MULT * adr / 100), frac: ADR_FRAC }]));
        a.stopPct.push(stopPct);
        a.adr.push(adr);
      }
    }
  }

  // ── 집계 ───────────────────────────────────────────────────────────
  const mean = (arr) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
  const trimmed = (arr) => {
    const s = [...arr].sort((x, y) => x - y), cut = Math.floor(s.length * TRIM);
    return mean(s.slice(cut, s.length - cut));
  };
  const pct = (arr, f) => arr.length ? r2(arr.filter(f).length / arr.length * 100) : null;
  const ex = (m, b) => m == null || b == null ? null : r2(m - b);
  // 세 값의 부호가 모두 같으면 그 부호, 아니면 '.'
  const signOf = (xs) => xs.every(x => x != null && x > 0) ? '+' : xs.every(x => x != null && x < 0) ? '-' : '.';
  const segMean = (b, seg, key) => mean(b[seg].map(o => o[key]));

  const rows = VARIANTS.map(v => {
    const a = acc[v];
    const row = {
      variant: v, setups: a.setups, noTrigger: a.noTrigger, badR: a.badR, wideStop: a.wideStop,
      trades: a.SPEC.all.length, stopPctMedian: r2(median(a.stopPct)), adrMedian: r2(median(a.adr)),
    };
    for (const x of EXITS) {
      const b = a[x], c = acc[controlOf(v)][x];
      const rs = b.all.map(o => o.rMult);
      const o = {
        mean: r2(segMean(b, 'all', 'ret')), winRate: pct(b.all, o => o.ret > 0),
        meanR: r2(segMean(b, 'all', 'rMult')), meanRIn: r2(segMean(b, 'in', 'rMult')), meanROut: r2(segMean(b, 'out', 'rMult')),
        trimmedR: r2(trimmed(rs)), medianR: r2(median(rs)),
        hit3Pct: pct(b.all, o => o.hit3), hit5Pct: x === 'LUKADR' ? null : pct(b.all, o => o.hit5),   // LUKADR은 분할 1개 — 5R 도달률 없음
        holdMean: r2(segMean(b, 'all', 'hold')),
      };
      o.rSign = signOf([o.meanR, o.meanRIn, o.meanROut]);
      if (!isControl(v)) {
        o.excessAll = ex(segMean(b, 'all', 'ret'), segMean(c, 'all', 'ret'));
        o.excessIn  = ex(segMean(b, 'in', 'ret'),  segMean(c, 'in', 'ret'));
        o.excessOut = ex(segMean(b, 'out', 'ret'), segMean(c, 'out', 'ret'));
        o.excessSign = signOf([o.excessAll, o.excessIn, o.excessOut]);
      }
      row[x] = o;
    }
    return row;
  });

  const f = (x, w) => (x == null ? '-' : String(x)).padStart(w);
  console.log(`제외: 정지봉 셋업·진입 ${skipHalt} · 미조정 급변 구간 ${skipJump}`);
  console.log('\n변형                셋업   미발동  시가<손절  손절폭초과   거래  손절폭중앙  ADR중앙');
  for (const r of rows) {
    console.log(r.variant.padEnd(16) + f(r.setups, 8) + f(r.noTrigger, 9) + f(r.badR, 10) + f(r.wideStop, 11)
      + f(r.trades, 7) + f(r.stopPctMedian, 10) + '%' + f(r.adrMedian, 8) + '%');
  }
  console.log('\n초과 = 같은 청산 규칙을 적용한 무조건 대조군 대비 %p. 부호 = 전체·in·out 세 값이 모두 같은 부호면 +/-, 아니면 .');
  console.log('변형              청산   평균%  승률  초과(전체) 초과(in) 초과(out) 부호 | 평균R  R(in) R(out) 절사R  중앙R 부호 | 3R%   5R%  보유일');
  console.log('─'.repeat(146));
  for (const r of rows) {
    for (const x of EXITS) {
      const o = r[x];
      console.log((x === 'SPEC' ? r.variant : '').padEnd(16) + '  ' + x.padEnd(5) + f(o.mean, 7) + f(o.winRate, 6)
        + f(o.excessAll, 11) + f(o.excessIn, 9) + f(o.excessOut, 10) + '   ' + (o.excessSign ?? ' ')
        + ' |' + f(o.meanR, 6) + f(o.meanRIn, 7) + f(o.meanROut, 7) + f(o.trimmedR, 6) + f(o.medianR, 7) + '   ' + o.rSign
        + ' |' + f(o.hit3Pct, 6) + f(o.hit5Pct, 6) + f(o.holdMean, 7));
    }
  }

  if (OUT) {
    const dest = path.join(HERE, OUT);
    await writeFile(dest, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'Martin Luk — TraderLion 인터뷰 VKNEJA5r8zw(2026-01-31) 발언 규칙의 일봉 번역. 계기: youtube shorts aZDVXXmgZWY',
      params: {
        window: WINDOW, split: SPLIT, splitDate, cost: COST, stocks: stocks.length, spacsExcluded: spacs,
        haltedBars, skipHalt, skipJump,
        emaFast: EMA_FAST, emaSlow: EMA_SLOW, partials: PARTIALS, stopMaxPct: STOP_MAX_PCT, stopMaxAdr: STOP_MAX_ADR,
        specHorizon: HORIZON, specStop: SPEC_STOP,
        assumed: { adrLen: ADR_LEN, maxHold: MAX_HOLD, trailFrom: 'entry+1', tick: 'KRX 2023-01-25 통합 호가단위 [확인 필요]' },
        cleaning: { jump: JUMP, jumpGuard: JUMP_GUARD, trimR: TRIM },
      },
      variants: rows,
    }, null, 2));
    console.log(`\n저장: ${dest}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
