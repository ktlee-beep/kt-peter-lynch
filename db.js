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
  if (error) throw error;
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
  if (error) throw error;
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
  await sb.rpc('kt_increment_batch', {
    p_batch_id:   batchId,
    p_processed:  processed,
    p_failed:     failed,
    p_buy:        buySignals,
  }).catch(async () => {
    const { data } = await sb.from('kt_scan_batches').select('processed, failed, buy_signals').eq('batch_id', batchId).single();
    if (data) {
      await sb.from('kt_scan_batches').update({
        processed:   (data.processed   || 0) + processed,
        failed:      (data.failed      || 0) + failed,
        buy_signals: (data.buy_signals || 0) + buySignals,
      }).eq('batch_id', batchId);
    }
  });
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
