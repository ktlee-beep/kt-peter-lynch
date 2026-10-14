// 야후 응답 검증 — 상장 시장이 아닌 접미사의 "죽은 티커"를 거르고 정상 티커는 받는다.
//
// 이 파일이 있는 이유: 이름에 쉼표가 있으면 버리던 옛 규칙이 정상 응답("COWAY Co., Ltd.")을
// 버리고, 2024-07-19 가격에 멈춘 .KQ 응답을 받아 종목분석 현재가가 코웨이 63,300원(실제 약
// 10만원)·삼성전자 84,400원(실제 약 23만원)으로 나왔다(2026-10-14). 아래 meta는 그날 야후가
// 실제로 준 응답에서 필요한 필드만 옮겼다.
//
// 네트워크를 타지 않는다.
import { isValidYahooResult } from '../data.js';

const NOW = Date.parse('2026-10-14T01:10:00Z');
const t = (iso) => Date.parse(iso) / 1000;

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  if (got === want) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} got=${got} want=${want}`); }
};

// 정상 티커 — 쉼표가 든 longName도 받아야 한다
ok('코웨이 .KS 정상(Co., Ltd.)', isValidYahooResult({ symbol: '021240.KS', longName: 'COWAY Co., Ltd.', shortName: 'COWAY',
  instrumentType: 'EQUITY', regularMarketTime: t('2026-10-14T01:05:55Z') }, '021240', 'KS', NOW), true);
ok('삼성전자 .KS 정상', isValidYahooResult({ symbol: '005930.KS', longName: 'Samsung Electronics Co., Ltd.', shortName: 'SamsungElec',
  instrumentType: 'EQUITY', regularMarketTime: t('2026-10-14T01:06:11Z') }, '005930', 'KS', NOW), true);
ok('에코프로비엠 .KQ 정상', isValidYahooResult({ symbol: '247540.KQ', longName: 'EcoPro BM Co., Ltd.', shortName: 'ECOPROBM',
  instrumentType: 'EQUITY', regularMarketTime: t('2026-10-14T01:08:00Z') }, '247540', 'KQ', NOW), true);
ok('ETF 정상', isValidYahooResult({ symbol: '069500.KS', longName: 'KODEX 200', shortName: 'KODEX 200',
  instrumentType: 'ETF', regularMarketTime: t('2026-10-14T01:08:00Z') }, '069500', 'KS', NOW), true);

// 죽은 티커 — 셋 다 걸리는 실제 모양, 그리고 신호 하나씩만 남겨도 걸리는지
const dead = { symbol: '021240.KQ', longName: 'Coway', shortName: '021240.KQ,0P0000B9ZH,148690',
  instrumentType: 'MUTUALFUND', regularMarketTime: t('2024-07-19T20:00:00Z') };
ok('코웨이 .KQ 죽은 티커', isValidYahooResult(dead, '021240', 'KQ', NOW), false);
ok('shortName 자리표시만', isValidYahooResult({ ...dead, instrumentType: 'EQUITY', regularMarketTime: t('2026-10-14T01:00:00Z') }, '021240', 'KQ', NOW), false);
ok('MUTUALFUND만', isValidYahooResult({ ...dead, shortName: 'Coway', regularMarketTime: t('2026-10-14T01:00:00Z') }, '021240', 'KQ', NOW), false);
ok('옛 거래시각만', isValidYahooResult({ ...dead, shortName: 'Coway', instrumentType: 'EQUITY' }, '021240', 'KQ', NOW), false);
ok('longName 자리표시(옛 060230 사례)', isValidYahooResult({ symbol: '060230.KS', longName: '060230.KS,0P0000BZWP,3133778' }, '060230', 'KS', NOW), false);
ok('영숫자 코드 자리표시', isValidYahooResult({ symbol: '0220W0.KQ', shortName: '0220W0.KQ,0P0000ZZZZ,1', instrumentType: 'EQUITY',
  regularMarketTime: t('2026-10-14T01:00:00Z') }, '0220W0', 'KQ', NOW), false);

// 기존 규칙 유지
ok('심볼 불일치', isValidYahooResult({ symbol: '000660.KS', longName: 'SK hynix Inc.' }, '005930', 'KS', NOW), false);
ok('meta 없음', isValidYahooResult(null, '005930', 'KS', NOW), false);
ok('심볼 대소문자 무관', isValidYahooResult({ symbol: '005930.ks', longName: '삼성전자' }, '005930', 'KS', NOW), true);
ok('거래시각 없는 응답은 시각으로 거르지 않음', isValidYahooResult({ symbol: '005930.KS', longName: '삼성전자' }, '005930', 'KS', NOW), true);
// 추석 같은 장기 휴장(10일 안팎) 뒤 첫 조회는 받아야 한다
ok('12일 전 거래시각은 정상', isValidYahooResult({ symbol: '005930.KS', longName: 'Samsung Electronics Co., Ltd.',
  instrumentType: 'EQUITY', regularMarketTime: t('2026-10-02T06:30:00Z') }, '005930', 'KS', NOW), true);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
if (fail) process.exit(1);
