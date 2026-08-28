# 저평가 선점 시스템 — 상세 실행계획서

작성일: 2026-08-28
상위 문서: `ROADMAP-저평가선점.md` (전략·설계 원리)
본 문서: Phase별 파일 단위 구현 명세 + 최상의 구성방안 + 수용 기준(AC)

---

# Part A. 선행 질문에 대한 답 — "저평가 종목을 확인할 수 있는 시스템인가?"

**결론: 아니다. 현재는 "PER·PBR 낮은 대형주 필터"까지만 작동하고, "실적은 성장하는데 주가만 소외된 종목"의 탐지는 불가능하다.** 코드 전수 조사(2026-08-28, `server.js`·`analysis.js`·`data.js`·`cron.js`·`db.js`·`schema.sql`) 결과:

| 저평가 판별에 필요한 기능 | 현재 상태 | 판정 |
|---|---|---|
| PER·PBR·ROE 필터 (`value` 프리셋) | Naver 펀더멘털 기반, 24h 캐시 | **작동** |
| 부채비율 필터 (`debt_max`) | Naver 응답에 `debtToEquity` 없음 → 필터 무동작 | **고장** |
| PEG (린치 핵심 지표, +25 배점) | `calcLynchScore`에 로직 존재하나 입력이 항상 null | **사실상 미작동 (dead code)** |
| 52주 고점 대비 하락률 | 실제로는 6개월 고점(`count=120`, `slice(-125)`) | **고장 (측정값 자체가 틀림)** |
| 52주 저점 근접 스크리닝 (`/api/52w?direction=low`) | `near52wLow`를 아무 곳에서도 기록 안 함 → 항상 빈 결과 | **고장** |
| 3년 실적 시계열 (매출·영업이익 연속 증가) | 수집기 `fetchDartMultiYear` 존재하나 미저장 | **부재 (수집기만 있음)** |
| Piotroski F-Score | 10개 중 3개 체크(roa·유동비율·부채비율) 입력 항상 null | **7/10만 평가** |
| 시장 대비 상대강도(RS) | 없음 | **부재** |
| 기관·외국인 수급 추세 | 25일치 조회만 가능, 미저장·미분석 | **부재** |
| 유니버스 | 하드코딩 대형주 199종목 (KOSPI 153 + KOSDAQ 46) | **선점 목적에 부적합** |

따라서 "확인부터 해야 하나?"의 답: **확인은 완료됐고, 시스템을 저평가 탐지가 가능한 상태로 만드는 것 자체가 Phase 0~1이다.** 별도 선행 작업은 필요 없다.

---

# Part B. Phase별 상세 구현 명세

## Phase 0 — 신뢰성 복구 (반나절, R2)

### 0-1. 52주 윈도우 정상화 — `cron.js` `analyzeStockLean`

- Naver 차트 요청 `count=120` → **`count=280`** (52주 = 거래일 약 252일 + 휴장 버퍼. Phase 4의 RS 12개월 계산도 252일이 필요하므로 여기서 한 번에 확보)
- 계산 추가:
  ```js
  const w = closes.slice(-252);
  const high52w = Math.max(...w);
  const low52w  = Math.min(...w);
  const pctFrom52wHigh = (close / high52w - 1) * 100;  // 음수 = 고점 대비 하락률
  const pctFrom52wLow  = (close / low52w  - 1) * 100;
  const near52wHigh = close / high52w >= 0.95;
  const near52wLow  = close / low52w  <= 1.05;
  const w52Partial  = closes.length < 200;  // 신규상장 가드
  ```
- 반환 객체에 위 7개 필드 추가 → `analysis_json`에 자동 영속 (스키마 변경 없음)
- **엣지케이스**: 상장 1년 미만 종목은 `w52Partial: true`로 표시하고 52주 지표 기반 배점에서 제외(0점 아님, null 처리)

### 0-2. `/api/52w` 자동 복구

0-1이 끝나면 기존 필터(`aj.near52wLow`)가 그대로 살아난다. 추가 개선: `pctFrom52wHigh` 기준 정렬 파라미터(`sort=drawdown`) 1개 추가.

### 0-3. DART CFS 중복 fetch 제거 — `data.js:99, 109`

동일 CFS 호출 2회 → 1회 재사용. 종목당 호출 약 10회 → 5회. **Phase 1 백필 총량이 절반이 되므로 반드시 Phase 1보다 먼저.**

### 0-4. keepalive 이식 — `03/.github/workflows/keepalive.yml` → 02

- URL만 `kt-peter-lynch.onrender.com/healthz`로 변경, `*/14 * * * *` 유지
- 효과: Render free 슬립 제거 → 사용자 첫 방문 콜드스타트(약 40초+) 해소, in-process 배치 후처리 안정성 확보
- 참고: GitHub Actions 스케줄은 정시 실행이 보장되지 않고 지연될 수 있음 — keepalive 용도로는 무해

**AC(수용 기준)**: (1) 스캔 1회 후 `/api/52w?direction=low` 비어있지 않음. (2) 삼성전자 `high52w`가 Naver 금융 페이지의 52주 최고가와 일치. (3) `fetchDartMultiYear` 1종목 호출 시 DART 요청 5회 이하.

---

## Phase 1 — 3년 재무 시계열 영속화 (1~2일, R2) ★최대 ROI

### 1-1. 저장 계층 — `db.js`

기존 `kvGet`/`kvSet` 패턴 재사용 (DDL 불필요):

```js
// key: '__multiyear__<code>', value: fetchDartMultiYear() 결과 배열
async function getMultiYear(code, maxDays = 365) { return kvGet(`__multiyear__${code}`, maxDays); }
async function setMultiYear(code, data) { return kvSet(`__multiyear__${code}`, data); }
```

TTL 365일. 연간 사업보고서는 3~4월 공시이므로 실질 갱신은 연 1회 + 월간 크론이 TTL 만료분만 보충.

### 1-2. 백필 실행 경로 — GitHub Actions HTTP 트리거 (구성방안 C-1 참조)

- 신규 엔드포인트 `POST /api/backfill/multiyear/trigger` (`x-scan-secret` 보호, 기존 `/api/scan/trigger` 패턴 복제)
- 동작: 활성 유니버스 순회 → `getMultiYear` 미스만 `fetchDartMultiYear` → `setMultiYear`. 청크 10종목 + 1초 대기
- 호출량: 199종목 × 5회 = 약 1,000회/월. DART 일일 한도는 10,000 또는 20,000건 `[확인 필요 — opendart.fss.or.kr 이용약관 기준으로 확정할 것]` — 어느 쪽이든 여유
- `.github/workflows/daily-cron.yml`에 월간 잡 추가: `0 2 1 * *` (매월 1일 11:00 KST)
- 최초 1회는 수동 트리거로 즉시 백필

### 1-3. 성장 연속성 평가기 — `analysis.js` 신규 `calcGrowthStreak(series)`

```js
// series: 연대순 [{year, revenue, operatingProfit, netIncome, equity, debt,
//                 roe, debtRatio, currentRatio, opMargin}]
// 반환:
{
  revenueUp3,   // 매출 3년 연속 YoY 증가 (4개 연도 필요)
  opUp3,        // 영업이익 3년 연속 YoY 증가
  noLoss3,      // 최근 3년 순이익>0 AND 영업이익>0 (박세익 하드 게이트 입력)
  cagr3NetIncome, // 3년 순이익 CAGR (양끝 모두 양수일 때만, 아니면 null)
  latest: { debtRatio, currentRatio, roe, roa },  // roa = netIncome/(equity+debt)*100
  yearsAvailable  // 데이터 연도 수 — 4 미만이면 streak 판정 불가(null)
}
```

**엣지케이스 규칙**: 연도 결측·null은 streak를 `false`가 아니라 `null`(판정 불가)로 — "데이터 없음"과 "탈락"을 구분한다 (구성방안 C-5).

### 1-4. PEG 부활 — `cron.js`

스캔 시 `getMultiYear` 캐시를 읽어(추가 DART 호출 없음):

```js
const streak = calcGrowthStreak(multiYear);
const growthPct = streak?.cagr3NetIncome != null ? streak.cagr3NetIncome * 100 : null;
fundamentals.peg = (fund?.per > 0 && growthPct > 0) ? fund.per / growthPct : null;
```

이후 기존 `calcLynchScore` 호출에 그대로 전달 → 죽어 있던 PEG 브랜치(+25/+15/+5/-15/-10) 활성화.

### 1-5. Piotroski 10/10 복원 — `cron.js`

```js
fund.roa           = streak?.latest?.roa ?? null;
fund.debtToEquity  = streak?.latest?.debtRatio ?? null;     // % 단위 그대로 (체크: v < 100)
fund.currentRatio  = streak?.latest?.currentRatio != null
                   ? streak.latest.currentRatio / 100 : null; // 단위 함정 주의!
```

**단위 함정**: `calcPiotroski`의 유동비율 체크는 `v > 1`(배수)인데 DART `currentRatio`는 %(예: 150) — **100으로 나누지 않으면 전 종목이 통과해버린다.** 부채비율 체크는 `v < 100`(%)이므로 그대로 전달.

**AC**: (1) 백필 후 임의 10종목 `getMultiYear` 히트. (2) 동일 종목 Piotroski `available`이 7 → 9~10으로 상승. (3) 스크리너 `debt_max=150` 적용 시 결과 수 감소(필터 부활 증명). (4) 성장주 1종목에서 `peg` 값 non-null 확인.

---

## Phase 2 — 유니버스 확장 199 → 600~900 (2~3일, R2)

### 2-1. 소스 선정

| 옵션 | 내용 | 판정 |
|---|---|---|
| A. KRX 정보데이터시스템 | data.krx.co.kr JSON 엔드포인트, 전종목 시세+시총 일괄 `[확인 필요 — 정확한 bld 파라미터·비공식 사용 제약]` | **1순위** |
| B. DART corpCode.xml | 공식·안정. 상장사 전체 목록(stock_code 보유분). 단 시총 없음 → Naver 펀더멘털로 보충 필요 | **폴백** |
| C. Naver 모바일 API 페이지네이션 | `m.stock.naver.com/api/stocks/marketValue/...` `[확인 필요]` | 예비 |

구현 시 A를 먼저 프로브하고 실패 시 B로 자동 폴백하는 `refreshUniverse()` 함수 1개로 캡슐화.

### 2-2. 편입 필터 (선점 목적 + 유동성 하한)

- 보통주만: 종목코드 끝자리 `0` (우선주 5·7·9·K 등 제외)
- 종목명 `스팩` 포함 제외, 리츠·인프라펀드 제외(선택)
- **시가총액 500억~1,000억 이상** `[확인 필요 — 백테스트로 하한 확정]`
- **일평균 거래대금 하한** (예: 10억원) — 선점해도 못 파는 종목 방지. 초기값은 임의이며 백테스트로 조정
- 예상 결과: 600~900종목 (KOSPI 상장 847사 기준 — 2025-12-31, KOSDAQ 포함 전체 약 2,600사에서 필터링)

### 2-3. `kt_stocks` 동적 시딩

- 월 1회 `refreshUniverse()` → 신규 편입 insert, 이탈 종목 `is_active=false` (삭제 금지 — 과거 분석 FK 보존)
- `kt_daily_analysis.code`가 `kt_stocks` FK이므로 **insert 순서: kt_stocks 먼저**
- 실행 경로: Actions 월간 잡 `0 1 1 * *` (Phase 1 백필 1시간 전 — 신규 종목도 당일 백필 포함되도록)

### 2-4. 부하 검증

- 일일 스캔: 800종목 × (차트 1회 + 펀더멘털 캐시 미스분) — 기존 청크 30 + 500ms 페이싱으로 약 1~2분. 수급 수집(Phase 4) 추가 시 약 2~4분
- DART 월 백필: 800 × 5 = 4,000회 — 한도 내
- **Render free 타임아웃 확인 필수**: 스캔이 HTTP 요청 안에서 동기 완료되는 구조라면 800종목에서 타임아웃 위험 → 트리거는 즉시 202 반환, 배치는 백그라운드 진행, 진행상태는 `kt_scan_batches` 조회로 확인하는 구조인지 점검 후 아니면 전환

**AC**: (1) `kt_stocks` 활성 600+ 종목. (2) 전체 스캔 완주 + `kt_scan_batches.status=completed`. (3) 스캔 소요시간 로그 5분 이내.

---## Phase 3 — 박세익 스코어 + 2축 매트릭스 (2일, R2)

### 3-1. `analysis.js` 신규 `calcParkScore(streak, priceCtx, fund)`

```js
// 입력: streak = calcGrowthStreak 결과, priceCtx = {pctFrom52wHigh, w52Partial}, fund = {per, pbr}
// 1) 게이트 (감점이 아닌 즉시 탈락)
if (!streak || streak.yearsAvailable < 4) return { score: null, gated: 'NO_DATA' };
if (streak.noLoss3 === false)             return { score: 0,    gated: 'LOSS_3Y' };
// 2) 배점 (초안 — Phase 3 완료 후 백테스트로 조정)
매출 3년 연속 증가        +25
영업이익 3년 연속 증가    +25
3년 무적자               +20   (게이트 통과 시 자동 +20)
52주 고점 대비 -30% 이하  +20   /  -20~-30%  +12   (w52Partial이면 0, null 사유 기록)
PER 유니버스 중앙값 미만  +10   (섹터 중앙값은 kt_stocks.sector 충전 후 v2)
// 반환: { score 0..100, grade, gated: null, reasons[] }
```

**게이트를 점수 합산과 분리하는 이유**: 합산 방식이면 다른 항목 고득점이 적자를 상쇄한다. 박세익의 가장 강한 경고("최근 3년 적자 한 번이라도 있으면 피하라", "스토리로만 오르는 주식은 기획부동산")를 무력화하지 않기 위해 하드 컷.

### 3-2. 매트릭스 존 판정 — `cron.js` 스캔 시 계산

```js
function matrixZone(park, liv) {
  if (park == null) return 'NO_DATA';
  if (park >= 60 && liv <  45) return 'SEONJEOM';    // 선점 후보: 실적 좋은데 소외
  if (park >= 60 && liv >= 60) return 'BREAKOUT';    // 캔슬림 구간: 시장이 인식 시작
  if (park <  40 && liv >= 60) return 'STORY_WARN';  // 스토리주 경고
  return 'NEUTRAL';
}
```

`park_score`·`matrix_zone`은 `analysis_json`에 저장 (DDL 불필요). 임계값 60/45/40은 초안 — 백테스트 조정 대상.

### 3-3. 스크리너 프리셋 추가 — `server.js:1110` 프리셋 테이블

```js
park: { park_min: 60, zone: 'SEONJEOM' }   // 신규 필터 파라미터 2개 추가
```

기존 필터 루프(`server.js:1167`)에 `fParkMin`·`fZone` 2개 조건 추가. 응답에 `park_score`·`matrix_zone`·`pctFrom52wHigh`·`gated` 노출.

### 3-4. 프런트엔드 (선택)

스크리너 페이지에 "선점" 프리셋 버튼 + 결과 테이블 컬럼 3개(박세익 점수·존·고점대비하락률). 2D 산점도(x=리버모어, y=박세익)는 v2.

**AC**: (1) `/api/screener?preset=park` 정상 응답, `gated:'LOSS_3Y'` 종목 미포함. (2) 3년 연속 성장 + 고점 -30% 종목이 SEONJEOM으로 분류되는 것을 실제 1종목으로 육안 검증. (3) 적자 이력 종목 강제 조회 시 score 0 확인.

---

## Phase 4 — RS·수급·전환 알림 = 선점의 실행 (3~4일, R2 / DDL 시 R3)

### 4-1. RS 등급 (IBD 방식 자체 산출)

공식 (웹 검증 완료 — 출처 Part D):

```
RS_raw = 0.4×(P/P63 - 1) + 0.2×(P/P126 - 1) + 0.2×(P/P189 - 1) + 0.2×(P/P252 - 1)
RS_rating = 유니버스 내 RS_raw 백분위 (0~100)
```

- 최근 분기에 40% 가중 — 소외주에 모멘텀이 "막 붙기 시작"하는 시점을 빠르게 반영. 선점 트리거에 정확히 부합
- 구현: `analyzeStockLean`이 이미 280봉을 갖고 있으므로 **스캔 중** `r63·r126·r189·r252`를 계산해 `analysis_json`에 저장(추가 HTTP 0회). **스캔 완료 후** 당일 전체 행을 읽어 백분위 1패스 → `analysis_json.rsRating` 업데이트
- 상장 1년 미만: 보유 구간만으로 부분 계산하되 `rsPartial: true` 표시
- 지수 대비 나눗셈은 불필요 (IBD 방식은 유니버스 횡단 백분위) — 지수 데이터는 M 팩터(Phase 5)에서만 사용

### 4-2. 수급 추세 영속화

- 스캔 시 활성 유니버스 전체 `fetchNaverInvestor(code)` → KV `__supply__<code>` (25일치, TTL 7일 롤링 갱신)
- 파생 지표 계산 후 `analysis_json.supply`에 저장:
  - `accel`: 최근 5일 순매수합 − 직전 20일 일평균×5 (기관·외인 각각)
  - `streakBuy`: 연속 순매수일 수 / `streakSell`: 연속 순매도일 수
  - `netToMcap`: 20일 순매수합 / 시가총액 (대형주 편향 제거)
- 부하: +약 800 HTTP → 기존 페이싱 유지 시 총 스캔 2~4분

### 4-3. 존 전이 감지 + 선점 알림

- KV `__zone__<code>`에 직전 존 저장 → 스캔 시 비교
- **알림 조건**: 직전 존이 SEONJEOM이었던 종목에서 아래 3개 중 2개 이상 동시 발생
  1. `rsRating`이 50 미만 → 50 이상 돌파 (임계값 `[확인 필요 — 백테스트 조정]`)
  2. 기관 또는 외인 `streakSell` 종료 후 `streakBuy >= 3`
  3. `volRatio >= 2.0` AND `changeRate > 0`
- 발송: 기존 모닝브리프(`kt_morning_brief` + Gmail SMTP) 파이프라인에 "선점 전환 감지" 섹션 추가 — 신규 발송 채널 없음, 기존 재사용
- **주의**: 알림은 내부 이메일 발송이므로 기존 승인된 브리프 파이프라인 범위 내. 신규 외부 채널 추가 시 별도 컨펌

### 4-4. (선택) 정식 테이블 승격

수급·RS를 정식 컬럼으로 승격하려면 `kt_supply_daily` 테이블 신설 = **DB 마이그레이션 = R3 풀 파이프라인** (qa-orchestrator 3병렬 → dev-orchestrator → 단일 커밋). KV 방식이 성능 병목을 보이기 전까지는 보류 권장.

**AC**: (1) 스캔 후 전 종목 `rsRating` 채워짐, 백분위 합리성(상위 종목이 실제 급등주인지 육안 5종목). (2) `__supply__` KV 800건 존재. (3) 존 전이 시뮬레이션(수동 KV 조작)으로 알림 1건 발생 확인.

---

## Phase 5 — 캔슬림 정식 편입 (선택, 3일, R2)

- **C (분기 EPS)**: DART `reprt_code` 11013(1분기)·11012(반기)·11014(3분기) 추가 수집 → 분기 YoY EPS 성장률. 오닐 기준 +18~25% 이상
- **M (시장 방향)**: `kt_macro_snapshots`(usdkrw·kospi·vix·us10y 기수집) 기반 합성 판정:
  - KOSPI > 200일 이평 AND vix < 25 → RISK_ON / 반대 → RISK_OFF / 그 외 NEUTRAL `[확인 필요 — 임계값 백테스트]`
  - RISK_OFF에서는 BREAKOUT 알림 음소거(발굴은 계속, 진입 신호만 보류) — "실적 좋아도 시황 나쁘면 -70%"(박세익) 반영
- A·N·S·L·I는 Phase 0~4에서 이미 확보됨 (로드맵 Part 5 표 참조)

---

# Part C. 최상의 구성방안 — 아키텍처 결정 8가지

**C-1. 모든 배치는 GitHub Actions HTTP 트리거로 통일.** Render free는 슬립하므로 in-process `cron.schedule`은 신뢰 불가. 이미 `daily-cron.yml`이 이 패턴(wake 40초 → POST + secret)을 쓰고 있다 — 신규 배치(월간 백필·유니버스 갱신)도 전부 같은 파일에 잡으로 추가. keepalive(0-4)는 이를 이중 보강.

**C-2. 저장은 KV 우선, DDL은 나중.** 프로덕션 DDL 권한 부재가 확인된 제약. `kt_fundamentals_cache`를 KV로 쓰는 기존 관행(`__dart__` 프리픽스)을 그대로 확장(`__multiyear__`·`__supply__`·`__zone__`·`__index__`). 병목 확인 전 테이블 신설 금지 — 신설 순간 R3.

**C-3. 무거운 계산은 스캔 파이프라인에 편승.** 280봉·수급·RS 원료를 전부 야간 스캔 1회에 수집하고, RS 백분위만 스캔 직후 후처리 1패스. 주간 API 응답은 전부 `kt_daily_analysis` 조회 — 라이브 계산 없음. 지금 스크리너의 "야간 스캔 + 주간 필터" 구조를 그대로 유지·확장하는 것.

**C-4. 적자 게이트는 하드 컷, 배점과 분리.** (Phase 3-1 참조)

**C-5. "데이터 없음(null)"과 "탈락(0)"을 전 구간에서 구분.** null을 0으로 뭉개면 신규상장·데이터 결측 종목이 전부 "나쁜 종목"으로 오분류되어 선점 후보에서 조용히 사라진다. `gated: 'NO_DATA'`는 별도 카운트로 노출해 백필 누락을 감시.

**C-6. 실행 순서는 0→1→2→3→4 고정.** 1이 2보다 먼저인 이유: 스코어 컷을 199종목으로 먼저 정의·검증한 뒤 유니버스를 늘려야 결과 폭증을 통제할 수 있다. 2가 3보다 먼저인 이유: 매트릭스 임계값(60/45)은 유니버스 분포에 의존하므로 최종 유니버스에서 캘리브레이션해야 한다.

**C-7. 배점·임계값은 전부 백테스트로 확정.** `runBacktest`/`runBacktestMulti`가 이미 있다. 절차: (1) Phase 3 완료 후 과거 `kt_daily_analysis` 축적분으로 SEONJEOM→BREAKOUT 전이 종목의 이후 20·60일 수익률 측정 → (2) 박세익 배점·존 임계값·알림 임계값 조정 → (3) 워크포워드(조정에 쓴 구간과 검증 구간 분리). 데이터 축적 전에는 임계값을 확정 취급하지 말 것.

**C-8. 리스크 티어 준수.** 전 Phase R2(구현 → `qa-logic-validator` 1개 사후 검증 → 커밋). 예외: Phase 4-4 정식 테이블 신설 시 R3 풀 파이프라인. 커밋은 Phase 단위 단일 커밋.

## 크론·배치 시간표 (통합 후)

| 시각 (KST) | 잡 | 경로 | 상태 |
|---|---|---|---|
| 14분마다 | keepalive | Actions → `/healthz` | Phase 0 신설 |
| 07:00 평일 | 미국 스캔 | Actions → `/api/scan/us/trigger` | 기존 |
| 08:00 평일 | 모닝브리프 (+선점 전환 섹션) | Actions → `/api/brief/generate` | 기존+Phase 4 확장 |
| 20:00 평일 | KR 스캔 (+수급·RS·존 전이) | Actions → `/api/scan/trigger` | 기존+Phase 4 확장 |
| 매월 1일 10:00 | 유니버스 갱신 | Actions → `/api/universe/refresh` | Phase 2 신설 |
| 매월 1일 11:00 | 재무 시계열 백필 | Actions → `/api/backfill/multiyear/trigger` | Phase 1 신설 |

## 공수·리스크 요약

| Phase | 공수 | 티어 | 완료 시 얻는 것 |
|---|---|---|---|
| 0 | 반나절 | R2 | 측정값 신뢰 회복, 콜드스타트 제거 |
| 1 | 1~2일 | R2 | 박세익 3대 기준 판정 가능 + PEG·Piotroski·부채필터 부활 |
| 2 | 2~3일 | R2 | 선점 대상(중소형 실적주)이 시야에 들어옴 |
| 3 | 2일 | R2 | "선점 후보" 목록이 매일 아침 나옴 |
| 4 | 3~4일 | R2(테이블 신설 시 R3) | "지금 움직이기 시작했다" 알림 |
| 5 | 3일(선택) | R2 | 캔슬림 7요소 완성 + 시황 게이트 |

**Phase 0+1만 완료해도(2~3일) "3년 연속 실적 성장 + 52주 고점 대비 -30% + 무적자" 스크리닝이 실제로 돌아간다.** 2~4는 그 결과의 폭과 타이밍을 완성하는 단계다.

---

# Part D. 참고 출처

- DART 오픈API 이용 한도: [OPENDART 오픈API 소개](https://opendart.fss.or.kr/intro/main.do) · [이용약관](https://opendart.fss.or.kr/intro/terms.do) — 일일 한도 10,000건 언급 자료 존재, 20,000건 설도 있어 `[확인 필요]`. 본 계획 사용량은 어느 기준으로도 5% 미만
- IBD RS 등급 산식 (0.4/0.2/0.2/0.2 가중 + 유니버스 백분위): [Portfolio123 Community — RS Rating](https://community.portfolio123.com/t/rs-rating/58769) · [skyte/relative-strength (GitHub)](https://github.com/skyte/relative-strength) · [TradingView — IBD Style Relative Strength Rating](https://www.tradingview.com/script/bvUsKJ2E-IBD-Style-Relative-Strength-Rating/)
- KRX 전종목·시총 데이터: [KRX 정보데이터시스템](https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd?locale=en) · KOSPI 상장 847사(2025-12-31): [Wikipedia — Korea Exchange](https://en.wikipedia.org/wiki/Korea_Exchange)
- 박세익 발언: 교보증권 머니10 2부 증시톡터뷰 (2026-08-27, 자막 전문 확보분)
- CAN SLIM 기준: [AAII — William O'Neil's CAN SLIM Approach](https://www.aaii.com/journal/article/william-oneil-can-slim-approach-to-selecting-growth-stocks)
- 코드 근거: 본 저장소 직접 조사 (2026-08-28) — `server.js:1100-1207, 1294-1335, 1453` · `analysis.js:247-324, 615-653` · `data.js:86-222` · `cron.js:21-273` · `db.js:466-482` · `schema.sql`
