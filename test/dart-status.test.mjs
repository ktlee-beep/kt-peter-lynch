// DART 응답 원인 분류 — "자료가 없다"와 "우리가 막혔다"를 가른다.
//
// 이 파일이 있는 이유: 세 수집 함수가 실패를 전부 null로 뭉개는 바람에, 전종목 백필이
// 1,096종목을 "무자료"로 기록하고 DART 예산 14,976회를 태운 뒤에도 원인을 판별할 수
// 없었다(2026-08-30). 시장에 자료가 없어서인지 호출원이 차단돼서인지는 status 코드에만
// 남는데 그걸 버리고 있었다. 분류가 무너지면 같은 실패가 또 조용히 반복된다.
//
// 네트워크를 타지 않는다 — globalThis.fetch를 갈아끼워 응답 모양만 만든다.
import { fetchDartCompanyInfo, dartCallStats, resetDartCallStats,
         snapshotDartCallStats, dartBlockedBy } from '../data.js';

const realFetch = globalThis.fetch;
const asJson = (body) => ({ ok: true, status: 200, json: async () => body });
// 응답을 큐로 넘긴다. 큐가 비면 마지막 응답을 반복한다 — 호출 횟수에 테스트가 묶이지 않게.
let queue = [];
globalThis.fetch = async () => {
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (typeof next === 'function') return next();
  return next;
};

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK   ${name.padEnd(46)} ${g}`); }
  else { fail++; console.log(`  FAIL ${name.padEnd(46)} got=${g} want=${w}`); }
};

const run = async (resp) => {
  resetDartCallStats();
  queue = [resp];
  const out = await fetchDartCompanyInfo('00126380', 'k');
  return { out, stats: snapshotDartCallStats(), blocked: dartBlockedBy() };
};

console.log('\n── 1. 정상 응답 ──');
{
  const { out, stats, blocked } = await run(asJson({
    status: '000', corp_name: '삼성전자', stock_code: '005930', induty_code: '264', acc_mt: '12',
  }));
  ok('status 000 → 값 반환', out?.corpName, '삼성전자');
  ok('status 000 → ok 계수', [stats.ok, stats.status['000']], [1, 1]);
  ok('status 000 → 차단 아님', blocked, []);
}

console.log('\n── 2. 진짜 무자료 (013) ──');
{
  const { out, stats, blocked } = await run(asJson({ status: '013', message: '조회된 데이타가 없습니다.' }));
  ok('status 013 → null', out, null);
  ok('status 013 → ok 미증가', [stats.ok, stats.status['013']], [0, 1]);
  // 013을 차단으로 오판하면 자료 없는 종목 몇 개에 정상 실행이 통째로 끊긴다.
  ok('status 013 → 차단 아님', blocked, []);
}

console.log('\n── 3. 차단성 status ──');
for (const [code, label] of [['020', '요청 제한 초과'], ['012', '접근 불가 IP'],
                             ['011', '사용 불가 키'], ['800', '시스템 점검']]) {
  const { out, stats, blocked } = await run(asJson({ status: code }));
  ok(`status ${code} (${label}) → null`, out, null);
  ok(`status ${code} → 차단으로 분류`, [blocked, stats.status[code]], [[code], 1]);
}

console.log('\n── 4. status 이전 단계의 실패 ──');
{
  const { out, stats } = await run(() => { throw new Error('ECONNRESET'); });
  ok('네트워크 예외 → network 계수', [out, stats.network, stats.ok], [null, 1, 0]);
}
{
  // undici는 겉을 전부 "fetch failed"로 통일하고 실제 원인을 cause에 넣는다.
  // cause를 안 보면 DNS 실패와 방화벽 드롭이 같은 숫자로 보인다.
  const wrapped = () => {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    throw e;
  };
  const { stats } = await run(wrapped);
  ok('undici cause 코드 추출', stats.netCause, { ETIMEDOUT: 1 });
}
{
  const { stats } = await run(() => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); });
  ok('cause 없으면 e.code 사용', stats.netCause, { ENOTFOUND: 1 });
}
{
  const { out, stats } = await run({ ok: false, status: 503, json: async () => ({}) });
  ok('HTTP 503 → http 계수', [out, stats.http['503']], [null, 1]);
}
{
  const { out, stats } = await run({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  ok('JSON 파싱 실패 → parse 계수', [out, stats.status['parse']], [null, 1]);
}

console.log('\n── 5. 누적과 초기화 ──');
{
  resetDartCallStats();
  queue = [asJson({ status: '013' })];
  await fetchDartCompanyInfo('1', 'k');
  await fetchDartCompanyInfo('2', 'k');
  ok('같은 원인 누적', dartCallStats.status['013'], 2);
  // 실행별 계수여야 한다 — 초기화가 안 되면 이전 실행의 차단이 다음 실행을 즉시 끊는다.
  resetDartCallStats();
  ok('reset 후 비워짐', [dartCallStats.ok, dartCallStats.network, dartCallStats.status, dartCallStats.netCause], [0, 0, {}, {}]);
  ok('reset 후 차단 없음', dartBlockedBy(), []);
}

console.log('\n── 6. 스냅샷은 복사본 ──');
{
  // 결과 객체에 실어 보낸 뒤 다음 실행이 계수기를 건드려도 과거 결과가 바뀌면 안 된다.
  resetDartCallStats();
  queue = [asJson({ status: '020' })];
  await fetchDartCompanyInfo('1', 'k');
  const snap = snapshotDartCallStats();
  await fetchDartCompanyInfo('2', 'k');
  ok('스냅샷 고정', [snap.status['020'], dartCallStats.status['020']], [1, 2]);
}

globalThis.fetch = realFetch;
console.log(`\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
