// 스캔 무음 실패 방지 검증 (실행: node test/scan-resilience.test.mjs)
//
// 겨냥하는 실제 사고:
//  1) db.js 의 쓰기 경로들이 supabase-js 의 { error } 를 읽지 않아, 저장이 통째로
//     실패해도 로그 한 줄 없이 "성공"으로 지나갔다. 특히 신규 컬럼 추가 직후
//     PostgREST 스키마 캐시가 낡으면 PGRST204 로 요청 전체가 실패한다.
//  2) 프로세스가 스캔 도중 사라지면 completeScanBatch 가 실행되지 않아 배치 행이
//     영원히 running 으로 남는다 (2026-09-14 실측: 870/1116 에서 동결).
//
// 실제 HTTP 를 내지 않도록 global fetch 를 가로챈다.

const calls = [];
let responder = () => ({ status: 200, body: [] });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const method = (init.method || 'GET').toUpperCase();
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
  const call = { url, method, body, headers: init.headers || {} };
  calls.push(call);
  const r = responder(call) || { status: 200, body: [] };
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: String(r.status),
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(r.body ?? []),
    json: async () => r.body ?? [],
  };
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

const db = await import('../db.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${name.padEnd(52)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  good ? pass++ : fail++;
};

const reset = (fn) => { calls.length = 0; responder = fn || (() => ({ status: 200, body: [] })); };

// PostgREST 오류 응답 모양
const pgErr = (code, message) => ({ status: 400, body: { code, message, details: null, hint: null } });

const ROW = { code: '005930', analysis_date: '2026-09-14', signal: 'BUY' };

// ── 1. batchSaveAnalysis — 야간 스캔의 전량 손실 경로 ──
console.log('=== 1. batchSaveAnalysis 오류 노출 ===');

reset(() => pgErr('PGRST204', "Could not find the 'composite_score' column of 'kt_daily_analysis' in the schema cache"));
let thrown = null;
try { await db.batchSaveAnalysis([ROW, ROW]); } catch (e) { thrown = e; }
ok('PGRST204 에 throw 한다', thrown !== null, true);
ok('행 수를 메시지에 담는다', /2행/.test(thrown?.message ?? ''), true);
ok('오류 코드를 메시지에 담는다', /PGRST204/.test(thrown?.message ?? ''), true);

reset(() => ({ status: 201, body: [] }));
thrown = null;
try { await db.batchSaveAnalysis([ROW]); } catch (e) { thrown = e; }
ok('정상 응답에는 throw 하지 않는다', thrown, null);
ok('정상 경로는 요청 1회', calls.length, 1);
ok('upsert 는 POST 다', calls[0]?.method, 'POST');

reset();
await db.batchSaveAnalysis([]);
ok('빈 배열은 네트워크를 타지 않는다', calls.length, 0);

// ── 2. createScanBatch — 배치 행 없이 "성공"하던 경로 ──
console.log('\n=== 2. createScanBatch 오류 노출 ===');

reset((c) => (c.method === 'PATCH' ? { status: 200, body: [] } : pgErr('23505', 'duplicate key value')));
thrown = null;
try { await db.createScanBatch('2026-09-14-abc123', 1116); } catch (e) { thrown = e; }
ok('insert 실패 시 throw 한다', thrown !== null, true);
ok('batch_id 를 메시지에 담는다', /2026-09-14-abc123/.test(thrown?.message ?? ''), true);

// ── 3. markStaleBatches — 죽은 배치 자가치유 ──
console.log('\n=== 3. markStaleBatches ===');

reset((c) => (c.method === 'PATCH'
  ? { status: 200, body: [{ batch_id: '2026-09-13-dead01' }, { batch_id: '2026-09-14-dead02' }] }
  : { status: 200, body: [] }));
const staled = await db.markStaleBatches();
const patch = calls.find(c => c.method === 'PATCH');
ok('정리된 건수를 돌려준다', staled, 2);
ok('PATCH 로 나간다', patch?.method, 'PATCH');
ok("status='stale' 로 바꾼다", patch?.body?.status, 'stale');
ok('running 만 고른다', /status=eq\.running/.test(patch?.url ?? ''), true);
ok('started_at 하한을 건다', /started_at=lt\./.test(patch?.url ?? ''), true);
ok('kt_scan_batches 를 친다', /kt_scan_batches/.test(patch?.url ?? ''), true);

reset((c) => (c.method === 'PATCH' ? pgErr('42703', 'column does not exist') : { status: 200, body: [] }));
thrown = null;
let staledOnErr = null;
try { staledOnErr = await db.markStaleBatches(); } catch (e) { thrown = e; }
ok('정리 실패는 throw 하지 않는다', thrown, null);
ok('정리 실패 시 0 을 돌려준다', staledOnErr, 0);

// createScanBatch 가 정리를 먼저 부른다 — 이게 빠지면 죽은 배치가 영원히 남는다
reset((c) => ({ status: c.method === 'PATCH' ? 200 : 201, body: [] }));
await db.createScanBatch('2026-09-15-xyz789', 1116);
ok('createScanBatch 가 정리를 선행한다', calls[0]?.method, 'PATCH');
ok('정리 후 insert 한다', calls.some(c => c.method === 'POST'), true);

// ── 4. saveAnalysisToDB — 온디맨드는 삼키되 조용하지 않게 ──
console.log('\n=== 4. saveAnalysisToDB 는 throw 하지 않는다 ===');

const errLog = [];
const origErr = console.error;
console.error = (...a) => { errLog.push(a.join(' ')); };
reset((c) => (c.method === 'GET' ? { status: 200, body: [] } : pgErr('PGRST204', 'schema cache miss')));
thrown = null;
try { await db.saveAnalysisToDB('005930', { combinedSignal: { signal: 'BUY', confidence: 70 } }); }
catch (e) { thrown = e; }
console.error = origErr;
ok('사용자 응답을 깨지 않는다 (throw 없음)', thrown, null);
ok('대신 로그를 남긴다', errLog.some(l => /온디맨드 저장 실패/.test(l)), true);
ok('로그에 종목코드가 있다', errLog.some(l => /005930/.test(l)), true);

// ── 5. singleFlight — 중복 트리거 가드 ──
// daily-cron.yml 이 11:00 UTC 에 POST /api/scan/trigger 를 치고 cron.js 의 node-cron 도
// 같은 11:00 UTC 에 돈다. 가드가 없으면 1116 종목 스캔 두 개가 동시에 돈다.
console.log('\n=== 5. singleFlight 중복 트리거 가드 ===');

const { singleFlight, withTimeout } = await import('../cron.js');

const origWarn = console.warn;
console.warn = () => {};

let runs = 0;
let release;
const blocker = new Promise(r => { release = r; });
const gate = singleFlight('테스트 작업');
const job = async () => { runs++; await blocker; return 'done'; };

const p1 = gate(job);
const p2 = gate(job);
const p3 = gate(job);
ok('동시 호출 3회에 실제 실행은 1회', runs, 1);
ok('두 번째 호출은 같은 프라미스를 돌려준다', p2 === p1, true);
ok('세 번째 호출도 같은 프라미스', p3 === p1, true);

release('done');
ok('합류한 호출도 같은 결과를 받는다', await Promise.all([p1, p2, p3]), ['done', 'done', 'done']);

// 끝난 뒤에는 다시 돌 수 있어야 한다 — 안 그러면 다음 날 스캔이 영영 안 뜬다
await gate(async () => { runs++; });
ok('완료 후에는 재실행된다', runs, 2);

// 실패해도 잠기지 않아야 한다
let boom = null;
try { await gate(async () => { runs++; throw new Error('실패'); }); } catch (e) { boom = e.message; }
ok('실패는 호출부로 전달된다', boom, '실패');
await gate(async () => { runs++; });
ok('실패 후에도 잠기지 않는다', runs, 4);

console.warn = origWarn;

// ── 6. withTimeout — 청크 경계 동결 차단 ──
// 종목 하나가 영영 settle 하지 않으면 Promise.allSettled 가 영영 resolve 하지 않는다.
// batch 2026-09-14-bxg4xo 가 870 = 29 x CHUNK_SIZE 30 에서 멈춘 모양이 바로 이것이다.
console.log('\n=== 6. withTimeout 청크 동결 차단 ===');

ok('정상 완료는 그대로 통과', await withTimeout(1000, 'x', Promise.resolve('v')), 'v');

let toErr = null;
try { await withTimeout(30, '005930', new Promise(() => {})); } catch (e) { toErr = e.message; }
ok('영영 안 끝나는 프라미스를 끊는다', toErr !== null, true);
ok('타임아웃 메시지에 종목코드', /005930/.test(toErr ?? ''), true);

let rejErr = null;
try { await withTimeout(1000, 'y', Promise.reject(new Error('원래 오류'))); } catch (e) { rejErr = e.message; }
ok('원래 거부 사유를 가리지 않는다', rejErr, '원래 오류');

// 행 자체가 멈추지 않는 것이 핵심 — allSettled 가 끝나고 rejected 는 실패로 집계된다
const settled = await Promise.allSettled([
  withTimeout(30, 'a', new Promise(() => {})),
  withTimeout(1000, 'b', Promise.resolve(1)),
]);
ok('멈춘 종목이 있어도 청크는 진행된다', settled.map(r => r.status), ['rejected', 'fulfilled']);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
