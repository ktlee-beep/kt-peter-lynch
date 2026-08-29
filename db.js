// KT Trading — Supabase DB 헬퍼
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import ws from 'ws'; // Node.js 18 WebSocket 지원

const BCRYPT_ROUNDS = 12;

let _supabase = null;

export function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        realtime: { transport: ws }, // Node.js 18 호환
        global: { headers: { 'x-client-info': 'kt-trading-node' } },
      }
    );
  }
  return _supabase;
}

// 온디맨드 분석이 그날의 크론 결과를 덮어쓸 때, 크론에만 있는 필드를 살려서 합친다.
// analysis_json은 통 blob이고 PK가 (code, analysis_date)라 upsert 한 번이면 통째로 교체된다.
// 온디맨드 경로(analyzeStock)는 park·matrixZone·growth를 만들지 않으므로, 관심종목 화면을
// 여는 것만으로 그날의 박세익 데이터가 사라진다. 화면 조회가 스크리너 결과를 지우는 셈이다.
// 지우는 대신 "온디맨드 결과에 없는 키만" 기존 값에서 이어받는다 —
// 온디맨드가 실제로 계산한 값(주가·지표)은 최신이므로 그대로 이긴다.
async function mergeStoredAnalysis(sb, code, date, result) {
  try {
    const { data } = await sb.from('kt_daily_analysis')
      .select('analysis_json').eq('code', code).eq('analysis_date', date).maybeSingle();
    if (!data?.analysis_json) return result;
    const prev = JSON.parse(data.analysis_json);
    if (!prev || typeof prev !== 'object') return result;
    const merged = { ...result };
    for (const k of Object.keys(prev)) if (merged[k] === undefined) merged[k] = prev[k];
    return merged;
  } catch {
    // 병합 실패가 저장 자체를 막으면 안 된다 — 최신 지표를 잃는 쪽이 더 나쁘다.
    return result;
  }
}

// 분석 결과 저장 (ON CONFLICT → upsert)
export async function saveAnalysisToDB(code, result) {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const stored = await mergeStoredAnalysis(sb, code, today, result);
  try {
    await sb.from('kt_daily_analysis').upsert({
      code,
      analysis_date:    today,
      signal:           result.combinedSignal?.signal   ?? 'HOLD',
      confidence:       result.combinedSignal?.confidence ?? 0,
      lynch_score:      result.pScore   ?? 0,
      livermore_score:  result.lScore   ?? 0,
      piotroski_score:  result.fScore?.score ?? 0,
      combined_score:   Math.round(((result.pScore ?? 0) + (result.lScore ?? 0)) / 2),
      rsi:              result.rsi      ?? null,
      macd_cross:       result.macd?.lastCross ?? null,
      close_price:      result.close    ?? null,
      change_rate:      result.changeRate ?? null,
      vol_ratio:        result.volRatio  ?? null,
      analysis_json:    JSON.stringify(stored),
      data_source:      'on-demand',
    }, { onConflict: 'code,analysis_date' });
  } catch {}
}

// 스캔 결과 조회
export async function getScanResults({ date, signal = 'BUY', limit = 100 }) {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const targetDate = date || today;
  const { data, error } = await sb
    .from('kt_daily_analysis')
    .select(`
      code, signal, confidence,
      lynch_score, livermore_score, piotroski_score, combined_score,
      rsi, macd_cross, close_price, change_rate, vol_ratio,
      kt_stocks (name, market, sector)
    `)
    .eq('analysis_date', targetDate)
    .eq('signal', signal)
    .order('confidence', { ascending: false })
    .limit(Math.min(limit, 500));
  if (error) {
    if (error.message?.includes('schema cache') || error.code === 'PGRST200') return [];
    throw error;
  }
  return data?.map(r => ({
    ...r,
    name:   r.kt_stocks?.name,
    market: r.kt_stocks?.market,
    sector: r.kt_stocks?.sector,
    kt_stocks: undefined,
  })) ?? [];
}

// 스캔 상태 조회
export async function getScanStatus() {
  const sb = getSupabase();
  const { data } = await sb
    .from('kt_scan_batches')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

// 종목 분석 이력
export async function getStockHistory(code, from, to) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('kt_daily_analysis')
    .select('analysis_date, signal, confidence, lynch_score, livermore_score, combined_score, rsi, macd_cross, close_price, change_rate')
    .eq('code', code)
    .gte('analysis_date', from || '2025-01-01')
    .lte('analysis_date', to   || new Date().toISOString().slice(0, 10))
    .order('analysis_date', { ascending: false })
    .limit(365);
  if (error) {
    if (error.message?.includes('schema cache') || error.code === 'PGRST200') return [];
    throw error;
  }
  return data ?? [];
}

// 매크로 스냅샷 저장
export async function saveMacroSnapshot(data) {
  const sb = getSupabase();
  try {
    await sb.from('kt_macro_snapshots').insert({
      usdkrw:   data.usdkrw ?? null,
      kospi:    data.kospi  ?? null,
      kosdaq:   data.kosdaq ?? null,
      vix:      data.vix    ?? null,
      us10y:    data.us10y  ?? null,
      raw_json: JSON.stringify(data),
    });
  } catch {}
}

// 매크로 이력 조회
export async function getMacroHistory() {
  const sb = getSupabase();
  const { data } = await sb
    .from('kt_macro_snapshots')
    .select('snapshot_at, usdkrw, kospi, kosdaq, vix, us10y')
    .order('snapshot_at', { ascending: false })
    .limit(48);
  return data ?? [];
}

// ── 앱 사용자 관리 ────────────────────────────────────────────────
// 구형 SHA-256 해시 — 롤링 마이그레이션 판별용으로만 유지
function legacyHash(p) {
  return createHash('sha256').update(p + 'kt-trading-2025-salt').digest('hex');
}

export async function validateAppUser(email, password) {
  const sb = getSupabase();
  const { data: user } = await sb.from('app_users')
    .select('email, role, password_hash')
    .eq('email', email.toLowerCase())
    .single();
  if (!user) return null;

  const stored = user.password_hash;
  let valid = false;

  if (stored.startsWith('$2b$') || stored.startsWith('$2a$')) {
    // bcrypt 해시
    valid = await bcrypt.compare(password, stored);
  } else {
    // 구형 SHA-256 → 일치 시 bcrypt로 자동 업그레이드
    valid = stored === legacyHash(password);
    if (valid) {
      const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      sb.from('app_users').update({ password_hash: newHash })
        .eq('email', email.toLowerCase()).catch(() => {});
      console.log(`[auth] ${email.replace(/^(.{3}).*@/, '$1***@')} 비밀번호 bcrypt 업그레이드 완료`);
    }
  }

  if (!valid) return null;

  // 마지막 로그인 갱신 (비동기, 오류 무시)
  sb.from('app_users').update({ last_login: new Date().toISOString() })
    .eq('email', email.toLowerCase()).catch(() => {});

  return { email: user.email, role: user.role };
}

export async function getAppUsers() {
  const sb = getSupabase();
  const { data } = await sb.from('app_users')
    .select('email, role, memo, created_at, last_login')
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function createAppUser(email, password, role = 'user', memo = '') {
  const sb = getSupabase();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { data, error } = await sb.from('app_users')
    .upsert({ email: email.toLowerCase(), password_hash: hash, role, memo },
             { onConflict: 'email' })
    .select('email, role, memo, created_at')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteAppUser(email) {
  const sb = getSupabase();
  const { error } = await sb.from('app_users').delete().eq('email', email.toLowerCase());
  if (error) throw error;
}

export async function updateAppUserPassword(email, newPassword) {
  const sb = getSupabase();
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const { error } = await sb.from('app_users')
    .update({ password_hash: hash })
    .eq('email', email.toLowerCase());
  if (error) throw error;
}

// 이메일이 이미 가입되어 있는지 확인
export async function appUserExists(email) {
  const sb = getSupabase();
  const { data } = await sb.from('app_users')
    .select('email')
    .eq('email', email.toLowerCase())
    .single();
  return !!data;
}

// 이미 해시된 비밀번호로 계정 생성 (이메일 인증 완료 후 사용 — 재해시 방지)
export async function createAppUserWithHash(email, passwordHash, role = 'user', memo = '') {
  const sb = getSupabase();
  const { data, error } = await sb.from('app_users')
    .insert({ email: email.toLowerCase(), password_hash: passwordHash, role, memo })
    .select('email, role, created_at')
    .single();
  if (error) throw error;
  return data;
}

// ── 이메일 인증 코드 관리 ─────────────────────────────────────────
// 인증코드 발급/재발급 (이메일당 1건, 재요청 시 갱신). code·password는 평문 입력 → 내부에서 bcrypt.
export async function upsertEmailVerification({ email, code, password, role = 'user', ttlMinutes = 10 }) {
  const sb = getSupabase();
  const codeHash     = await bcrypt.hash(String(code), BCRYPT_ROUNDS);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const expires_at   = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  const { error } = await sb.from('email_verifications')
    .upsert({
      email: email.toLowerCase(),
      code_hash: codeHash,
      password_hash: passwordHash,
      role,
      attempts: 0,
      expires_at,
      created_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  if (error) throw error;
}

export async function getEmailVerification(email) {
  const sb = getSupabase();
  const { data } = await sb.from('email_verifications')
    .select('email, code_hash, password_hash, role, attempts, expires_at')
    .eq('email', email.toLowerCase())
    .single();
  return data || null;
}

// 입력 코드가 저장된 해시와 일치하는지 검증
export async function verifyEmailCode(codeHash, inputCode) {
  return bcrypt.compare(String(inputCode).trim(), codeHash);
}

// 인증 실패 시도 횟수 +1, 갱신된 횟수 반환
export async function incrementVerificationAttempts(email) {
  const sb = getSupabase();
  const rec = await getEmailVerification(email);
  const next = (rec?.attempts ?? 0) + 1;
  await sb.from('email_verifications')
    .update({ attempts: next })
    .eq('email', email.toLowerCase());
  return next;
}

export async function deleteEmailVerification(email) {
  const sb = getSupabase();
  await sb.from('email_verifications').delete().eq('email', email.toLowerCase());
}

// 페이지 단위 재시도 간격(ms). 이게 없으면 3,900종목 백필 도중 페이지 한 장이 실패하는
// 것만으로 이미 받아둔 수천 행을 버리고 처음부터 다시 돈다.
//
// 한 번만 재시도한다. postgrest-js 2.105.4가 GET에 대해 이미 3회(1s/2s/4s) 자동 재시도를
// 하기 때문이다 — 여기서 3회를 더 걸면 페이지 한 장에 최대 16요청 30초가 되고, 백필이
// listFreshKvCodes를 3개 병렬로 띄우므로 DB 장애 시 크론이 그만큼 매달린다(2026-08-29 실측).
// 라이브러리 재시도가 흡수하지 못하는 구간(연속 4회 이상, 그리고 라이브러리가 대상으로
// 삼지 않는 503·520 외 오류)만 여기서 한 번 더 받는다. 최악 예산은 페이지당 8요청·약 15초다.
const PAGE_RETRY_DELAYS = [500];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// PostgREST 전체 페이지 순회 공용 루틴 (keyset 방식).
// 서버는 db-max-rows로 응답 행수를 잘라도 경고를 주지 않는다. "요청한 만큼 안 왔으면
// 마지막 페이지"라는 판정은 상한이 PAGE보다 낮은 순간 첫 페이지에서 참이 되어 그 지점부터
// 통째로 잘린다. 받은 만큼만 전진하고 빈 페이지에서만 멈추면 서버 상한이 얼마든 결과가 같다.
//
// 전진은 OFFSET이 아니라 마지막 행의 정렬 키를 커서로 삼는다(keyset). OFFSET은 정렬이
// 있어도 페이지 사이에 앞쪽 행이 삭제되면 뒤쪽이 앞으로 당겨져 그만큼 건너뛰고,
// 서버가 매 페이지 offset 행을 세고 버려야 해서 뒤로 갈수록 느려진다. `code > cursor`는
// 인덱스 탐색 한 번이고, 재시도로 같은 페이지를 다시 요청해도 결과가 같다(멱등).
// orderBy는 필수이며 유니크 컬럼이어야 한다 — 값이 중복되면 gt가 동률 행을 통째로 건너뛴다.
// orderBy 컬럼은 select 목록에 반드시 포함돼야 한다(커서를 뽑아야 하므로).
// build()는 호출할 때마다 새 쿼리 빌더를 반환해야 한다 — postgrest-js 빌더는 1회용이다.
async function fetchAllPages(build, { orderBy, page = 500, maxPages = 500, label = 'query' }) {
  const out = [];
  let cursor = null;
  for (let p = 0; ; p++) {
    if (p >= maxPages) throw new Error(`${label} 페이지 상한 ${maxPages} 초과 — 서버 반환 상한 확인 필요`);

    let data = null, lastErr = null;
    for (let attempt = 0; ; attempt++) {
      // .gt()를 .order() 앞에 붙인다. 런타임에서는 순서가 무관하지만(postgrest-js의
      // order()는 this를 그대로 돌려주고 FilterBuilder가 TransformBuilder를 상속한다),
      // 타입 선언상으로는 order() 반환형에 필터 메서드가 없다 — 나중에 타입체크를 켤 때
      // 이 줄만 깨지는 일을 피한다.
      let q = build();
      if (cursor !== null) q = q.gt(orderBy, cursor);
      const res = await q.order(orderBy, { ascending: true }).limit(page)
        .then(r => r, e => ({ data: null, error: { message: e?.message || String(e) } }));
      if (!res.error) { data = res.data; lastErr = null; break; }
      lastErr = res.error;
      if (attempt >= PAGE_RETRY_DELAYS.length) break;
      await sleep(PAGE_RETRY_DELAYS[attempt]);
    }
    if (lastErr) {
      throw new Error(`${label} 페이지 조회 실패(재시도 ${PAGE_RETRY_DELAYS.length}회): ${lastErr.message}`);
    }

    if (!data?.length) break;
    // push(...data)로 펼치지 않는다 — 인자 개수 한도가 있어 page를 크게 넘기면 RangeError가 난다.
    for (const row of data) out.push(row);
    const next = data[data.length - 1]?.[orderBy];
    // 커서를 못 뽑으면 다음 페이지가 첫 페이지와 같아져 무한 루프가 된다. 조용히 도는 대신 끊는다.
    if (next === undefined || next === null) {
      throw new Error(`${label}: 정렬 키 '${orderBy}'가 응답에 없어 keyset 순회 불가 — select 목록 확인`);
    }
    cursor = next;
  }
  return out;
}

// 활성 종목 목록 (스캔용)
// 정렬 키를 market+code에서 code 단독으로 바꿨다. 페이지네이션의 안전성은 정렬이
// 전순서(total order)일 때만 성립하는데 market은 중복이 많아 타이 구간에서 순서가 흔들린다.
// code는 PK라 전순서다. 스캔 순서만 달라지고 대상 집합은 같다.
// 예외를 삼키지 않는다 — 호출부(runDailyScan·runFundamentalsBackfill)가 이미
// catch 후 하드코딩 유니버스로 폴백한다. 여기서 []를 반환하면 "종목 없음"과
// "조회 실패"가 구분되지 않는다.
export async function getActiveStocks() {
  const sb = getSupabase();
  return fetchAllPages(
    () => sb.from('kt_stocks').select('code, yahoo_suffix').eq('is_active', 1),
    { orderBy: 'code', label: 'getActiveStocks' },
  );
}

// 종목 마스터 전체 (유니버스 갱신 시 이탈 종목 계산용)
export async function listAllStocks() {
  const sb = getSupabase();
  return fetchAllPages(
    // market이 필요하다 — 이탈 상한을 시장별로도 걸려면 기존 활성 종목의 시장 구분이 있어야 한다.
    () => sb.from('kt_stocks').select('code, market, is_active'),
    { orderBy: 'code', label: 'listAllStocks' },
  );
}

// 종목 마스터 일괄 upsert.
// payload에 없는 컬럼(sector·created_at)은 PostgREST의 ON CONFLICT SET 목록에 들어가지
// 않으므로 기존 값이 보존된다. 단 모든 행의 키 구성이 같아야 한다(PostgREST 제약).
export async function upsertStocks(rows) {
  if (!rows?.length) return 0;
  const sb = getSupabase();
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // count로 실제 반영 행수를 받는다. chunk.length는 "보낸 수"라서 서버가 일부만 처리해도
    // 성공처럼 보고된다 — 상태 API의 숫자가 실제와 다르면 사고를 눈으로 못 잡는다.
    const { error, count } = await sb.from('kt_stocks').upsert(chunk, { onConflict: 'code', count: 'exact' });
    if (error) throw new Error(`kt_stocks upsert 실패: ${error.message}`);
    n += count ?? chunk.length;
  }
  return n;
}

// 유니버스에서 빠진 종목은 삭제하지 않고 비활성화한다.
// kt_daily_analysis.code가 kt_stocks를 참조하므로 삭제하면 과거 분석 이력이 통째로 끊긴다.
export async function deactivateStocks(codes) {
  if (!codes?.length) return 0;
  const sb = getSupabase();
  let n = 0;
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const { error, count } = await sb.from('kt_stocks')
      .update({ is_active: 0 }, { count: 'exact' }).in('code', chunk);
    if (error) throw new Error(`kt_stocks 비활성화 실패: ${error.message}`);
    n += count ?? chunk.length;
  }
  return n;
}

// 배치 시작 기록
export async function createScanBatch(batchId, totalStocks) {
  const sb = getSupabase();
  await sb.from('kt_scan_batches').insert({
    batch_id:     batchId,
    scan_type:    'daily',
    total_stocks: totalStocks,
    status:       'running',
  });
}

// 배치 진행 업데이트
export async function updateScanBatch(batchId, processed, failed, buySignals) {
  const sb = getSupabase();
  // supabase-js rpc는 Postgres 오류 시 reject가 아닌 { error } resolve이므로
  // .catch() 폴백은 실행되지 않는다 — error 필드를 직접 확인해 폴백
  const { error } = await sb.rpc('kt_increment_batch', {
    p_batch_id:   batchId,
    p_processed:  processed,
    p_failed:     failed,
    p_buy:        buySignals,
  });
  if (error) {
    const { data } = await sb.from('kt_scan_batches').select('processed, failed, buy_signals').eq('batch_id', batchId).single();
    if (data) {
      await sb.from('kt_scan_batches').update({
        processed:   (data.processed   || 0) + processed,
        failed:      (data.failed      || 0) + failed,
        buy_signals: (data.buy_signals || 0) + buySignals,
      }).eq('batch_id', batchId);
    }
  }
}

// 배치 완료 처리
export async function completeScanBatch(batchId) {
  const sb = getSupabase();
  await sb.from('kt_scan_batches').update({
    status:       'done',
    completed_at: new Date().toISOString(),
  }).eq('batch_id', batchId);
}

// 분석 결과 배치 저장 (스캔 전용)
export async function batchSaveAnalysis(rows) {
  if (!rows.length) return;
  const sb = getSupabase();
  await sb.from('kt_daily_analysis').upsert(rows, { onConflict: 'code,analysis_date' });
}

// 관심종목 조회
export async function getWatchlist(email) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('kt_watchlist')
    .select('code, name, market, added_at')
    .eq('user_email', email)
    .order('added_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// 관심종목 추가 (최대 30개)
export async function addToWatchlist(email, code, name, market) {
  const sb = getSupabase();
  const { count, error: countError } = await sb
    .from('kt_watchlist')
    .select('id', { count: 'exact', head: true })
    .eq('user_email', email);
  if (countError) throw countError;
  if (count >= 30) throw new Error('최대 30개까지 추가할 수 있습니다');
  const { data, error } = await sb
    .from('kt_watchlist')
    .upsert({ user_email: email, code, name, market }, { onConflict: 'user_email,code' })
    .select('code, name, market, added_at')
    .single();
  if (error) throw error;
  return data;
}

// 관심종목 삭제
export async function removeFromWatchlist(email, code) {
  const sb = getSupabase();
  const { error } = await sb.from('kt_watchlist').delete().eq('user_email', email).eq('code', code);
  if (error) throw error;
}

// 거래 이력 조회 (전체 또는 특정 종목)
export async function getTrades(email, code = null) {
  const sb = getSupabase();
  let q = sb.from('kt_trades').select('id, code, name, market, trade_type, shares, price, trade_date, memo, created_at')
    .eq('user_email', email).order('trade_date', { ascending: false }).order('created_at', { ascending: false });
  if (code) q = q.eq('code', code);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// 보유종목 계산 (거래 이력 집계)
export async function getHoldings(email) {
  const trades = await getTrades(email);
  const map = {};
  for (const t of trades) {
    if (!map[t.code]) map[t.code] = { code: t.code, name: t.name, market: t.market, shares: 0, totalBuyShares: 0, totalBuyCost: 0 };
    const m = map[t.code];
    if (t.trade_type === 'buy') {
      m.shares += t.shares;
      m.totalBuyShares += t.shares;
      m.totalBuyCost += t.shares * t.price;
    } else {
      m.shares -= t.shares;
    }
  }
  return Object.values(map)
    .filter(h => h.shares > 0)
    .map(h => ({
      code: h.code, name: h.name, market: h.market,
      shares: h.shares,
      avgPrice: h.totalBuyShares > 0 ? Math.round(h.totalBuyCost / h.totalBuyShares) : 0,
    }));
}

// 거래 추가
export async function addTrade(email, { code, name, market, trade_type, shares, price, trade_date, memo }) {
  const sb = getSupabase();
  const { data, error } = await sb.from('kt_trades').insert({
    user_email: email, code, name, market: market || '', trade_type,
    shares: parseInt(shares), price: parseInt(price),
    trade_date, memo: memo || '',
  }).select('id, code, name, market, trade_type, shares, price, trade_date, memo, created_at').single();
  if (error) throw error;
  return data;
}

// 거래 삭제 (당일 취소)
export async function deleteTrade(email, id) {
  const sb = getSupabase();
  const { error } = await sb.from('kt_trades').delete().eq('id', id).eq('user_email', email);
  if (error) throw error;
}

// ── Thesis ────────────────────────────────────────────────────────
export async function getThesis(email, code) {
  const sb = getSupabase();
  const { data, error } = await sb.from('kt_thesis')
    .select('*').eq('user_email', email).eq('code', code).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function upsertThesis(email, { code, name, story, growth, valuation, exit_plan }) {
  const sb = getSupabase();
  const { data, error } = await sb.from('kt_thesis').upsert({
    user_email: email, code, name: name || '',
    story: story || '', growth: growth || '',
    valuation: valuation || '', exit_plan: exit_plan || '',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_email,code' })
    .select('*').single();
  if (error) throw error;
  return data;
}

export async function listTheses(email) {
  const sb = getSupabase();
  const { data, error } = await sb.from('kt_thesis')
    .select('code, name, updated_at')
    .eq('user_email', email)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ── 범용 KV 저장소 ─────────────────────────────────────────────────
// 기존 kt_fundamentals_cache(code TEXT PK, raw_json TEXT, updated_at) 테이블을
// 네임스페이스 키(__prefix__)로 재사용. 신규 테이블 DDL 권한이 없는 운영
// 환경(DATABASE_URL 미설정)에서도 REST만으로 동작시키기 위함. 6자리 종목코드와
// 키가 겹치지 않으므로 재무 캐시와 충돌 없음.
async function kvGet(key) {
  const sb = getSupabase();
  const { data } = await sb.from('kt_fundamentals_cache')
    .select('raw_json, updated_at').eq('code', key).maybeSingle();
  return data || null;
}
async function kvSet(key, obj) {
  const sb = getSupabase();
  await sb.from('kt_fundamentals_cache').upsert({
    code: key, raw_json: JSON.stringify(obj), updated_at: new Date().toISOString(),
  }, { onConflict: 'code' });
}

// ── 앱 설정 (KV) — Render 환경변수 없이 키 등을 DB에 보관 ──────────
export async function setAppConfig(key, value) {
  await kvSet(`__config__${key}`, { value });
}
export async function getAppConfig(key) {
  const row = await kvGet(`__config__${key}`);
  if (!row) return null;
  try { return JSON.parse(row.raw_json)?.value ?? null; } catch { return null; }
}

// ── 미국 스캔 결과 (KV 단일 블롭) ─────────────────────────────────
export async function saveUsScan(payload) { await kvSet('__us_scan__', payload); }
export async function getUsScan() {
  const row = await kvGet('__us_scan__');
  if (!row) return null;
  try { return JSON.parse(row.raw_json); } catch { return null; }
}

// ── 유니버스 메타 (시총·거래대금) ─────────────────────────────────
// kt_stocks에는 시총 컬럼이 없고 운영 DB에 DDL 권한이 없으므로 KV 블롭에 함께 남긴다.
// RS Rating(Phase 4)은 유니버스 내 백분위라 시총·거래대금을 재조회 없이 읽어야 한다.
export async function saveUniverseMeta(payload) { await kvSet('__universe__', payload); }
export async function getUniverseMeta() {
  const row = await kvGet('__universe__');
  if (!row) return null;
  try { return JSON.parse(row.raw_json); } catch { return null; }
}

// ── PER 유니버스 중앙값 (박세익 스코어 저평가 가점 기준) ──────────
// 스캔이 청크 단위로 즉시 저장하는 구조라 스캔 도중에는 전 종목 PER이 아직 모이지 않는다.
// 직전 스캔에서 구한 값을 다음 스캔이 읽는다 — 근거는 cron.js pickPerMedian 주석 참조.
export async function savePerMedian(payload) { await kvSet('__per_median__', payload); }
export async function getPerMedian() {
  const row = await kvGet('__per_median__');
  if (!row) return null;
  try { return JSON.parse(row.raw_json); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════
// Phase 4 — RS·수급·선점 알림 (전부 KV. 운영 DB에 DDL 권한이 없어 정식 테이블을 만들지 않는다)
// ══════════════════════════════════════════════════════════════════

// 지수 종가 시계열. 야후는 6개월치만 주므로 매일 덮어쓰면 RS120(≈6개월)이 경계에서 끊긴다.
// 기존 시계열에 신규분을 날짜 기준으로 병합해 누적한다 — 하루 한 번 돌면 창이 계속 늘어난다.
const INDEX_CLOSES_KEEP = 400;   // 거래일 기준 ≈19개월. RS120에 필요한 최소치의 3배 여유.

export async function getIndexCloses(indexId) {
  const row = await kvGet(`__index_closes__${indexId}`);
  if (!row) return [];
  try {
    const v = JSON.parse(row.raw_json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// incoming: [{d:'YYYYMMDD', c:number}] — 순서 무관. 반환값은 병합 후 오름차순 시계열.
// 같은 날짜가 겹치면 새 값이 이긴다(장중 스냅샷이 종가로 확정되는 경우).
export async function mergeIndexCloses(indexId, incoming) {
  const byDate = new Map();
  for (const r of await getIndexCloses(indexId)) {
    if (r?.d != null && Number.isFinite(r?.c)) byDate.set(String(r.d), Number(r.c));
  }
  for (const r of (Array.isArray(incoming) ? incoming : [])) {
    const d = String(r?.d ?? '').replace(/-/g, '');
    const c = Number(r?.c);
    if (/^\d{8}$/.test(d) && Number.isFinite(c) && c > 0) byDate.set(d, c);
  }
  const merged = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-INDEX_CLOSES_KEEP).map(([d, c]) => ({ d, c }));
  await kvSet(`__index_closes__${indexId}`, merged);
  return merged;
}

// RS 횡단면 분포(분위점 101개). 스캔이 청크 단위로 즉시 저장하는 구조라 스캔 도중에는
// 전 종목 RS가 아직 모이지 않는다 — PER 중앙값과 똑같은 사정이라 같은 해법을 쓴다.
// 직전 스캔의 분포로 오늘의 백분위를 매긴다. 하루 지연은 백분위 자체가 완만해서 무해하고,
// 지연을 없애려면 전 종목을 메모리에 모았다가 두 번째 패스를 돌아야 하는데
// Render 무료 티어 메모리로는 감당이 안 된다.
export async function saveRsDist(payload) { await kvSet('__rs_dist__', payload); }
export async function getRsDist() {
  const row = await kvGet('__rs_dist__');
  if (!row) return null;
  try { return JSON.parse(row.raw_json); } catch { return null; }
}

// 종목별 투자자 순매수 원자료(네이버 25일치). 파생 지표는 저장하지 않고 매번 계산한다 —
// 지표 정의가 바뀔 때 원자료가 남아 있어야 재계산이 되기 때문이다.
export async function getSupplyCache(code, maxDays = 3) {
  return kvGetFresh(`__supply__${code}`, maxDays);
}
export async function setSupplyCache(code, rows) {
  if (rows == null) return;
  await kvSet(`__supply__${code}`, rows);
}

// 선점 트리거 결과. alert_settings는 사용자·종목별 구독 테이블이라 "시장 전체에서 오늘
// 발동한 종목"을 담을 자리가 없다. 매일 덮어쓰는 단일 블롭으로 따로 둔다.
export async function saveSeonjeomAlerts(payload) { await kvSet('__seonjeom__', payload); }
export async function getSeonjeomAlerts() {
  const row = await kvGet('__seonjeom__');
  if (!row) return null;
  try { return JSON.parse(row.raw_json); } catch { return null; }
}

// ── DART 기업코드 매핑 (전체 상장사 code → corp_code) ─────────────
// 단일 블롭(__corpmap__)으로 저장 — 약 3,900개, ~100KB
export async function upsertCorpCodes(rows) {
  if (!rows?.length) return 0;
  const map = {};
  for (const r of rows) map[r.code] = r.corp_code;
  await kvSet('__corpmap__', map);
  return Object.keys(map).length;
}

export async function loadCorpCodeMap() {
  const row = await kvGet('__corpmap__');
  if (!row) return {};
  try { return JSON.parse(row.raw_json) || {}; } catch { return {}; }
}

// 손상된 행에 찍는 시각. 삭제하지 않고 updated_at만 과거로 밀어 "신선하지 않음"으로 만든다.
const KV_STALE_STAMP = '1970-01-01T00:00:00.000Z';

// raw_json이 깨진 행은 kvGetFresh에서는 미스(undefined)지만, listFreshKvCodes는
// updated_at만 보므로 "신선"으로 집계한다. 그래서 백필은 매번 건너뛰고 읽기는 매번 실패하는
// 영구 구멍이 된다 — TTL이 180일이면 반년간 무증상으로 남는다.
// 읽는 쪽이 손상을 발견한 그 자리에서 신선도를 떨어뜨려 다음 백필이 대상으로 잡게 한다.
// 행을 지우지 않는 이유는 원인 추적용 원본을 남기기 위해서다(어차피 다음 수집이 덮어쓴다).
//
// 진행 중인 키를 기억해 중복 발송을 막는다. 순차 읽기는 TTL 검사가 파싱보다 앞이라
// 두 번째 읽기부터 저절로 수렴하지만, 같은 키를 동시에 읽으면(예: /api/financials 동시 요청)
// 전부 아직 옛 updated_at을 보고 각자 PATCH를 쏜다 — 20 동시 읽기에 19회 발송을 실측했다.
// 결과가 같은 멱등 UPDATE라 정합성 문제는 아니지만, 쓰기 횟수가 "행당 1회"가 아니라
// "동시성만큼"이 되는 건 캐시 계층이 낼 비용이 아니다.
const kvStaleInFlight = new Set();

async function markKvStale(key) {
  if (kvStaleInFlight.has(key)) return;
  kvStaleInFlight.add(key);
  try {
    const sb = getSupabase();
    await sb.from('kt_fundamentals_cache').update({ updated_at: KV_STALE_STAMP }).eq('code', key);
  } finally {
    kvStaleInFlight.delete(key);
  }
}

// TTL 판정 + 역직렬화. 미스는 undefined, "조회했지만 데이터 없음"은 null로 구분한다 —
// 둘을 합치면 DART에 자료가 없는 종목을 매 실행마다 다시 때리게 된다.
function decodeKvRow(row, key, maxDays) {
  if (!row) return undefined;
  const ts = new Date(row.updated_at).getTime();
  if (!Number.isFinite(ts) || Date.now() - ts > maxDays * 86400000) return undefined;
  try {
    return JSON.parse(row.raw_json);
  } catch {
    markKvStale(key).catch(() => {});   // 자가치유는 부가작업 — 실패해도 읽기 결과를 바꾸지 않는다
    return undefined;
  }
}

async function kvGetFresh(key, maxDays) {
  return decodeKvRow(await kvGet(key), key, maxDays);
}

// ── DART 재무 캐시 (분기 데이터 → 기본 90일 TTL) ──────────────────
export async function getDartCache(code, maxDays = 90) {
  return kvGetFresh(`__dart__${code}`, maxDays);
}

export async function setDartCache(code, dart) {
  await kvSet(`__dart__${code}`, dart ?? null);
}

// ── 저평가 선점용 DART 확장 캐시 ──────────────────────────────────
// DART 일일 쿼터는 20,000회다. 상장사 3,930개에 종목당 최대 12회(개황 1 + 연간 5 +
// 분기 6)면 47,000회라 캐시 없이는 전종목 스캔이 한 번도 완주하지 못한다.
//
// TTL은 갱신 주기에 맞춘다. 업종코드·결산월은 사실상 안 바뀌므로 길게, 분기 실적은
// 새 보고서가 나온 뒤 한 텀 안에 반영돼야 하므로 분기(약 90일)보다 짧게 잡는다.
// 연간은 사업보고서가 3월에 한 번 갱신되지만, 365일로 두면 2월에 캐시된 종목이
// 이듬해 2월까지 직전 사업연도를 놓친다. 그래서 100일로 줄여 3월 이후 확실히 재수집한다.
//
// 이 3종 setter는 null을 기록하지 않고 no-op으로 빠진다(기존 setDartCache와 다른 점).
// null을 적재하면 TTL 동안 재시도가 막히는데, DART 일시 장애와 "정말 자료가 없는 종목"은
// 응답만으로 구별되지 않아 장애를 최대 180일 굳혀버린다. 호출부 가드에만 의존하지 않고
// 함수 자체에 정책을 박아 둔다.
//
// TTL 숫자는 아래 상수 3개가 단일 출처다. 개별 getter와 getGrowthCaches가 같은 키를 서로
// 다른 기준으로 읽으면(한쪽만 고쳤을 때) 같은 캐시가 호출 경로에 따라 신선/만료로 갈린다.
export const COMPANY_TTL_DAYS   = 180;
export const MULTIYEAR_TTL_DAYS = 100;
export const QUARTERLY_TTL_DAYS = 45;

export async function getCompanyInfoCache(code, maxDays = COMPANY_TTL_DAYS) {
  return kvGetFresh(`__company__${code}`, maxDays);
}
export async function setCompanyInfoCache(code, info) {
  if (info == null) return;
  await kvSet(`__company__${code}`, info);
}

export async function getMultiYearCache(code, maxDays = MULTIYEAR_TTL_DAYS) {
  return kvGetFresh(`__multiyear__${code}`, maxDays);
}
export async function setMultiYearCache(code, rows) {
  if (rows == null) return;
  await kvSet(`__multiyear__${code}`, rows);
}

export async function getQuarterlyCache(code, maxDays = QUARTERLY_TTL_DAYS) {
  return kvGetFresh(`__quarterly__${code}`, maxDays);
}
export async function setQuarterlyCache(code, q) {
  if (q == null) return;
  await kvSet(`__quarterly__${code}`, q);
}

// 위 3종을 한 번에 읽는다. 셋 다 같은 테이블의 다른 키일 뿐이라 .in()으로 묶으면
// 왕복이 3회에서 1회로 준다. 일일 스캔은 종목마다 이 셋을 읽으므로 3,900종목이면
// 11,700회가 3,900회가 된다 — Render 무료 티어에서 스캔 시간을 좌우하는 구간이다.
// TTL은 키마다 다르므로(위 *_TTL_DAYS 상수) 행별로 따로 판정한다.
// 조회 실패는 예외를 던지지 않고 전부 undefined로 떨어뜨린다 — 호출부는 이미
// "캐시 없음"을 정상 경로로 처리하고, 셋을 따로 읽던 시절에도 한 번의 DB 장애는
// 어차피 셋 모두를 실패시켰다.
export async function getGrowthCaches(code, opts = {}) {
  const {
    companyDays   = COMPANY_TTL_DAYS,
    multiYearDays = MULTIYEAR_TTL_DAYS,
    quarterlyDays = QUARTERLY_TTL_DAYS,
  } = opts;
  const kCompany = `__company__${code}`, kMulti = `__multiyear__${code}`, kQuarter = `__quarterly__${code}`;
  let rows = [];
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('kt_fundamentals_cache')
      .select('code, raw_json, updated_at').in('code', [kCompany, kMulti, kQuarter]);
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch {
    return { company: undefined, multiYear: undefined, quarterly: undefined };
  }
  const byKey = new Map(rows.map(r => [r.code, r]));
  return {
    company:   decodeKvRow(byKey.get(kCompany), kCompany, companyDays),
    multiYear: decodeKvRow(byKey.get(kMulti),   kMulti,   multiYearDays),
    quarterly: decodeKvRow(byKey.get(kQuarter), kQuarter, quarterlyDays),
  };
}

// 백필 진행률 표시용 — 접두사별 적재 건수
export async function countKvPrefix(prefix) {
  const sb = getSupabase();
  const { count, error } = await sb.from('kt_fundamentals_cache')
    .select('code', { count: 'exact', head: true }).like('code', `${prefix}%`);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// 접두사에 속한 키 중 TTL 이내인 것들의 종목코드 집합.
// 백필에서 종목마다 캐시를 한 건씩 조회하면 3,930종목 × 3종 = 약 1.2만 회의 왕복이 생기고,
// 그 대부분이 "이미 신선하니 건너뜀"으로 끝난다. 한 번에 받아서 메모리에서 거른다.
// PostgREST 기본 반환 상한이 1000행이라 페이지네이션이 필요하다 — 없으면 1000번째 종목부터
// 전부 미스로 보여 매 실행마다 같은 구간을 다시 수집한다.
export async function listFreshKvCodes(prefix, maxDays) {
  const sb = getSupabase();
  const cutoff = new Date(Date.now() - maxDays * 86400000).toISOString();
  const out = new Set();
  // 페이지 순회 규칙(서버 상한·ORDER BY 필요성)은 fetchAllPages 주석 참조.
  // 같은 로직을 손으로 두 번 쓰다가 getActiveStocks 쪽에 절단 결함이 남았던 전례가 있어
  // 공용 루틴으로 합쳤다.
  const rows = await fetchAllPages(
    () => sb.from('kt_fundamentals_cache').select('code').like('code', `${prefix}%`).gte('updated_at', cutoff),
    { orderBy: 'code', label: `listFreshKvCodes(${prefix})` },
  );
  for (const r of rows) {
    // LIKE의 '_'는 단일문자 와일드카드라 '__company__%'가 다른 키에도 매칭될 수 있다.
    // 현재 키 네이밍에선 충돌이 없지만, 매칭되면 slice가 엉뚱한 코드를 Set에 넣는다.
    if (!r.code.startsWith(prefix)) continue;
    out.add(r.code.slice(prefix.length));
  }
  return out;
}

// DART 재무 캐시 전체 삭제 (스코어링 로직 변경 시 강제 재수집용)
export async function clearDartCache() {
  const sb = getSupabase();
  const { error, count } = await sb.from('kt_fundamentals_cache')
    .delete({ count: 'exact' }).like('code', '__dart__%');
  if (error) throw error;
  return count ?? 0;
}

// ── 아침 브리핑 ────────────────────────────────────────────────────
// 매 영업일 08:00 KST cron이 단일 키(__morning_brief__)에 최신 1건 저장.
export async function saveMorningBrief(brief) {
  const today = new Date().toISOString().slice(0, 10);
  await kvSet('__morning_brief__', { ...brief, briefDate: today });
}

export async function getLatestMorningBrief() {
  const row = await kvGet('__morning_brief__');
  if (!row) return null;
  try {
    const brief = JSON.parse(row.raw_json);
    return { ...brief, createdAt: row.updated_at };
  } catch { return null; }
}

// 재무 캐시 조회 (fundamentals + 갱신시각)
export async function getFundamentalsCache(code) {
  const sb = getSupabase();
  const { data } = await sb
    .from('kt_fundamentals_cache')
    .select('raw_json, updated_at')
    .eq('code', code)
    .single();
  if (!data) return null;
  return { fundamentals: JSON.parse(data.raw_json), updatedAt: data.updated_at };
}

// 재무 캐시 저장/갱신
export async function upsertFundamentalsCache(code, raw) {
  const sb = getSupabase();
  await sb.from('kt_fundamentals_cache').upsert(
    { code, raw_json: JSON.stringify(raw), updated_at: new Date().toISOString() },
    { onConflict: 'code' }
  );
}

export async function setFundamentalsCache(code, fundamentals) {
  const sb = getSupabase();
  await sb.from('kt_fundamentals_cache').upsert({
    code,
    raw_json: JSON.stringify(fundamentals),
    updated_at: new Date().toISOString(),
  });
}
