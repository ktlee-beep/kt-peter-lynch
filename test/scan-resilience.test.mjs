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
  if (r.hang) return new Promise(() => {});   // 응답이 영영 안 오는 DB
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: String(r.status),
    // r.headers 는 소문자 키 (예: count 조회의 content-range)
    headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    // r.raw 는 본문 문자열 그대로 (예: 본문 없는 HEAD 오류 응답 '')
    text: async () => r.raw ?? JSON.stringify(r.body ?? []),
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

// ── 7. 같은 종가 중복 스캔 가드 ──
// GitHub schedule 이 9시간 늦게 도착한 실측(10-12 20:00 KST 예정 → 10-13 05:04 실행)이 있다.
// PC 신호로 20:00 스캔이 이미 끝났는데 새벽에 같은 종가로 처음부터 다시 돌면 안 된다.
console.log('\n=== 7. 중복 스캔 가드 ===');

const cut = (iso) => db.lastScanCutoffUtc(new Date(iso)).toISOString();
ok('화 20:00 KST → 화 18:00', cut('2026-10-13T11:00:00Z'), '2026-10-13T09:00:00.000Z');
ok('화 05:04 KST(늦은 schedule) → 월 18:00', cut('2026-10-12T20:04:00Z'), '2026-10-12T09:00:00.000Z');
ok('화 17:59 KST → 월 18:00', cut('2026-10-13T08:59:00Z'), '2026-10-12T09:00:00.000Z');
ok('화 18:00 KST 정각 → 화 18:00', cut('2026-10-13T09:00:00Z'), '2026-10-13T09:00:00.000Z');
ok('월 08:00 KST → 금 18:00', cut('2026-10-11T23:00:00Z'), '2026-10-09T09:00:00.000Z');
ok('월 18:30 KST → 월 18:00', cut('2026-10-19T09:30:00Z'), '2026-10-19T09:00:00.000Z');
ok('토 12:00 KST → 금 18:00', cut('2026-10-17T03:00:00Z'), '2026-10-16T09:00:00.000Z');
ok('일 23:00 KST → 금 18:00', cut('2026-10-18T14:00:00Z'), '2026-10-16T09:00:00.000Z');

// 배치 목록과 배치별 저장 행 수를 흉내 낸다. saved 에 없는 배치는 저장 0행.
const guardDb = (batches, saved = {}) => (c) => {
  if (c.url.includes('/kt_scan_batches')) return { status: 200, body: batches };
  if (c.url.includes('/kt_daily_analysis')) {
    const id = decodeURIComponent(c.url.match(/scan_batch_id=eq\.([^&]+)/)?.[1] ?? '');
    return { status: 200, body: null, headers: { 'content-range': `*/${saved[id] ?? 0}` } };
  }
  return { status: 200, body: [] };
};

reset(guardDb([
  { batch_id: 'b-partial', processed: 500, total_stocks: 1142 },
  { batch_id: 'b-full', processed: 1139, total_stocks: 1142 },
], { 'b-partial': 500, 'b-full': 1139 }));
const found = await db.findDailyScanDoneSinceCutoff(new Date('2026-10-12T20:04:00Z'));
const q = calls[0]?.url ?? '';
ok('성공 90% 미만 배치는 건너뛰고 완료 배치를 고른다', found?.batch_id, 'b-full');
ok('찾은 배치에 저장 행 수를 붙인다', found?.saved, 1139);
ok('done 만 본다', /status=eq\.done/.test(q), true);
ok('daily 만 본다', /scan_type=eq\.daily/.test(q), true);
ok('기준 시각(월 18:00 KST) 이후만 본다', q.includes('started_at=gte.2026-10-12T09%3A00%3A00.000Z') || q.includes('started_at=gte.2026-10-12T09:00:00.000Z'), true);
ok('최신순 5건만 본다', /order=started_at\.desc/.test(q) && /limit=5/.test(q), true);
const cq = calls.find(c => c.url.includes('/kt_daily_analysis'));
ok('저장 행은 HEAD count 로 센다 (본문을 받지 않는다)', cq?.method, 'HEAD');
ok('저장 행은 그 배치 id 로 센다', /scan_batch_id=eq\.b-full/.test(cq?.url ?? ''), true);
ok('90% 미만 배치는 저장 행을 세지도 않는다', calls.some(c => /scan_batch_id=eq\.b-partial/.test(c.url)), false);

reset(guardDb([{ batch_id: 'b-partial', processed: 500, total_stocks: 1142 }]));
ok('부분 완료뿐이면 null (다시 돌아야 한다)', await db.findDailyScanDoneSinceCutoff(), null);

reset(guardDb([{ batch_id: 'b-90', processed: 900, total_stocks: 1000 }], { 'b-90': 900 }));
ok('분석·저장 정확히 90% 는 완료', (await db.findDailyScanDoneSinceCutoff())?.batch_id, 'b-90');
reset(guardDb([{ batch_id: 'b-89', processed: 899, total_stocks: 1000 }], { 'b-89': 899 }));
ok('분석 89.9% 는 미완료', await db.findDailyScanDoneSinceCutoff(), null);
reset(guardDb([{ batch_id: 'b-s', processed: 1000, total_stocks: 1000 }], { 'b-s': 899 }));
ok('저장 89.9% 는 미완료', await db.findDailyScanDoneSinceCutoff(), null);

// processed 는 "분석 성공" 건수다 — 저장이 통째로 실패한 배치도 processed 는 꽉 찬다.
reset(guardDb([{ batch_id: 'b-nosave', processed: 1142, total_stocks: 1142 }], {}));
ok('저장이 통째로 실패한 배치는 완료로 치지 않는다', await db.findDailyScanDoneSinceCutoff(), null);

reset(guardDb([
  { batch_id: 'b-nosave', processed: 1142, total_stocks: 1142 },
  { batch_id: 'b-older', processed: 1140, total_stocks: 1142 },
], { 'b-older': 1140 }));
ok('최신 배치가 저장 실패면 그 전 완료 배치를 본다', (await db.findDailyScanDoneSinceCutoff())?.batch_id, 'b-older');

reset(guardDb([{ batch_id: 'b-fb', processed: 199, total_stocks: 199 }], { 'b-fb': 199 }));
ok('minTotal 미만(폴백 유니버스) 배치는 완료로 치지 않는다', await db.findDailyScanDoneSinceCutoff(new Date(), { minTotal: 200 }), null);

reset((c) => c.url.includes('/kt_daily_analysis') ? pgErr('42501', 'permission denied')
  : { status: 200, body: [{ batch_id: 'b-full', processed: 1139, total_stocks: 1142 }] });
let threw = null;
try { await db.findDailyScanDoneSinceCutoff(); } catch (e) { threw = e.message; }
ok('저장 행 조회가 실패하면 던진다 (조용히 완료 처리 금지)', /저장 행 확인 실패/.test(threw ?? ''), true);

// 실제 HEAD 오류는 본문이 없다 — message 가 비어도 상태 코드는 남아야 한다.
reset((c) => c.url.includes('/kt_daily_analysis') ? { status: 403, raw: '' }
  : { status: 200, body: [{ batch_id: 'b-full', processed: 1139, total_stocks: 1142 }] });
threw = null;
try { await db.findDailyScanDoneSinceCutoff(); } catch (e) { threw = e.message; }
ok('본문 없는 HEAD 오류도 상태 코드와 함께 던진다', /저장 행 확인 실패.*HTTP 403/.test(threw ?? ''), true);

// 404 + 빈 본문은 postgrest-js 가 오류 없이 count=null 로 돌려준다 — 0행으로 넘기면 안 된다.
reset((c) => c.url.includes('/kt_daily_analysis') ? { status: 404, raw: '' }
  : { status: 200, body: [{ batch_id: 'b-full', processed: 1139, total_stocks: 1142 }] });
threw = null;
try { await db.findDailyScanDoneSinceCutoff(); } catch (e) { threw = e.message; }
ok('행 수가 오지 않으면 던진다 (조용히 0행 금지)', /저장 행 확인 실패.*행 수 없음/.test(threw ?? ''), true);

// 실제 배치 id 는 분석일로 시작한다 — 그 날짜로 좁혀 인덱스를 타게 한다.
reset(guardDb([{ batch_id: '2026-10-13-ab12cd', processed: 1139, total_stocks: 1142 }], { '2026-10-13-ab12cd': 1139 }));
const dated = await db.findDailyScanDoneSinceCutoff();
const dq = calls.find(c => c.url.includes('/kt_daily_analysis'))?.url ?? '';
ok('날짜로 시작하는 배치는 찾는다', dated?.batch_id, '2026-10-13-ab12cd');
ok('저장 행 조회를 분석일로 좁힌다 (인덱스)', /analysis_date=eq\.2026-10-13/.test(dq), true);

const { runDailyScan, runNightly, dailyScanAlreadyDone, evaluateSeonjeomTriggers, runSupplyCollect } = await import('../cron.js');
console.warn = () => {};
reset(guardDb([{ batch_id: 'b-full', processed: 1139, total_stocks: 1142, started_at: 'x' }], { 'b-full': 1139 }));
ok('완료 배치가 있으면 스캔을 건너뛴다', await runDailyScan(), { skipped: true, batchId: 'b-full' });
ok('건너뛸 때 배치를 새로 만들지 않는다', calls.some(c => c.method === 'POST'), false);

reset(guardDb([{ batch_id: 'b-full', processed: 1139, total_stocks: 1142, started_at: 'x' }], { 'b-full': 1139 }));
ok('완료 배치가 있으면 야간 체인 전체를 건너뛴다', await runNightly(), { skipped: true, batchId: 'b-full' });
ok('체인을 건너뛸 때 아무것도 쓰지 않는다', calls.some(c => c.method !== 'GET' && c.method !== 'HEAD'), false);

// 하드코딩 폴백 유니버스(199종목)로 돈 배치는 dailyScanAlreadyDone 이 완료로 치지 않는다.
// 경계는 정확히 199/200 으로 본다 — 150 같은 값으로는 "+1" 이 빠져도 통과한다.
reset(guardDb([{ batch_id: 'b-fb', processed: 199, total_stocks: 199 }], { 'b-fb': 199 }));
ok('dailyScanAlreadyDone 은 폴백 크기(199) 배치를 무시한다', await dailyScanAlreadyDone(), null);
reset(guardDb([{ batch_id: 'b-200', processed: 200, total_stocks: 200 }], { 'b-200': 200 }));
ok('폴백보다 한 종목이라도 많으면 완료로 친다', (await dailyScanAlreadyDone())?.batch_id, 'b-200');

// 체인이 09:00 KST(00:00 UTC)를 넘겨도 스캔이 쓴 분석일로 판정·저장해야 한다.
const seonRows = (date) => (c) => c.url.includes('/kt_daily_analysis')
  ? { status: 200, body: [{ code: '005930', analysis_date: date, change_rate: 1, vol_ratio: 1, analysis_json: '{}' }] }
  : { status: 200, body: [] };
reset(seonRows('2026-10-13'));
await evaluateSeonjeomTriggers({ date: '2026-10-13' });
const seonWrite = calls.find(c => c.method === 'POST' || c.method === 'PATCH');
// kv 에는 raw_json 문자열로 들어가 따옴표가 한 번 더 이스케이프된다.
const seonBody = typeof seonWrite?.body === 'string' ? seonWrite.body : JSON.stringify(seonWrite?.body ?? '');
ok('선점 평가는 넘겨받은 분석일로 저장한다', /__seonjeom__/.test(seonBody) && /date\\?":\\?"2026-10-13/.test(seonBody), true);

reset(seonRows('2026-10-01'));
await evaluateSeonjeomTriggers({ date: '2026-10-13' });
ok('그 날짜 행이 없으면 선점 결과를 덮어쓰지 않는다', calls.some(c => c.method !== 'GET' && c.method !== 'HEAD'), false);

reset();
await runSupplyCollect({ date: '2026-10-13', maxFetch: 0 });
ok('수급 수집은 넘겨받은 분석일 행을 읽는다', calls.some(c => /analysis_date=eq\.2026-10-13/.test(c.url)), true);
console.warn = origWarn;

console.error = () => {};
reset(() => pgErr('42P01', 'relation does not exist'));
ok('확인 조회가 실패하면 null (스캔을 막지 않는다)', await dailyScanAlreadyDone(), null);

reset(() => ({ hang: true }));
const t0 = Date.now();
const hung = await dailyScanAlreadyDone();
ok('DB 가 응답하지 않으면 5초 뒤 null (스캔을 막지 않는다)', [hung, Date.now() - t0 >= 4900 && Date.now() - t0 < 8000], [null, true]);
console.error = origErr;

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
