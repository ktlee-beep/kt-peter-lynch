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

// 분석 결과 저장 (ON CONFLICT → upsert)
export async function saveAnalysisToDB(code, result) {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
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
      analysis_json:    JSON.stringify(result),
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

// PostgREST 전체 페이지 순회 공용 루틴.
// 서버는 db-max-rows로 응답 행수를 잘라도 경고를 주지 않는다. "요청한 만큼 안 왔으면
// 마지막 페이지"라는 판정은 상한이 PAGE보다 낮은 순간 첫 페이지에서 참이 되어 그 지점부터
// 통째로 잘린다. 받은 만큼만 전진하고 빈 페이지에서만 멈추면 서버 상한이 얼마든 결과가 같다.
// orderBy는 필수다 — 정렬 없는 OFFSET은 페이지 사이에 UPDATE가 끼면 행을 건너뛴다
// (Postgres의 UPDATE는 힙 튜플을 새 위치에 쓴다). 반드시 유니크 컬럼으로 전순서를 준다.
// build()는 호출할 때마다 새 쿼리 빌더를 반환해야 한다 — postgrest-js 빌더는 1회용이다.
async function fetchAllPages(build, { orderBy, page = 500, maxPages = 500, label = 'query' }) {
  const out = [];
  for (let from = 0, p = 0; ; p++) {
    if (p >= maxPages) throw new Error(`${label} 페이지 상한 ${maxPages} 초과 — 서버 반환 상한 확인 필요`);
    const { data, error } = await build()
      .order(orderBy, { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    // push(...data)로 펼치지 않는다 — 인자 개수 한도가 있어 page를 크게 넘기면 RangeError가 난다.
    for (const row of data) out.push(row);
    from += data.length;
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

// TTL 인지 KV 조회. 미스는 undefined, "조회했지만 데이터 없음"은 null로 구분한다 —
// 둘을 합치면 DART에 자료가 없는 종목을 매 실행마다 다시 때리게 된다.
async function kvGetFresh(key, maxDays) {
  const row = await kvGet(key);
  if (!row) return undefined;
  if (Date.now() - new Date(row.updated_at).getTime() > maxDays * 86400000) return undefined;
  try { return JSON.parse(row.raw_json); } catch { return undefined; }
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
export async function getCompanyInfoCache(code, maxDays = 180) {
  return kvGetFresh(`__company__${code}`, maxDays);
}
export async function setCompanyInfoCache(code, info) {
  if (info == null) return;
  await kvSet(`__company__${code}`, info);
}

export async function getMultiYearCache(code, maxDays = 100) {
  return kvGetFresh(`__multiyear__${code}`, maxDays);
}
export async function setMultiYearCache(code, rows) {
  if (rows == null) return;
  await kvSet(`__multiyear__${code}`, rows);
}

export async function getQuarterlyCache(code, maxDays = 45) {
  return kvGetFresh(`__quarterly__${code}`, maxDays);
}
export async function setQuarterlyCache(code, q) {
  if (q == null) return;
  await kvSet(`__quarterly__${code}`, q);
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
