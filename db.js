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

// 활성 종목 목록 (스캔용)
export async function getActiveStocks() {
  const sb = getSupabase();
  const { data } = await sb
    .from('kt_stocks')
    .select('code, yahoo_suffix')
    .eq('is_active', 1)
    .order('market')
    .order('code');
  return data ?? [];
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
  const { data } = await sb
    .from('kt_watchlist')
    .select('code, name, market, added_at')
    .eq('user_email', email)
    .order('added_at', { ascending: false });
  return data || [];
}

// 관심종목 추가 (최대 30개)
export async function addToWatchlist(email, code, name, market) {
  const sb = getSupabase();
  const { count } = await sb
    .from('kt_watchlist')
    .select('id', { count: 'exact', head: true })
    .eq('user_email', email);
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
  await sb.from('kt_watchlist').delete().eq('user_email', email).eq('code', code);
}

// 거래 이력 조회 (전체 또는 특정 종목)
export async function getTrades(email, code = null) {
  const sb = getSupabase();
  let q = sb.from('kt_trades').select('id, code, name, market, trade_type, shares, price, trade_date, memo, created_at')
    .eq('user_email', email).order('trade_date', { ascending: false }).order('created_at', { ascending: false });
  if (code) q = q.eq('code', code);
  const { data } = await q;
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
  const { data } = await sb.from('kt_thesis')
    .select('*').eq('user_email', email).eq('code', code).single();
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

// ── DART 재무 캐시 (분기 데이터 → 기본 90일 TTL) ──────────────────
export async function getDartCache(code, maxDays = 90) {
  const row = await kvGet(`__dart__${code}`);
  if (!row) return undefined;
  if (Date.now() - new Date(row.updated_at).getTime() > maxDays * 86400000) return undefined;
  try { return JSON.parse(row.raw_json); } catch { return undefined; }
}

export async function setDartCache(code, dart) {
  await kvSet(`__dart__${code}`, dart ?? null);
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

// 재무 캐시 조회
export async function getFundamentalsCache(code) {
  const sb = getSupabase();
  const { data } = await sb
    .from('kt_fundamentals_cache')
    .select('raw_json')
    .eq('code', code)
    .single();
  return data ? JSON.parse(data.raw_json) : null;
}

export async function setFundamentalsCache(code, fundamentals) {
  const sb = getSupabase();
  await sb.from('kt_fundamentals_cache').upsert({
    code,
    raw_json: JSON.stringify(fundamentals),
    updated_at: new Date().toISOString(),
  });
}
