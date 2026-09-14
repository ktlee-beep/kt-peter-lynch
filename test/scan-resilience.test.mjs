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

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
