// KT Trading API — Node.js / Express 서버
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { timingSafeEqual, createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { startCron } from './cron.js';
import { SECTOR_MAP, SECTOR_NAMES } from './sector_map.js';
import { KRX_STOCKS } from './krx_stocks.js';
import {
  calcMA, calcRSI, calcMACD, calcBollinger, calcATR, calcMDD,
  findKeyLevels, detectFreshSignals, combinedSignal, calcScore,
  calcLivermoreScore, calcLynchScore, calcCandlePatterns, calcIchimoku,
  calcStochastic, calcOBV, calcFibonacci, detectRSIDivergence, calcWilliamsR,
  calcADX, calcMFI, calcParabolicSAR, calcElderRay, calcDynamicStopLoss,
  calcPiotroski, runBacktest, koreanMarketFlags,
  analyzeNewsSentiment, SENTIMENT_POS, SENTIMENT_NEG,
  detectLeverageETF, calcVolumePriceDivergence, runBacktestMulti,
} from './analysis.js';
import {
  CORP_MAP, fetchYahooSummary, fetchDartFinancials, fetchDartMultiYear, fetchNaverFundamentals, fetchNaverInvestor,
  krxStock, naverStock, naverHistory, yahooStock,
  krxHistory, yahooHistory, isValidYahooResult,
  fetchDartDisclosures, fetchYahooNews,
  KRX_INDICES, YAHOO_SYMBOLS, fetchIndex, fetchYahooSymbol, fetchIndexOHLCV, fetchKospiFutures,
  KS_UNIVERSE, KQ_UNIVERSE, hasYearData,
} from './data.js';
import { saveAnalysisToDB, getScanResults, getScanStatus, getStockHistory, getMacroHistory, saveMacroSnapshot, validateAppUser, getAppUsers, createAppUser, deleteAppUser, updateAppUserPassword, getSupabase, getWatchlist, addToWatchlist, removeFromWatchlist, getTrades, getHoldings, addTrade, deleteTrade, getThesis, upsertThesis, listTheses, getLatestMorningBrief, getUsScan, clearDartCache, setAppConfig, getAppConfig, appUserExists, createAppUserWithHash, upsertEmailVerification, getEmailVerification, verifyEmailCode, incrementVerificationAttempts, deleteEmailVerification, loadCorpCodeMap, getMultiYearCache, setMultiYearCache, getQuarterlyCache, getCompanyInfoCache } from './db.js';
import { sendVerificationCode, isMailConfigured } from './mailer.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ── 종목명 조회 (내장 KRX 1775종목) ──────────────────────────────
const KRX_NAME_MAP = new Map(KRX_STOCKS.map(s => [s.code, s.name]));
const krxName = (code) => KRX_NAME_MAP.get(code) || null;

// ── 전역 크래시 가드 ─────────────────────────────────────────────
// 비동기 라우트에서 throw된 예외가 프로세스 전체를 죽이지 않도록 보호
// (예: Supabase env 미설정 시 getSupabase() throw → 이후 모든 조회 불능 방지)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
});

// ── 보안 헤더 ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP는 인라인 React SPA 호환 위해 비활성

// ── 로그인 Rate Limit (15분에 10회) ─────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '로그인 시도 횟수 초과. 15분 후 재시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});
// 회원가입 인증(코드 발송/검증) Rate Limit (15분에 5회)
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: '요청 횟수를 초과했습니다. 15분 후 재시도하세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// JWT_SECRET: Render 환경변수에서 반드시 설정. 미설정 시 시작 거부
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET 환경변수가 설정되지 않았습니다. Render 대시보드에서 설정하세요.');
  process.exit(1);
}
const MASTER_EMAIL    = process.env.MASTER_EMAIL || 'ktlee@enova.co.kr';
const MASTER_PASS     = process.env.MASTER_PASS;
if (!MASTER_PASS) {
  console.error('[FATAL] MASTER_PASS 환경변수가 설정되지 않았습니다. Render 대시보드에서 설정하세요.');
  process.exit(1);
}
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://kt-backend.dlrudxo002.workers.dev';

// ── 허용 이메일 목록 (env: ALLOWED_EMAILS=a@b.com,c@d.com) ────────
// 미설정 시 마스터 + DB 등록 사용자만 로그인 가능 (기본 보안)
const ALLOWED_EMAILS_RAW = process.env.ALLOWED_EMAILS || '';
const ALLOWED_EMAILS = ALLOWED_EMAILS_RAW
  ? new Set(ALLOWED_EMAILS_RAW.split(',').map(e => e.trim().toLowerCase()).filter(Boolean))
  : null; // null = 화이트리스트 비활성 (DB 등록자 전원 허용)

// ── 미들웨어 ────────────────────────────────────────────────────
const PROD_ORIGINS = [FRONTEND_ORIGIN, 'https://kt-trading-api.onrender.com', 'https://kt-peter-lynch.onrender.com'];
const DEV_ORIGINS  = [...PROD_ORIGINS, 'http://localhost:3001', 'http://127.0.0.1:5500'];
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? PROD_ORIGINS : DEV_ORIGINS,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ── 정적 파일 서빙 ───────────────────────────────────────────────
// React Vite 빌드 결과물 (public/dist) 우선, public/ 에서 login.html 등 보완
const distDir = path.join(__dirname, 'public', 'dist');
const legacyDir = path.join(__dirname, 'public');
app.use(express.static(distDir));   // Vite 빌드 출력
app.use(express.static(legacyDir)); // login.html, manifest.json 등

// ── 인메모리 캐시 (무버스, 매크로) ─────────────────────────────
const cache = {
  movers:       { data: null, ts: 0 },
  macro:        { data: null, ts: 0 },
  market:       { data: null, ts: 0 },
  geminiMarket: { data: null, ts: 0 },
  indexChart:   {},   // keyed by id, each { data, ts }
};
const CACHE_TTL_MOVERS       = 60 * 60 * 1000; // 1시간
const CACHE_TTL_MACRO        = 30 * 60 * 1000; // 30분
const CACHE_TTL_MARKET       =  5 * 60 * 1000; // 5분
const CACHE_TTL_INDEX_CHART  = 60 * 60 * 1000; // 1시간
const CACHE_TTL_GEMINI_MARKET = 4 * 60 * 60 * 1000; // 4시간 (Gemini 429 방지)

// ── 인증 미들웨어 ────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
}

// ── 인증 라우트 ──────────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, username, password } = req.body || {};
  const emailRaw = email || username || '';
  if (!emailRaw || !password)
    return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요' });

  const emailLower = emailRaw.toLowerCase().trim();
  const maskedEmail = emailLower.replace(/^(.{3}).*@/, '$1***@'); // 로그 마스킹

  // 마스터 계정 — timingSafeEqual로 타이밍 공격 방어
  const masterMatch = emailLower === MASTER_EMAIL.toLowerCase() && (() => {
    try {
      const a = Buffer.from(createHash('sha256').update(password).digest());
      const b = Buffer.from(createHash('sha256').update(MASTER_PASS).digest());
      return timingSafeEqual(a, b);
    } catch { return false; }
  })();
  if (masterMatch) {
    const token = jwt.sign({ email: MASTER_EMAIL, role: 'master' }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[login] MASTER 로그인 성공: ${maskedEmail}`);
    return res.json({ ok: true, token, role: 'master' });
  }

  // 화이트리스트 체크 (ALLOWED_EMAILS 설정 시)
  if (ALLOWED_EMAILS && !ALLOWED_EMAILS.has(emailLower)) {
    console.warn(`[login] 미허가 이메일: ${maskedEmail}`);
    return res.status(401).json({ error: '등록되지 않은 이메일입니다. 관리자에게 문의하세요.' });
  }

  // DB 사용자 검증
  try {
    const user = await validateAppUser(emailLower, password);
    if (user) {
      const token = jwt.sign({ email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
      console.log(`[login] 성공: ${maskedEmail} (role: ${user.role || 'user'})`);
      return res.json({ ok: true, token, role: user.role || 'user' });
    }
    console.warn(`[login] 인증 실패: ${maskedEmail}`);
  } catch (e) {
    console.error(`[login] DB 오류: ${e.message}`);
  }

  return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸습니다' });
});

// ── 회원가입 1단계: 이메일 인증코드 발송 ─────────────────────────
app.post('/api/auth/register/request-code', signupLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const emailLower = (email || '').toLowerCase().trim();
  const masked = emailLower.replace(/^(.{3}).*@/, '$1***@');

  if (!EMAIL_RE.test(emailLower))
    return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다' });
  if (!password || password.length < 8)
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  if (emailLower === MASTER_EMAIL.toLowerCase())
    return res.status(400).json({ error: '사용할 수 없는 이메일입니다' });
  // 화이트리스트 설정 시 미허가 이메일 가입 차단 (로그인 정책과 일치)
  if (ALLOWED_EMAILS && !ALLOWED_EMAILS.has(emailLower))
    return res.status(403).json({ error: '가입이 허용되지 않은 이메일입니다. 관리자에게 문의하세요.' });

  try {
    if (await appUserExists(emailLower))
      return res.status(409).json({ error: '이미 가입된 이메일입니다. 로그인해주세요.' });

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6자리
    await upsertEmailVerification({ email: emailLower, code, password, role: 'user', ttlMinutes: 10 });
    await sendVerificationCode(emailLower, code);
    console.log(`[signup] 인증코드 발송: ${masked}`);
    res.json({
      ok: true,
      message: '인증코드를 이메일로 발송했습니다. 10분 이내에 입력해주세요.',
      mailConfigured: isMailConfigured(),
    });
  } catch (e) {
    console.error(`[signup] request-code 오류: ${e.message}`);
    res.status(500).json({ error: '인증코드 발송 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// ── 회원가입 2단계: 인증코드 확인 → 계정 생성 + 자동 로그인 ──────
app.post('/api/auth/register/verify', signupLimiter, async (req, res) => {
  const { email, code } = req.body || {};
  const emailLower = (email || '').toLowerCase().trim();
  if (!emailLower || !code)
    return res.status(400).json({ error: '이메일과 인증코드를 입력하세요' });

  try {
    const rec = await getEmailVerification(emailLower);
    if (!rec)
      return res.status(400).json({ error: '인증 요청을 찾을 수 없습니다. 인증코드를 다시 요청해주세요.' });
    if (new Date(rec.expires_at).getTime() < Date.now()) {
      await deleteEmailVerification(emailLower);
      return res.status(400).json({ error: '인증코드가 만료되었습니다. 다시 요청해주세요.' });
    }
    if (rec.attempts >= 5) {
      await deleteEmailVerification(emailLower);
      return res.status(429).json({ error: '인증 시도 횟수를 초과했습니다. 인증코드를 다시 요청해주세요.' });
    }

    const match = await verifyEmailCode(rec.code_hash, code);
    if (!match) {
      const n = await incrementVerificationAttempts(emailLower);
      return res.status(400).json({ error: `인증코드가 일치하지 않습니다. (${Math.max(0, 5 - n)}회 남음)` });
    }

    // 인증 성공 — 계정 생성 (동시 가입 방어)
    if (await appUserExists(emailLower)) {
      await deleteEmailVerification(emailLower);
      return res.status(409).json({ error: '이미 가입된 이메일입니다. 로그인해주세요.' });
    }
    const role = rec.role || 'user';
    await createAppUserWithHash(emailLower, rec.password_hash, role);
    await deleteEmailVerification(emailLower);

    const token = jwt.sign({ email: emailLower, role }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[signup] 가입 완료: ${emailLower.replace(/^(.{3}).*@/, '$1***@')} (role: ${role})`);
    res.json({ ok: true, token, role });
  } catch (e) {
    console.error(`[signup] verify 오류: ${e.message}`);
    res.status(500).json({ error: '가입 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: { email: decoded.email, role: decoded.role } });
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
});

// ── 어드민 미들웨어 ───────────────────────────────────────────────
function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'master') return res.status(403).json({ error: '마스터 계정만 접근 가능합니다' });
  next();
}

// ── /api/migrate (일회성 스키마 초기화, JWT 불필요 — SCAN_SECRET으로 보호) ──
// SCAN_SECRET 또는 마스터 JWT 둘 중 하나로 인증 (운영 셀프서비스용)
function isScanSecretOrMaster(req) {
  const secret = req.headers['x-scan-secret'];
  if (process.env.SCAN_SECRET && secret === process.env.SCAN_SECRET) return true;
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.role === 'master';
  } catch { return false; }
}

app.post('/api/migrate', async (req, res) => {
  if (!isScanSecretOrMaster(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { default: pg } = await import('pg');
    const { Client } = pg;
    const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
    const PGURL = process.env.DATABASE_URL; // 하드코딩 제거 — DATABASE_URL 환경변수 필수
    if (!PGURL) return res.status(500).json({ error: 'DATABASE_URL 환경변수 미설정' });
    const client = new Client({ connectionString: PGURL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const fs = await import('fs');
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const stmt of statements) {
      try { await client.query(stmt); results.push({ ok: true, stmt: stmt.slice(0, 60) }); }
      catch (e) { results.push({ ok: false, stmt: stmt.slice(0, 60), err: e.message }); }
    }
    await client.end();
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/admin/init-tables (마스터 JWT + Supabase Management API) ──
// 일회성: alert_settings 테이블 미존재 시 자동 생성
app.post('/api/admin/init-tables', authMiddleware, adminMiddleware, async (req, res) => {
  const projectRef = new URL(process.env.SUPABASE_URL || 'https://x.supabase.co').hostname.split('.')[0];
  const SQL = `
CREATE TABLE IF NOT EXISTS alert_settings (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email    text NOT NULL,
  code          text NOT NULL,
  target_price  numeric,
  stop_loss     numeric,
  rsi_high      integer,
  rsi_low       integer,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_settings_user_code_key UNIQUE (user_email, code)
);`;
  try {
    // Supabase Management API (personal access token 필요)
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    if (accessToken) {
      const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ query: SQL }),
      });
      if (r.ok) return res.json({ ok: true, method: 'management_api', result: await r.json() });
      return res.status(r.status).json({ error: 'Management API 실패', status: r.status, sql: SQL });
    }
    // token 없으면 SQL 반환 (Supabase SQL Editor에서 수동 실행)
    return res.json({ ok: false, message: 'SUPABASE_ACCESS_TOKEN 미설정 — 아래 SQL을 Supabase SQL Editor에서 실행하세요', sql: SQL });
  } catch (e) {
    res.status(500).json({ error: e.message, sql: SQL });
  }
});

// ── /api/scan/trigger (수동 스캔 트리거, 내부용) ─────────────────
// 전역 authMiddleware 앞에 등록 — GitHub Actions 등 외부 CI가 JWT 없이
// x-scan-secret 헤더만으로 호출한다.
app.post('/api/scan/trigger', async (req, res) => {
  if (!isScanSecretOrMaster(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { runDailyScan } = await import('./cron.js');
  runDailyScan().catch(console.error);
  res.json({ ok: true, message: '스캔 시작됨 (비동기)' });
});

// 수동 생성 트리거 (마스터/SCAN_SECRET) — 08:00 기다리지 않고 즉시 생성
app.post('/api/brief/generate', async (req, res) => {
  if (!isScanSecretOrMaster(req)) return res.status(403).json({ error: 'Forbidden' });
  const { runMorningBrief } = await import('./cron.js');
  runMorningBrief().catch(console.error);
  res.json({ ok: true, message: '아침 브리핑 생성 시작됨 (비동기)' });
});

// 미국 스캔 수동 트리거 (마스터/SCAN_SECRET)
app.post('/api/scan/us/trigger', async (req, res) => {
  if (!isScanSecretOrMaster(req)) return res.status(403).json({ error: 'Forbidden' });
  const { runUsScan } = await import('./cron.js');
  runUsScan().catch(console.error);
  res.json({ ok: true, message: '미국 스캔 시작됨 (비동기)' });
});

// ── 펀더멘털 백필 트리거 (마스터/SCAN_SECRET) ─────────────────────
// 전 종목 1회전은 DART 쿼터 약 3일치라 HTTP 응답 안에서 끝나지 않는다.
// 비동기로 띄우고 진행 상황은 /api/backfill/fundamentals/status로 조회한다.
// 상태는 프로세스 메모리에만 둔다 — Render 재시작 시 사라지지만 진짜 진행률은
// 캐시 적재 건수(status의 last.cached)에 남으므로 재개에는 지장이 없다.
let backfillState = { running: false, startedAt: null, finishedAt: null, last: null };

// 일일 DART 예산 누적. running 플래그는 "동시" 실행만 막을 뿐 순차 반복은 못 막는다 —
// 정기 실행이 15,000회를 쓰고 끝난 뒤 운영자가 workflow_dispatch로 두 번 더 돌리면
// 45,000회가 되어 일일 쿼터 20,000회를 넘기고, 그날 남은 모든 DART 작업(일일 스캔의
// Piotroski 재무, 공시, 재무제표 조회)이 통째로 실패한다.
// 프로세스 재시작 시 초기화되는 한계는 있으나, 없으면 상한이 아예 없다.
let dartDailyBudget = { day: '', used: 0 };
const DART_DAILY_CAP = 19000; // 20,000 중 1,000은 일일 스캔·공시 조회 몫으로 남긴다

app.post('/api/backfill/fundamentals/trigger', async (req, res) => {
  if (!isScanSecretOrMaster(req)) return res.status(403).json({ error: 'Forbidden' });

  // 중복 실행 방지. 일일 스캔과 달리 백필은 유한한 DART 쿼터를 태우므로,
  // 두 번 겹치면 같은 종목을 두 배로 긁어 그날 남은 호출을 전부 날린다.
  if (backfillState.running) {
    return res.status(409).json({ error: '백필이 이미 실행 중', startedAt: backfillState.startedAt });
  }

  // 모듈 로드를 running 세팅보다 먼저 한다. 순서를 뒤집으면 import가 실패했을 때
  // running=true인 채로 핸들러가 reject되어 프로세스 재시작 전까지 영구히 409만 나온다.
  let runFundamentalsBackfill;
  try {
    ({ runFundamentalsBackfill } = await import('./cron.js'));
  } catch (e) {
    return res.status(500).json({ error: `백필 모듈 로드 실패: ${e.message}` });
  }

  // 숫자 파라미터는 서버에서 상한을 강제한다. maxDartCalls를 크게 넣으면 쿼터를 통째로
  // 태울 수 있어 클라이언트 값을 그대로 신뢰하지 않는다.
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
  };
  const opts = {
    limit:        num(req.body?.limit, 0, 0, 5000),
    maxDartCalls: num(req.body?.maxDartCalls, 15000, 100, DART_DAILY_CAP),
    full:         req.body?.full === true || req.body?.full === 'true',
  };

  const today = new Date().toISOString().slice(0, 10);
  if (dartDailyBudget.day !== today) dartDailyBudget = { day: today, used: 0 };
  const room = DART_DAILY_CAP - dartDailyBudget.used;
  if (room < 100) {
    return res.status(429).json({ error: '오늘 DART 예산 소진', used: dartDailyBudget.used, cap: DART_DAILY_CAP });
  }
  opts.maxDartCalls = Math.min(opts.maxDartCalls, room);

  backfillState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, last: null };
  const settle = (last) => {
    // 실제 선차감된 호출 수를 우선 쓰되, 결과를 못 받았으면 배정한 예산을 통째로 차감한다
    // (적게 잡으면 남은 예산을 과대평가해 쿼터를 넘긴다 — 남는 쪽으로 틀려야 한다).
    dartDailyBudget.used += Number.isFinite(last?.dartCallsBudgeted) ? last.dartCallsBudgeted : opts.maxDartCalls;
    backfillState = { ...backfillState, running: false, finishedAt: new Date().toISOString(), last };
  };
  runFundamentalsBackfill(opts)
    .then(settle)
    .catch(e => settle({ ok: false, error: e.message }));

  res.json({ ok: true, message: '펀더멘털 백필 시작됨 (비동기)', opts, dartBudgetRemaining: room });
});

app.get('/api/backfill/fundamentals/status', async (req, res) => {
  if (!isScanSecretOrMaster(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ ...backfillState, dartDailyBudget, dartDailyCap: DART_DAILY_CAP });
});

// ── 유니버스 갱신 트리거 (마스터/SCAN_SECRET) ─────────────────────
// 월 1회. 네이버 일괄 조회 4회 + upsert 3회 + 비활성화라 보통 20초 안에 끝나지만,
// Render 무료 티어의 요청 타임아웃에 걸리면 실행 도중 끊긴 채로 남는다. 백필과 같은 방식으로
// 비동기 실행 후 /api/universe/status로 결과를 조회한다.
let universeState = { running: false, startedAt: null, finishedAt: null, last: null };

app.post('/api/universe/refresh', async (req, res) => {
  if (!isScanSecretOrMaster(req)) return res.status(403).json({ error: 'Forbidden' });
  if (universeState.running) {
    return res.status(409).json({ error: '유니버스 갱신이 이미 실행 중', startedAt: universeState.startedAt });
  }

  // 백필 트리거와 같은 순서 — import 실패 시 running=true로 남지 않게 먼저 로드한다.
  // 입력 클램프는 cron.js가 갖는다 — 범위가 유니버스 로직의 일부라 그쪽에서 단위 검증된다.
  let refreshUniverse, normalizeUniverseOpts;
  try {
    ({ refreshUniverse, normalizeUniverseOpts } = await import('./cron.js'));
  } catch (e) {
    return res.status(500).json({ error: `유니버스 모듈 로드 실패: ${e.message}` });
  }

  const opts = normalizeUniverseOpts(req.body);

  universeState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, last: null };
  const settle = (last) => {
    universeState = { ...universeState, running: false, finishedAt: new Date().toISOString(), last };
  };
  refreshUniverse(opts).then(settle).catch(e => settle({ ok: false, error: e.message }));

  res.json({ ok: true, message: '유니버스 갱신 시작됨 (비동기)', opts });
});

app.get('/api/universe/status', async (req, res) => {
  if (!isScanSecretOrMaster(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(universeState);
});

// 이하 모든 /api/* 는 인증 필요
app.use('/api', authMiddleware);

// ── 헬스체크 (Render keep-alive, UptimeRobot 용) ─────────────────
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));


// ── /api/analysis ─────────────────────────────────────────────────
app.get('/api/analysis', async (req, res) => {
  try {
  const code    = req.query.code;
  const dartKey = process.env.DART_API_KEY || ''; // 쿼리파라미터 수신 제거 — 서버 env만 사용
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });

  const corpCode = CORP_MAP[code];
  const [items, dart, naverFund, rawNews] = await Promise.all([
    krxHistory(code),
    (dartKey && corpCode) ? fetchDartFinancials(corpCode, dartKey) : Promise.resolve(null),
    fetchNaverFundamentals(code),  // Yahoo v10 crumb 이슈 → Naver 대체
    fetchYahooNews(code),
  ]);
  // Naver 기본 재무 + DART 재무를 합쳐서 yahooFund 구조 유지 (기존 코드 호환)
  const yahooFund = naverFund ? {
    ...naverFund,
    opMargin:      dart?.opMargin      ?? null,
    revenueGrowth: dart?.revenueGrowth ?? null,
    roa:           null,   // Naver 미제공
    currentRatio:  null,   // Naver 미제공
    debtToEquity:  null,   // Naver 미제공
  } : null;
  const newsSentiment = analyzeNewsSentiment(rawNews);

  if (items?.length) {
    const last = items[items.length - 1];
    const closes  = items.map(i => parseInt(i.clpr, 10));
    const highs   = items.map(i => parseInt(i.hipr, 10));
    const lows    = items.map(i => parseInt(i.lopr, 10));
    const volumes = items.map(i => parseInt(i.trqu, 10));
    const price = closes[closes.length - 1];
    const change = parseInt(last.vs, 10);
    const changeRate = parseFloat(last.fltRt);
    const ma5   = calcMA(closes, 5);
    const ma20  = calcMA(closes, 20);
    const ma25  = calcMA(closes, 25);   // 주봉 5주선 ≈ 일봉 25일선 (5일×5주)
    const ma60  = calcMA(closes, 60);
    const ma120 = calcMA(closes, 120);  // 장기 경기 추세선
    const rsiArr = calcRSI(closes);
    const last20Vol = volumes.slice(-21, -1);
    const avgVol = last20Vol.reduce((s, v) => s + v, 0) / (last20Vol.length || 1);
    const todayVol = volumes[volumes.length - 1] || 0;
    const volR = avgVol > 0 ? todayVol / avgVol : 1;
    const high52w = Math.max(...closes.slice(-252));
    const low52w  = Math.min(...closes.slice(-252));
    const macd    = calcMACD(closes);
    const bb      = calcBollinger(closes);
    const atr     = calcATR(highs, lows, closes);
    // 252봉 명시 — 소스별 배열 길이(KRX 약 287 / Naver 280 / Yahoo 약 246)가 달라
    // 슬라이스 없이 넘기면 같은 종목도 폴백 경로에 따라 MDD가 달라진다. UI 표기는 "최근 1년".
    const mdd     = calcMDD(closes.slice(-252));
    const levels  = findKeyLevels(closes, volumes);
    const opensArr = items.map(i => parseInt(i.mkp, 10));
    const scoring = calcScore(price, ma5.at(-1), ma20.at(-1), ma60.at(-1), rsiArr.at(-1), volR, changeRate);
    const livermore = calcLivermoreScore(price, ma5.at(-1), ma20.at(-1), ma60.at(-1), rsiArr.at(-1), volR, changeRate, high52w, macd.lastCross, bb);
    const lynch = calcLynchScore(price, ma5.at(-1), ma20.at(-1), ma60.at(-1), rsiArr.at(-1), volR, changeRate, dart, yahooFund);
    const fresh = detectFreshSignals(closes, ma5, ma20, ma60, volumes);
    const candlePatterns = calcCandlePatterns(opensArr, highs, lows, closes);
    const ichimoku   = calcIchimoku(highs, lows, closes);
    const stochastic = calcStochastic(highs, lows, closes);
    const obvResult  = calcOBV(closes, volumes);
    const fibonacci  = calcFibonacci(closes, highs, lows);
    const rsiDiv     = detectRSIDivergence(closes, rsiArr);
    const wR         = calcWilliamsR(highs, lows, closes);
    const adx        = calcADX(highs, lows, closes);
    const mfi        = calcMFI(highs, lows, closes, volumes);
    const psar       = calcParabolicSAR(highs, lows, closes);
    const elder      = calcElderRay(highs, lows, closes);
    const dynStop    = calcDynamicStopLoss(closes, atr);
    const fScore     = calcPiotroski(dart, yahooFund);
    const leverageWarn = detectLeverageETF(last.itmsNm);
    const volPriceDivg = calcVolumePriceDivergence(closes, volumes);
    // 완전 정배열: ma5 > ma20 > ma60 > ma120
    const fullAlignment = [ma5.at(-1), ma20.at(-1), ma60.at(-1), ma120.at(-1)].every(v => v !== null)
      && ma5.at(-1) > ma20.at(-1) && ma20.at(-1) > ma60.at(-1) && ma60.at(-1) > ma120.at(-1);
    const csig = combinedSignal(livermore.lScore, lynch.pScore, macd.lastCross, bb,
      { ichimoku, stochastic, obv: obvResult, candlePatterns, rsiDivergence: rsiDiv, williamsR: wR }, adx);
    const candles = items.slice(-60).map(item => {
      const d = item.basDt;
      return { t: new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00+09:00`).getTime(),
        o: parseInt(item.mkp, 10), h: parseInt(item.hipr, 10), l: parseInt(item.lopr, 10),
        c: parseInt(item.clpr, 10), v: parseInt(item.trqu, 10) };
    });
    const result = {
      code, source: 'KRX', market: last.mrktCtg, name: last.itmsNm,
      close: price, previousClose: price - change, change, changeRate,
      volume: todayVol, volRatio: volR,
      ma5: ma5.at(-1), ma20: ma20.at(-1), ma60: ma60.at(-1), rsi: rsiArr.at(-1),
      high52w, low52w,
      pctFrom52wHigh: high52w > 0 ? (price / high52w - 1) * 100 : null,
      pctFrom52wLow:  low52w  > 0 ? (price / low52w  - 1) * 100 : null,
      deviation: ma20.at(-1) ? (price / ma20.at(-1) - 1) * 100 : 0,
      macd, bb, atr, mdd, ...levels, combinedSignal: csig, ...fresh,
      ...scoring, ...livermore, ...lynch, dart, fundamentals: yahooFund,
      candlePatterns, ichimoku, stochastic, obv: obvResult, fibonacci, rsiDivergence: rsiDiv, williamsR: wR,
      adx, mfi, psar, elder, dynStop, fScore,
      candles,
      ma5arr: ma5.slice(-60), ma20arr: ma20.slice(-60), ma25arr: ma25.slice(-60),
      ma60arr: ma60.slice(-60), ma120arr: ma120.slice(-60),
      ma120: ma120.at(-1), fullAlignment,
      leverageWarn, volPriceDivg,
      newsSentiment,
      backtest: runBacktest(closes),
      backtestMulti: runBacktestMulti(closes, highs, lows, volumes),
      krFlags: koreanMarketFlags(closes, volumes, changeRate),
      serverTime: Date.now(),
    };
    saveAnalysisToDB(code, result).catch(() => {});
    return res.json(result);
  }

  // Yahoo → Naver 폴백
  let vc, vv, vh, vl, vo, last, prev, market, stockName, changeRate, todayVol, candles, marketState;
  const yh = await yahooHistory(code);
  if (yh) {
    const { result, market: yhMkt } = yh;
    const meta = result.meta;
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const opens = q.open || [], yhighs = q.high || [], ylows = q.low || [], cls = q.close || [], vols = q.volume || [];
    const vi = cls.map((c, i) => c != null ? i : -1).filter(i => i >= 0);
    vc = vi.map(i => cls[i]);  vv = vi.map(i => vols[i] || 0);
    vh = vi.map(i => yhighs[i]); vl = vi.map(i => ylows[i]); vo = vi.map(i => opens[i] || 0);
    last = meta.regularMarketPrice || vc.at(-1);
    prev = meta.previousClose || vc.at(-2);
    market = yhMkt; stockName = meta.longName || meta.shortName || '';
    changeRate = prev ? ((last - prev) / prev) * 100 : 0;
    todayVol = vv.at(-1) || 0;
    candles = vi.slice(-60).map(i => ({ t: ts[i] * 1000, o: opens[i], h: yhighs[i], l: ylows[i], c: cls[i], v: vols[i] || 0 }));
    marketState = meta.marketState;
  } else {
    const nh = await naverHistory(code);
    if (!nh) return res.status(404).json({ error: 'NOT_FOUND', code });
    const toMs = (d) => new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00+09:00`).getTime();
    vc = nh.items.map(i => i.c); vv = nh.items.map(i => i.v);
    vh = nh.items.map(i => i.h); vl = nh.items.map(i => i.l); vo = nh.items.map(i => i.o);
    last = nh.price; prev = nh.previousClose;
    market = nh.market; stockName = nh.name;
    changeRate = nh.changeRate; todayVol = nh.volume;
    candles = nh.items.slice(-60).map(i => ({ t: toMs(i.date), o: i.o, h: i.h, l: i.l, c: i.c, v: i.v }));
    marketState = null;
  }
  const source = yh ? 'Yahoo' : 'Naver';
  const ma5  = calcMA(vc, 5), ma20 = calcMA(vc, 20), ma25 = calcMA(vc, 25), ma60 = calcMA(vc, 60), ma120 = calcMA(vc, 120), rsiArr = calcRSI(vc);
  const last20Vol = vv.slice(-21, -1);
  const avgVol = last20Vol.reduce((s, v) => s + v, 0) / (last20Vol.length || 1);
  const volR2 = avgVol > 0 ? todayVol / avgVol : 1;
  const high52w2 = Math.max(...vc.slice(-252));
  const low52w2  = Math.min(...vc.slice(-252));
  const macd2    = calcMACD(vc);
  const bb2      = calcBollinger(vc);
  const atr2     = calcATR(vh, vl, vc);
  const mdd2     = calcMDD(vc.slice(-252)); // 소스 무관 "최근 1년" 고정 (server.js 위 주석 참조)
  const levels2  = findKeyLevels(vc, vv);
  const scoring  = calcScore(last, ma5.at(-1), ma20.at(-1), ma60.at(-1), rsiArr.at(-1), volR2, changeRate);
  const livermore = calcLivermoreScore(last, ma5.at(-1), ma20.at(-1), ma60.at(-1), rsiArr.at(-1), volR2, changeRate, high52w2, macd2.lastCross, bb2);
  const lynch    = calcLynchScore(last, ma5.at(-1), ma20.at(-1), ma60.at(-1), rsiArr.at(-1), volR2, changeRate, dart, yahooFund);
  const fresh2   = detectFreshSignals(vc, ma5, ma20, ma60, vv);
  const csig2 = combinedSignal(livermore.lScore, lynch.pScore, macd2.lastCross, bb2,
    { ichimoku: calcIchimoku(vh, vl, vc), stochastic: calcStochastic(vh, vl, vc), obv: calcOBV(vc, vv),
      candlePatterns: calcCandlePatterns(vo, vh, vl, vc), rsiDivergence: detectRSIDivergence(vc, rsiArr), williamsR: calcWilliamsR(vh, vl, vc) },
    calcADX(vh, vl, vc));
  const result2 = {
    code, source, market, name: stockName,
    close: last, previousClose: prev, change: last - prev, changeRate,
    volume: todayVol, volRatio: volR2,
    ma5: ma5.at(-1), ma20: ma20.at(-1), ma60: ma60.at(-1), rsi: rsiArr.at(-1),
    high52w: high52w2, low52w: low52w2,
    pctFrom52wHigh: high52w2 > 0 ? (last / high52w2 - 1) * 100 : null,
    pctFrom52wLow:  low52w2  > 0 ? (last / low52w2  - 1) * 100 : null,
    deviation: ma20.at(-1) ? (last / ma20.at(-1) - 1) * 100 : 0,
    macd: macd2, bb: bb2, atr: atr2, mdd: mdd2, ...levels2, combinedSignal: csig2, ...fresh2,
    ...scoring, ...livermore, ...lynch, dart, fundamentals: yahooFund,
    candlePatterns: calcCandlePatterns(vo, vh, vl, vc),
    ichimoku: calcIchimoku(vh, vl, vc), stochastic: calcStochastic(vh, vl, vc),
    obv: calcOBV(vc, vv), fibonacci: calcFibonacci(vc, vh, vl),
    rsiDivergence: detectRSIDivergence(vc, rsiArr), williamsR: calcWilliamsR(vh, vl, vc),
    adx: calcADX(vh, vl, vc), mfi: calcMFI(vh, vl, vc, vv),
    psar: calcParabolicSAR(vh, vl, vc), elder: calcElderRay(vh, vl, vc),
    dynStop: calcDynamicStopLoss(vc, atr2), fScore: calcPiotroski(dart, yahooFund),
    candles,
    ma5arr: ma5.slice(-60), ma20arr: ma20.slice(-60), ma25arr: ma25.slice(-60),
    ma60arr: ma60.slice(-60), ma120arr: ma120.slice(-60),
    ma120: ma120.at(-1),
    fullAlignment: [ma5.at(-1), ma20.at(-1), ma60.at(-1), ma120.at(-1)].every(v => v !== null)
      && ma5.at(-1) > ma20.at(-1) && ma20.at(-1) > ma60.at(-1) && ma60.at(-1) > ma120.at(-1),
    leverageWarn: detectLeverageETF(stockName),
    volPriceDivg: calcVolumePriceDivergence(vc, vv),
    marketState, newsSentiment,
    backtest: runBacktest(vc),
    backtestMulti: runBacktestMulti(vc, vh, vl, vv),
    krFlags: koreanMarketFlags(vc, vv, changeRate),
    serverTime: Date.now(),
  };
  saveAnalysisToDB(code, result2).catch(() => {});
  res.json(result2);
  } catch (err) {
    console.error('[/api/analysis] 오류:', err);
    if (!res.headersSent) res.status(500).json({ error: '분석 중 서버 오류', detail: err.message });
  }
});

// ── /api/market ───────────────────────────────────────────────────
app.get('/api/market', async (req, res) => {
  if (cache.market.data && Date.now() - cache.market.ts < CACHE_TTL_MARKET) {
    return res.json({ ...cache.market.data, fromCache: true });
  }
  const [krxResults, yahooResults, kospiFut] = await Promise.all([
    Promise.all(KRX_INDICES.map(e => fetchIndex(e))),
    Promise.all(YAHOO_SYMBOLS.map(fetchYahooSymbol)),
    fetchKospiFutures(),
  ]);
  // 코스피·코스닥 바로 뒤에 선물 카드가 오도록 KRX 결과 다음에 합류
  const data = { market: [...krxResults, kospiFut, ...yahooResults], serverTime: Date.now() };
  cache.market = { data, ts: Date.now() };
  res.json(data);
});

// ── /api/index-chart/:id — 지수 일봉 OHLCV (이동평균 계산용) ─────
const INDEX_CHART_SYMBOLS = {
  kospi:  '^KS11',
  kosdaq: '^KQ11',
  sp500:  '^GSPC',
  nasdaq: '^IXIC',
  dow:    '^DJI',
  usdkrw: 'KRW=X',
  vix:    '^VIX',
};
app.get('/api/index-chart/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const symbol = INDEX_CHART_SYMBOLS[id];
  if (!symbol) return res.status(404).json({ error: `알 수 없는 지수: ${id}` });
  const cached = cache.indexChart[id];
  if (cached && Date.now() - cached.ts < CACHE_TTL_INDEX_CHART) {
    return res.json({ id, data: cached.data, fromCache: true });
  }
  try {
    const data = await fetchIndexOHLCV(symbol, '1y');
    cache.indexChart[id] = { data, ts: Date.now() };
    res.json({ id, data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/index/ma — 지수 이동평균 분석 (도구 탭 '지수 분석') ──────
const INDEX_MA_CACHE = new Map(); // symbol → { data, ts }
const INDEX_MA_TTL = 30 * 60 * 1000;
app.get('/api/index/ma', async (req, res) => {
  const symbol = String(req.query.code || '^KS11');
  const allowed = ['^KS11', '^KQ11', '^GSPC', '^IXIC', '^DJI'];
  if (!allowed.includes(symbol)) return res.status(400).json({ error: `지원하지 않는 지수: ${symbol}` });

  const cached = INDEX_MA_CACHE.get(symbol);
  if (cached && Date.now() - cached.ts < INDEX_MA_TTL) return res.json({ ...cached.data, fromCache: true });

  try {
    const rows = await fetchIndexOHLCV(symbol, '2y'); // MA240 계산 위해 2년
    const closes = rows.map(r => r.close);
    if (closes.length < 20) throw new Error('데이터 부족');
    const last = (n) => closes.length >= n
      ? closes.slice(-n).reduce((s, v) => s + v, 0) / n
      : null;
    const current = closes[closes.length - 1];
    const ma20 = last(20), ma60 = last(60), ma120 = last(120), ma240 = last(240);

    const mas = [ma20, ma60, ma120, ma240].filter(v => v != null);
    const aboveCount = mas.filter(v => current > v).length;
    let phase;
    if (aboveCount === mas.length)      phase = 'all_above';
    else if (aboveCount === 0)          phase = 'all_below';
    else if (ma20 != null && current > ma20 && ma120 != null && current < ma120) phase = 'recovering';
    else                                phase = 'mixed';

    const signal = phase === 'all_above' ? 'BUY' : phase === 'all_below' ? 'AVOID' : 'CAUTION';
    const data = { symbol, current, ma20, ma60, ma120, ma240, phase, signal, days: closes.length, serverTime: Date.now() };
    INDEX_MA_CACHE.set(symbol, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /api/naver-stock/:code (CORS 프록시) ──────────────────────────
app.get('/api/naver-stock/:code', async (req, res) => {
  const code = req.params.code.replace(/\D/g, '').slice(0, 6);
  if (!code) return res.status(400).json({ error: 'code 필요' });
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`,
      { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
    if (!r.ok) throw new Error(`naver HTTP ${r.status}`);
    const d = await r.json();
    return res.json({
      price:      parseInt((d.closePrice || '0').toString().replace(/,/g, '')),
      name:       d.stockName || '',
      changeRate: parseFloat(d.fluctuationsRatio || 0),
      change:     parseInt((d.compareToPreviousClosePrice || '0').toString().replace(/,/g, '')),
      market:     d.stockExchangeType?.name || '',
      source:     'naver',
    });
  } catch {
    try {
      const r2 = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
        { headers: { 'User-Agent': UA } });
      if (!r2.ok) throw new Error(`naver-polling HTTP ${r2.status}`);
      const d2 = await r2.json();
      const s = d2.datas?.[0];
      if (!s) throw new Error('no data');
      return res.json({ price: s.nv || 0, name: s.nm || '', changeRate: s.cr || 0, change: s.cv || 0, source: 'naver' });
    } catch (e2) {
      return res.status(502).json({ error: e2.message });
    }
  }
});

// ── /api/quotes — 배치 시세 조회 (최대 50종목 병렬) ──────────────
app.get('/api/quotes', authMiddleware, async (req, res) => {
  const raw = (req.query.codes || '').split(',').map(c => c.replace(/\D/g, '').slice(0, 6)).filter(Boolean);
  const codes = [...new Set(raw)].slice(0, 50);
  if (!codes.length) return res.status(400).json({ error: 'codes 파라미터 필요' });

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  const fetchOne = async (code) => {
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`,
        { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return {
        code,
        price:      parseInt((d.closePrice || '0').toString().replace(/,/g, '')),
        name:       d.stockName || '',
        changeRate: parseFloat(d.fluctuationsRatio || 0),
        change:     parseInt((d.compareToPreviousClosePrice || '0').toString().replace(/,/g, '')),
      };
    } catch {
      try {
        const r2 = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
          { headers: { 'User-Agent': UA } });
        if (!r2.ok) throw new Error(`polling HTTP ${r2.status}`);
        const d2 = await r2.json();
        const s = d2.datas?.[0];
        if (!s) throw new Error('no data');
        return { code, price: s.nv || 0, name: s.nm || '', changeRate: s.cr || 0, change: s.cv || 0 };
      } catch (e) {
        return { code, price: null, error: e.message };
      }
    }
  };

  const quotes = await Promise.all(codes.map(fetchOne));
  return res.json({ quotes, ts: Date.now() });
});

// ── /api/stock/search — 종목명·코드 검색 (내장 KRX 1775종목) ────
app.get('/api/stock/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = [];
  for (const s of KRX_STOCKS) {
    if (results.length >= 15) break;
    if (s.code.startsWith(q) || s.name.toLowerCase().includes(q)) {
      results.push({ ...s, sector: SECTOR_MAP[s.code] || null });
    }
  }
  results.sort((a, b) => {
    const ac = a.code === q ? 0 : a.code.startsWith(q) ? 1 : 2;
    const bc = b.code === q ? 0 : b.code.startsWith(q) ? 1 : 2;
    return ac - bc;
  });
  res.json({ results });
});

// ── /api/news/home — 홈 화면용 시장 뉴스 (코드 불필요) ────────────
app.get('/api/news/home', async (req, res) => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  try {
    // 코스피 지수 기반 시장 뉴스 — Yahoo는 한글 쿼리에 400 반환하므로 ^KS11 심볼 사용
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=%5EKS11&newsCount=10&enableFuzzyQuery=false';
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const data = await r.json();
    const news = (data.news || []).slice(0, 8).map(n => ({
      title:     n.title,
      publisher: n.publisher,
      date:      new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10),
      url:       n.link,
    }));
    res.json({ news, serverTime: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message, news: [] });
  }
});

// ── /api/news ─────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const code    = req.query.code;
  const dartKey = process.env.DART_API_KEY || ''; // 쿼리파라미터 수신 제거 — 서버 env만 사용
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });
  const corpCode = CORP_MAP[code];
  const [disclosures, yahooNews] = await Promise.all([
    (dartKey && corpCode) ? fetchDartDisclosures(corpCode, dartKey) : Promise.resolve([]),
    fetchYahooNews(code),
  ]);
  const newsSentiment = analyzeNewsSentiment(yahooNews);
  res.json({ disclosures, yahooNews, newsSentiment, serverTime: Date.now() });
});

// ── /api/macro ────────────────────────────────────────────────────
app.get('/api/macro', async (req, res) => {
  // 이력 조회 모드
  if (req.query.history === '1') {
    const history = await getMacroHistory();
    return res.json({ history });
  }

  // 캐시 히트
  if (cache.macro.data && Date.now() - cache.macro.ts < CACHE_TTL_MACRO) {
    return res.json({ ...cache.macro.data, fromCache: true });
  }

  const targets = [
    ['usdkrw', 'KRW=X'], ['kospi', '%5EKS11'], ['kosdaq', '%5EKQ11'],
    ['vix', '%5EVIX'], ['us10y', '%5ETNX'], ['sp500', '%5EGSPC'],
  ];
  const fetchOne = async ([key, sym]) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return [key, null];
      const d = await r.json();
      const meta = d.chart?.result?.[0]?.meta;
      if (!meta) return [key, null];
      const cur  = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose || cur;
      return [key, { current: parseFloat(cur.toFixed(2)), prev: parseFloat(prev.toFixed(2)), changePct: parseFloat(((cur - prev) / prev * 100).toFixed(2)) }];
    } catch { return [key, null]; }
  };
  const entries = await Promise.all(targets.map(fetchOne));
  const data = Object.fromEntries(entries.filter(([, v]) => v !== null));
  const { usdkrw, kospi, vix, us10y, sp500 } = data;
  let score = 0;
  const notes = [];

  if (usdkrw) {
    const v = usdkrw.current;
    if (usdkrw.changePct < -0.5)      { score += 2; notes.push(`원/달러 ${v.toFixed(0)}원 (${usdkrw.changePct > 0 ? '+' : ''}${usdkrw.changePct}%) — 원화 강세, 외국인 매수 우호`); }
    else if (usdkrw.changePct < -0.2) { score++;    notes.push(`원/달러 ${v.toFixed(0)}원 — 소폭 원화 강세`); }
    else if (usdkrw.changePct > 1.0)  { score -= 2; notes.push(`원/달러 ${v.toFixed(0)}원 (+${usdkrw.changePct}%) — 급격한 원화 약세, 외국인 이탈 가능`); }
    else if (usdkrw.changePct > 0.5)  { score--;    notes.push(`원/달러 ${v.toFixed(0)}원 — 원화 약세`); }
    else                               {             notes.push(`원/달러 ${v.toFixed(0)}원 (${usdkrw.changePct > 0 ? '+' : ''}${usdkrw.changePct}%) — 환율 안정`); }
    if (v > 1400)      notes.push(`⚠️ 환율 1,400원 초과 — 외환 위기 경계선`);
    else if (v > 1350) notes.push(`환율 고공행진 중 — 수입 물가 상승 압박`);
  }
  if (vix) {
    if (vix.current > 35)      { score -= 3; notes.push(`VIX ${vix.current} — 극도 공포 (패닉셀 주의, 역발상 매수 타이밍일 수 있음)`); }
    else if (vix.current > 25) { score -= 2; notes.push(`VIX ${vix.current} — 공포 구간 (변동성 급등, 단기 리스크 높음)`); }
    else if (vix.current > 20) { score--;    notes.push(`VIX ${vix.current} — 불안 구간`); }
    else if (vix.current < 14) { score += 2; notes.push(`VIX ${vix.current} — 극도 안정 (과도한 낙관 경계)`); }
    else                       { score++;    notes.push(`VIX ${vix.current} — 시장 안정`); }
  }
  if (kospi) {
    if (kospi.changePct > 1.5)       { score += 2; notes.push(`KOSPI +${kospi.changePct}% — 강세 랠리`); }
    else if (kospi.changePct > 0.5)  { score++;    notes.push(`KOSPI +${kospi.changePct}%`); }
    else if (kospi.changePct < -1.5) { score -= 2; notes.push(`KOSPI ${kospi.changePct}% — 급락`); }
    else if (kospi.changePct < -0.5) { score--;    notes.push(`KOSPI ${kospi.changePct}%`); }
    else                             {             notes.push(`KOSPI ${kospi.changePct > 0 ? '+' : ''}${kospi.changePct}% — 보합`); }
  }
  if (us10y) {
    const y = us10y.current;
    if (y > 5.0)      { score -= 2; notes.push(`미국채10Y ${y}% — 초고금리, 주식 밸류에이션 압박 극심`); }
    else if (y > 4.5) { score--;    notes.push(`미국채10Y ${y}% — 고금리 부담`); }
    else if (y < 3.0) { score += 2; notes.push(`미국채10Y ${y}% — 저금리 주식 친화 환경`); }
    else if (y < 3.5) { score++;    notes.push(`미국채10Y ${y}% — 금리 우호`); }
    else              {             notes.push(`미국채10Y ${y}%`); }
  }
  if (sp500) {
    if (sp500.changePct > 1.0)       { score++;  notes.push(`S&P500 +${sp500.changePct}% — 미국 증시 강세`); }
    else if (sp500.changePct < -1.0) { score--;  notes.push(`S&P500 ${sp500.changePct}% — 미국 증시 약세, 한국 연동 주의`); }
    else                             {           notes.push(`S&P500 ${sp500.changePct > 0 ? '+' : ''}${sp500.changePct}%`); }
  }
  const label = score >= 3 ? '매우긍정' : score >= 1 ? '긍정' : score <= -3 ? '매우부정' : score <= -1 ? '부정' : '중립';
  const payload = { data, score, label, notes, serverTime: Date.now() };
  cache.macro = { data: payload, ts: Date.now() };
  // 비동기로 DB에 저장
  saveMacroSnapshot(data).catch(() => {});
  res.json(payload);
});

// ── /api/movers ───────────────────────────────────────────────────
app.get('/api/movers', async (req, res) => {
  // 캐시 히트
  if (cache.movers.data && Date.now() - cache.movers.ts < CACHE_TTL_MOVERS) {
    return res.json({ ...cache.movers.data, fromCache: true });
  }

  const H = { 'User-Agent': 'Mozilla/5.0' };
  const fetchChart = async (code, suffix) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.${suffix}?interval=1d&range=2d`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) return null;
      const data = await r.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return null;
      const price = meta.regularMarketPrice;
      const prev  = meta.previousClose || meta.chartPreviousClose;
      return {
        code, suffix,
        name:       meta.longName || meta.shortName || code,
        market:     suffix === 'KS' ? 'KOSPI' : 'KOSDAQ',
        price,
        changeRate: prev ? ((price - prev) / prev) * 100 : 0,
        volume:     meta.regularMarketVolume || 0,
      };
    } catch { return null; }
  };

  const allPromises = [
    ...KS_UNIVERSE.map(c => fetchChart(c, 'KS')),
    ...KQ_UNIVERSE.map(c => fetchChart(c, 'KQ')),
  ];
  const all = (await Promise.all(allPromises)).filter(Boolean);
  if (!all.length) return res.status(503).json({ error: '조회된 종목 없음', candidates: [] });

  const unique = all.filter(s => s.price > 0 && s.volume > 0);
  const byVol  = [...unique].sort((a, b) => b.volume - a.volume).slice(0, 40);
  const byGain = [...unique].filter(s => s.changeRate >= 1).sort((a, b) => b.changeRate - a.changeRate).slice(0, 25);
  const byLoss = [...unique].filter(s => s.changeRate <= -1).sort((a, b) => a.changeRate - b.changeRate).slice(0, 10);
  const combined = new Map();
  [...byVol, ...byGain, ...byLoss].forEach(s => combined.set(s.code, s));
  const candidates = Array.from(combined.values());

  const payload = { candidates, total: unique.length, universe: KS_UNIVERSE.length + KQ_UNIVERSE.length, serverTime: Date.now() };
  cache.movers = { data: payload, ts: Date.now() };
  res.json(payload);
});

// ── 룰 기반 AI 가이드 (Gemini 폴백용) ────────────────────────────
function ruleBasedAiGuide({ name, buyPrice, currentPrice, analysis }) {
  const rsi        = analysis?.rsi ?? null;
  const macdCross  = analysis?.macd?.lastCross ?? null;
  const bb         = analysis?.bb ?? null;
  const ma5        = analysis?.ma5 ?? null;
  const ma20       = analysis?.ma20 ?? null;
  const ma60       = analysis?.ma60 ?? null;
  const near52w    = analysis?.near52wHigh ?? false;
  const signal     = analysis?.combinedSignal?.signal ?? 'HOLD';
  const confidence = analysis?.combinedSignal?.confidence ?? 50;
  const pScore     = analysis?.pScore ?? 0;
  const lScore     = analysis?.lScore ?? 0;
  const cur        = typeof currentPrice === 'number' ? currentPrice : 0;
  const buyPx      = typeof buyPrice === 'number' ? buyPrice : 0;
  const profit     = buyPx > 0 ? ((cur - buyPx) / buyPx) * 100 : 0;

  const isDeadCross   = macdCross === 'dead';
  const isGoldenCross = macdCross === 'golden';
  const maAligned     = ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60;
  const maInverted    = ma5 && ma20 && ma5 < ma20;
  const rsiOverbought = rsi !== null && rsi > 75;
  const rsiOversold   = rsi !== null && rsi < 30;

  let verdict = '홀드';
  if (profit <= -15 || (profit < -8 && isDeadCross)) {
    verdict = '매도';
  } else if (
    (profit >= 30 && (isDeadCross || signal === 'SELL')) ||
    (profit >= 25 && rsiOverbought) ||
    (signal === 'SELL' && confidence >= 65 && profit > 5)
  ) {
    verdict = '매도';
  } else if (profit < -10 && !maAligned) {
    verdict = '매도';
  }

  const holdReasons = [];
  if (isGoldenCross)                                 holdReasons.push('MACD 골든크로스 — 추세 상승 전환 신호');
  if (maAligned)                                     holdReasons.push('단·중·장기 이동평균 정배열 — 강세 추세 유지');
  if (rsi !== null && rsi >= 50 && rsi <= 70)        holdReasons.push(`RSI ${Math.round(rsi)} — 적정 모멘텀 구간`);
  if (near52w)                                       holdReasons.push('52주 신고가 근접 — 상승 모멘텀 지속');
  if (pScore >= 50)                                  holdReasons.push(`피터린치 점수 ${pScore}점 — 펀더멘털 양호`);
  if (lScore >= 50)                                  holdReasons.push(`리버모어 점수 ${lScore}점 — 기술적 추세 양호`);
  if (!holdReasons.length)                           holdReasons.push('현재 구간 추세 불명확 — 손절가 준수 하에 보유');

  const sellTriggers = [];
  if (isDeadCross)            sellTriggers.push('MACD 데드크로스 — 즉시 비중 축소 검토');
  if (rsiOverbought)          sellTriggers.push(`RSI ${Math.round(rsi)} 과매수 — 기술적 조정 가능성`);
  if (maInverted)             sellTriggers.push('단기 이평선 하락 이탈 — 추세 약화 신호');
  if (profit >= 20)           sellTriggers.push(`수익률 ${Math.round(profit)}% 달성 — 분할 익절 고려`);
  if (!sellTriggers.length)   sellTriggers.push('뚜렷한 매도 신호 없음 — 손절 기준 준수 시 보유 유효');

  const riskFactors = [];
  if (profit < -5)                    riskFactors.push(`평가손실 ${Math.abs(Math.round(profit))}% — 추가 방어선 설정 권고`);
  if (rsiOversold)                    riskFactors.push(`RSI ${Math.round(rsi)} 과매도 — 반등 전 추가 하락 가능성`);
  if (isDeadCross && profit > 0)      riskFactors.push('익절 구간에서 데드크로스 발생 — 수익 반납 리스크');
  if (!riskFactors.length)            riskFactors.push('현재 구간 주요 리스크 지표 미감지');

  const profitStr = profit >= 0 ? `+${Math.round(profit)}%` : `${Math.round(profit)}%`;
  const summaryMap = {
    '홀드': `${name} ${profitStr} — 기술 추세 양호, 보유 유지 권고`,
    '매도': `${name} ${profitStr} — 매도/손절 신호 감지, 포지션 재검토 필요`,
    '추가매수': `${name} ${profitStr} — 저점 매수 구간, 분할 추가 매수 고려`,
  };
  const summary = summaryMap[verdict] ?? summaryMap['홀드'];
  const reasoning = `현재가 ₩${cur.toLocaleString()}, 매수가 ₩${buyPx.toLocaleString()}. 룰 기반 판단 (Gemini 미사용).`;

  return { verdict, summary, reasoning, holdReasons, sellTriggers, riskFactors, source: 'rule' };
}

// ── /api/scan/results ─────────────────────────────────────────────
app.get('/api/scan/results', async (req, res) => {
  try {
    const results = await getScanResults({
      date:   req.query.date,
      signal: req.query.signal || 'BUY',
      limit:  parseInt(req.query.limit || '100'),
    });
    res.json({ results, date: req.query.date || new Date().toISOString().slice(0, 10), total: results.length, fromCache: false });
  } catch (e) {
    res.status(500).json({ error: e.message, results: [] });
  }
});

// ── /api/scan/status ──────────────────────────────────────────────
app.get('/api/scan/status', async (req, res) => {
  try {
    const lastBatch = await getScanStatus();
    res.json({ status: lastBatch?.status ?? 'idle', lastBatch: lastBatch ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/history/:code ────────────────────────────────────────────
app.get('/api/history/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const history = await getStockHistory(code, req.query.from, req.query.to);
    res.json({ code, history, from: req.query.from, to: req.query.to });
  } catch (e) {
    res.status(500).json({ error: e.message, history: [] });
  }
});

// ── /api/admin/users (마스터 전용 사용자 관리) ───────────────────
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await getAppUsers();
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message, users: [] });
  }
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { email, password, role = 'user', memo = '' } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: '이메일과 비밀번호 필요' });
  if (email.toLowerCase() === MASTER_EMAIL.toLowerCase())
    return res.status(400).json({ error: '마스터 계정은 변경 불가' });
  try {
    const user = await createAppUser(email, password, role, memo);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:email', authMiddleware, adminMiddleware, async (req, res) => {
  const target = decodeURIComponent(req.params.email);
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '비밀번호 필요' });
  if (target.toLowerCase() === MASTER_EMAIL.toLowerCase())
    return res.status(400).json({ error: '마스터 계정은 변경 불가' });
  try {
    await updateAppUserPassword(target, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:email', authMiddleware, adminMiddleware, async (req, res) => {
  const target = decodeURIComponent(req.params.email);
  if (target.toLowerCase() === MASTER_EMAIL.toLowerCase())
    return res.status(400).json({ error: '마스터 계정은 삭제 불가' });
  try {
    await deleteAppUser(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/scan/trigger-admin (어드민 UI 전용) ─────────────────────
app.post('/api/scan/trigger-admin', authMiddleware, adminMiddleware, async (req, res) => {
  const { runDailyScan } = await import('./cron.js');
  runDailyScan().catch(console.error);
  res.json({ ok: true, message: '스캔 시작됨 (비동기)' });
});

// ── /api/screener ──────────────────────────────────────────────────
const screenerCache = new Map(); // key -> { data, ts }
const SCREENER_TTL = 60 * 60 * 1000; // 1h
const SCREENER_CACHE_MAX = 200;      // 키가 사용자 입력 조합이라 상한이 없으면 무한히 증식한다
const ZONES = ['SEONJEOM', 'BREAKOUT', 'STORY_WARN', 'NEUTRAL', 'EXCLUDED', 'NO_DATA'];

// Map은 삽입 순서를 보존하므로 가장 오래된 키부터 버린다(FIFO). LRU까지 갈 이유는 없다 —
// TTL 1시간이라 어차피 오래된 항목은 곧 무효가 된다. 여기 목적은 메모리 상한뿐이다.
function setScreenerCache(key, value) {
  screenerCache.set(key, value);
  while (screenerCache.size > SCREENER_CACHE_MAX) {
    screenerCache.delete(screenerCache.keys().next().value);
  }
}

app.get('/api/screener', async (req, res) => {
  const {
    per_max, pbr_max, roe_min, debt_max,
    lynch_min, piotroski_min, park_min, zone,
    sort = 'lynch_score', page = '1', limit = '20',
    preset,
  } = req.query;

  // Preset → override filters
  let filters = { per_max, pbr_max, roe_min, debt_max, lynch_min, piotroski_min, park_min, zone };
  if (preset === 'lynch') {
    filters = { per_max: '20', pbr_max: '3', roe_min: '10', debt_max: '150', lynch_min: '50' };
  } else if (preset === 'value') {
    filters = { per_max: '10', pbr_max: '1', roe_min: '8', debt_max: '200', lynch_min: '0' };
  } else if (preset === 'growth') {
    filters = { per_max: '40', pbr_max: '5', roe_min: '15', debt_max: '100', lynch_min: '60' };
  } else if (preset === 'park') {
    // 저평가 선점 — 실적은 3년 연속 좋은데 주가는 아직 안 움직인 구간.
    // 밸류에이션 필터를 걸지 않는 게 핵심이다. PER/PBR 상한을 얹으면 박세익 스코어가
    // 이미 반영한 저평가 조건을 두 번 거는 셈이라, 실적이 좋아 PER이 오른 종목부터 잘린다.
    filters = { park_min: '60', zone: 'SEONJEOM' };
  }

  // zone은 이름 필터라 오타가 조용히 무시되면 필터가 통째로 사라진다 — 전 유니버스가
  // "선점 후보"로 돌아온다. PER 상한 오타(무시해도 결과가 넓어질 뿐)와 달리 여기서는
  // 오작동 방향이 위험한 쪽이라 열어주지 말고 거절한다. 캐시에 임의 문자열이 키로
  // 들어가는 것도 함께 막힌다(screenerCache는 무제한 Map이다).
  if (filters.zone !== undefined && !ZONES.includes(filters.zone)) {
    return res.status(400).json({ error: `zone 값이 올바르지 않습니다. 허용: ${ZONES.join(', ')}` });
  }

  const cacheKey = JSON.stringify(filters) + sort;
  const cached = screenerCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    const pg = parseInt(page), lm = parseInt(limit);
    const slice = cached.data.slice((pg - 1) * lm, pg * lm);
    // 미계측 안내는 캐시에도 함께 실린다 — 안 그러면 첫 응답 이후 1시간 동안 "후보 0건"으로 보인다.
    return res.json({ items: slice, total: cached.data.length, page: pg, fromCache: true,
      ...(cached.message ? { message: cached.message } : {}) });
  }

  try {
    const sb = getSupabase();
    // 최근 7일 내 분석 데이터, 종목별 최신 1개
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
    const { data: rows, error } = await sb
      .from('kt_daily_analysis')
      .select('code, analysis_date, lynch_score, livermore_score, piotroski_score, combined_score, rsi, close_price, change_rate, analysis_json, kt_stocks (name)')
      .gte('analysis_date', cutoff)
      .order('analysis_date', { ascending: false });

    if (error) return res.json({ items: [], total: 0, page: parseInt(page), message: '스캔 데이터 없음. 오늘 오후 8시 스캔 후 사용 가능합니다.' });
    if (!rows?.length) return res.json({ items: [], total: 0, page: 1, message: '스캔 데이터 없음. 스캔이 실행된 후 사용 가능합니다.' });

    // Deduplicate — keep latest per code
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      if (!seen.has(r.code)) { seen.add(r.code); deduped.push(r); }
    }

    // Parse analysis_json + apply filters
    const pNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const fPerMax   = pNum(filters.per_max);
    const fPbrMax   = pNum(filters.pbr_max);
    const fRoeMin   = pNum(filters.roe_min);
    const fDebtMax  = pNum(filters.debt_max);
    const fLynchMin = pNum(filters.lynch_min);
    const fPioMin   = pNum(filters.piotroski_min);
    const fParkMin  = pNum(filters.park_min);
    const fZone     = ZONES.includes(filters.zone) ? filters.zone : null;  // 검증은 위에서 끝났다

    const results = [];
    let parkRows = 0;  // park 필드를 실제로 들고 있는 행 수 — 0건과 "미계측"을 구분하기 위함
    for (const r of deduped) {
      let fund = {}, park = null, mZone = null, pctHigh = null;
      try {
        const j = JSON.parse(r.analysis_json || '{}');
        fund = j.fundamentals || {};
        park = j.park || null;
        mZone = j.matrixZone || null;
        pctHigh = pNum(j.pctFrom52wHigh);
      } catch {}
      if (park) parkRows++;

      const per = pNum(fund.per);
      const pbr = pNum(fund.pbr);
      const roe = pNum(fund.roe);
      const debt = pNum(fund.debtToEquity);
      const mktCap = pNum(fund.marketCap); // 억 단위

      // 지표 누락(null)은 제외하지 않음 — 경량 스캔은 PER/PBR만 제공, ROE/부채비율은 없을 수 있음
      if (fPerMax  !== null && per  !== null && per  > fPerMax)  continue;
      if (fPbrMax  !== null && pbr  !== null && pbr  > fPbrMax)  continue;
      if (fRoeMin  !== null && roe  !== null && roe  < fRoeMin)  continue;
      if (fDebtMax !== null && debt !== null && debt > fDebtMax) continue;
      if (fLynchMin !== null && r.lynch_score < fLynchMin)         continue;
      if (fPioMin  !== null && r.piotroski_score < fPioMin)        continue;
      // 박세익 점수는 PER/PBR과 달리 null을 통과시키지 않는다. 여기서 null은 "지표 하나가
      // 빈 종목"이 아니라 "3년 실적을 확인하지 못한 종목"이고, 적자 게이트에 걸린 종목도
      // 0점으로 여기서 함께 잘린다. 확인하지 못한 것을 후보로 올리면 게이트가 무의미해진다.
      const parkScore = pNum(park?.score);
      if (fParkMin !== null && !(parkScore !== null && parkScore >= fParkMin)) continue;
      if (fZone !== null && mZone !== fZone) continue;

      const name = r.kt_stocks?.name || krxName(r.code) || r.code;

      results.push({
        code: r.code, name,
        per, pbr, roe, debtRatio: debt, marketCap: mktCap,
        close: r.close_price, changeRate: r.change_rate, rsi: r.rsi,
        lynchScore: r.lynch_score, piotroskiScore: r.piotroski_score,
        livermoreScore: r.livermore_score,
        parkScore, parkGrade: park?.grade ?? null, parkGated: park?.gated ?? null,
        parkReasons: park?.reasons ?? [], matrixZone: mZone, pctFrom52wHigh: pctHigh,
        combinedScore: r.combined_score, analysisDate: r.analysis_date,
      });
    }

    // Sort
    const sortKey = sort === 'lynch_score' ? 'lynchScore'
      : sort === 'piotroski' ? 'piotroskiScore'
      : sort === 'per'       ? 'per'
      : sort === 'pbr'       ? 'pbr'
      : sort === 'roe'       ? 'roe'
      : sort === 'park'      ? 'parkScore'
      // 낙폭 정렬은 오름차순이다 — pctFrom52wHigh는 음수라 작을수록 많이 빠진 종목이다.
      : sort === 'drop'      ? 'pctFrom52wHigh'
      : 'combinedScore';
    const ascending = ['per','pbr','drop'].includes(sort);
    results.sort((a, b) => {
      const va = a[sortKey] ?? (ascending ? Infinity : -Infinity);
      const vb = b[sortKey] ?? (ascending ? Infinity : -Infinity);
      return ascending ? va - vb : vb - va;
    });

    // 박세익 필터를 걸었는데 park를 가진 행이 하나도 없으면 "후보 0건"이 아니라 "미계측"이다.
    // 둘 다 빈 배열로 나가면 화면에서 구분할 방법이 없어 백필 누락이 조용히 묻힌다.
    const parkFiltered = fParkMin !== null || fZone !== null;
    const message = (parkFiltered && parkRows === 0 && deduped.length > 0)
      ? '박세익 스코어가 아직 계산되지 않았습니다. 다음 전체 스캔 이후 사용 가능합니다.'
      : undefined;
    setScreenerCache(cacheKey, { data: results, ts: Date.now(), message });

    const pg = parseInt(page), lm = parseInt(limit);
    const slice = results.slice((pg - 1) * lm, pg * lm);
    res.json({ items: slice, total: results.length, page: pg, ...(message ? { message } : {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/alerts ────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  const codes = (req.query.codes || '').split(',').map(c => c.trim()).filter(Boolean).slice(0, 50);
  if (!codes.length) return res.json({ alerts: [] });
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [analysisRes, settingsRes] = await Promise.allSettled([
      getSupabase()
        .from('kt_daily_analysis')
        .select('code, analysis_date, rsi, close_price, change_rate, lynch_score, analysis_json')
        .in('code', codes)
        .gte('analysis_date', cutoff)
        .order('analysis_date', { ascending: false }),
      getSupabase()
        .from('alert_settings')
        .select('code, target_price, stop_loss, rsi_high, rsi_low, is_active')
        .eq('user_email', req.user.email)
        .eq('is_active', true)
        .in('code', codes),
    ]);

    if (analysisRes.status === 'rejected' || analysisRes.value.error) throw analysisRes.value?.error || analysisRes.reason;
    const rows = analysisRes.value.data || [];

    // Build per-code custom thresholds map
    const settingsMap = {};
    if (settingsRes.status === 'fulfilled' && !settingsRes.value.error) {
      for (const s of settingsRes.value.data || []) settingsMap[s.code] = s;
    }

    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      if (!seen.has(r.code)) { seen.add(r.code); deduped.push(r); }
    }

    const alerts = [];
    for (const r of deduped) {
      let aj = {};
      try { aj = JSON.parse(r.analysis_json || '{}'); } catch {}

      const custom = settingsMap[r.code];
      const rsiHighThreshold = custom?.rsi_high ?? 75;
      const rsiLowThreshold  = custom?.rsi_low  ?? 30;

      const signal = [];
      if (r.rsi != null && r.rsi > rsiHighThreshold)
        signal.push({ type: 'rsi_high', text: `RSI ${Math.round(r.rsi)} 과매수 (기준 ${rsiHighThreshold})`, level: 'warn' });
      else if (r.rsi != null && r.rsi < rsiLowThreshold)
        signal.push({ type: 'rsi_low', text: `RSI ${Math.round(r.rsi)} 과매도 (기준 ${rsiLowThreshold})`, level: 'buy' });

      if (custom?.target_price != null && r.close_price != null && r.close_price >= custom.target_price)
        signal.push({ type: 'target_hit', text: `목표가 도달 ${r.close_price.toLocaleString()} ≥ ${custom.target_price.toLocaleString()}`, level: 'buy' });

      if (custom?.stop_loss != null && r.close_price != null && r.close_price <= custom.stop_loss)
        signal.push({ type: 'stop_loss_hit', text: `손절가 도달 ${r.close_price.toLocaleString()} ≤ ${custom.stop_loss.toLocaleString()}`, level: 'sell' });

      const cs = aj.combinedSignal;
      if (cs?.signal === 'BUY' && (cs.confidence || 0) >= 65)
        signal.push({ type: 'buy', text: `매수 신호 (${cs.confidence}%)`, level: 'buy' });
      else if (cs?.signal === 'SELL' && (cs.confidence || 0) >= 65)
        signal.push({ type: 'sell', text: `매도 신호 (${cs.confidence}%)`, level: 'warn' });

      if (aj.near52wHigh || aj.krFlags?.near52wHigh)
        signal.push({ type: '52w_high', text: '52주 신고가 근접', level: 'info' });
      if (aj.near52wLow || aj.krFlags?.near52wLow)
        signal.push({ type: '52w_low', text: '52주 신저가 근접', level: 'info' });

      if (signal.length) {
        alerts.push({
          code: r.code, name: krxName(r.code) || aj.name || r.code,
          price: r.close_price, changeRate: r.change_rate,
          rsi: r.rsi, signal, lynchScore: r.lynch_score,
          analysisDate: r.analysis_date,
          hasCustomSettings: !!custom,
        });
      }
    }
    res.json({ alerts });
  } catch (e) {
    res.status(500).json({ error: e.message, alerts: [] });
  }
});

// ── /api/52w ───────────────────────────────────────────────────────
app.get('/api/52w', async (req, res) => {
  // sort=drawdown은 "고점에서 크게 빠진" 종목을 찾는 용도라 near52wHigh/Low 어느 쪽에도
  // 걸리지 않는 중간 구간이 타깃이다. 이때만 방향 필터를 해제한다.
  const byDrawdown = req.query.sort === 'drawdown';
  const direction = byDrawdown ? 'all' : (req.query.direction === 'low' ? 'low' : 'high');
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: rows, error } = await getSupabase()
      .from('kt_daily_analysis')
      .select('code, analysis_date, close_price, change_rate, lynch_score, analysis_json, kt_stocks (name)')
      .gte('analysis_date', cutoff)
      .order('analysis_date', { ascending: false });
    if (error) return res.json({ items: [], total: 0, direction, message: '스캔 데이터 없음. 오늘 오후 8시 스캔 후 사용 가능합니다.' });

    const seen = new Set();
    const deduped = [];
    for (const r of rows || []) {
      if (!seen.has(r.code)) { seen.add(r.code); deduped.push(r); }
    }

    const results = [];
    for (const r of deduped) {
      let aj = {};
      try { aj = JSON.parse(r.analysis_json || '{}'); } catch {}

      const isHigh = !!(aj.near52wHigh || aj.krFlags?.near52wHigh);
      const isLow  = !!(aj.near52wLow  || aj.krFlags?.near52wLow);

      if (direction === 'high' && !isHigh) continue;
      if (direction === 'low'  && !isLow)  continue;
      // 낙폭 정렬은 pctFrom52wHigh가 필수. 구 스캔 행(해당 필드 없음)은 여기서 제외한다.
      if (byDrawdown && typeof aj.pctFrom52wHigh !== 'number') continue;

      results.push({
        code: r.code, name: r.kt_stocks?.name || krxName(r.code) || aj.name || r.code,
        price: r.close_price, changeRate: r.change_rate,
        lynchScore: r.lynch_score, analysisDate: r.analysis_date,
        high52w: aj.high52w ?? null, low52w: aj.low52w ?? null,
        pctFrom52wHigh: aj.pctFrom52wHigh ?? null,
        pctFrom52wLow:  aj.pctFrom52wLow  ?? null,
        w52Partial:     aj.w52Partial     ?? null,
      });
    }

    // sort=drawdown — 고점 대비 낙폭이 큰 순. "실적은 좋은데 주가만 빠진" 종목 탐색용
    if (byDrawdown) {
      results.sort((a, b) => a.pctFrom52wHigh - b.pctFrom52wHigh);
    } else {
      results.sort((a, b) => (b.lynchScore || 0) - (a.lynchScore || 0));
    }
    res.json({ items: results.slice(0, 50), total: results.length, direction });
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

// ── /api/peers ─────────────────────────────────────────────────────
app.get('/api/peers', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 필요' });
  const mySector = SECTOR_MAP[code];
  if (!mySector) return res.json({ sector: null, peers: [] });

  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const sectorCodes = Object.entries(SECTOR_MAP)
      .filter(([c, s]) => s === mySector)
      .map(([c]) => c);

    const { data: rows, error } = await getSupabase()
      .from('kt_daily_analysis')
      .select('code, analysis_date, close_price, change_rate, lynch_score, analysis_json')
      .in('code', sectorCodes)
      .gte('analysis_date', cutoff)
      .order('analysis_date', { ascending: false });
    if (error) throw error;

    const seen = new Set();
    const deduped = [];
    for (const r of rows || []) {
      if (!seen.has(r.code)) { seen.add(r.code); deduped.push(r); }
    }

    const pNum = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const peers = deduped.map(r => {
      let aj = {};
      try { aj = JSON.parse(r.analysis_json || '{}'); } catch {}
      const fund = aj.fundamentals || {};
      return {
        code: r.code, name: krxName(r.code) || aj.name || r.code, isTarget: r.code === code,
        price: r.close_price, changeRate: r.change_rate,
        per: pNum(fund.per), pbr: pNum(fund.pbr), roe: pNum(fund.roe),
        dividend: pNum(fund.dividendYield), marketCap: pNum(fund.marketCap),
        lynchScore: r.lynch_score,
      };
    });

    // Sort: target first, then by marketCap desc
    peers.sort((a, b) => {
      if (a.isTarget) return -1;
      if (b.isTarget) return 1;
      return (b.marketCap || 0) - (a.marketCap || 0);
    });

    res.json({ sector: mySector, peers: peers.slice(0, 8) });
  } catch (e) {
    res.status(500).json({ error: e.message, sector: mySector, peers: [] });
  }
});

// ── /api/sectors ───────────────────────────────────────────────────
const sectorsCache = { data: null, ts: 0 };
const SECTORS_TTL = 30 * 60 * 1000; // 30 min

app.get('/api/sectors', async (req, res) => {
  if (sectorsCache.data && Date.now() - sectorsCache.ts < SECTORS_TTL) {
    return res.json({ ...sectorsCache.data, fromCache: true });
  }
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: rows, error } = await getSupabase()
      .from('kt_daily_analysis')
      .select('code, analysis_date, close_price, change_rate, analysis_json')
      .gte('analysis_date', cutoff)
      .order('analysis_date', { ascending: false });
    if (error) return res.json({ sectors: [], message: '스캔 데이터 없음. 오늘 오후 8시 스캔 후 사용 가능합니다.' });

    const seen = new Set();
    const byCode = {};
    for (const r of rows || []) {
      if (!seen.has(r.code)) { seen.add(r.code); byCode[r.code] = r; }
    }

    // Group by sector
    const sectorData = {};
    for (const [code, r] of Object.entries(byCode)) {
      const sec = SECTOR_MAP[code] || 'ETC';
      if (!sectorData[sec]) sectorData[sec] = { changeRates: [], codes: [], names: [] };
      sectorData[sec].changeRates.push(r.change_rate || 0);
      sectorData[sec].codes.push(code);
      let name = krxName(code) || code;
      if (name === code) { try { name = JSON.parse(r.analysis_json || '{}').name || code; } catch {} }
      sectorData[sec].names.push({ code, name, changeRate: r.change_rate || 0, price: r.close_price });
    }

    const sectors = SECTOR_NAMES.map(name => {
      const d = sectorData[name];
      if (!d) return { name, avgChange: 0, count: 0, stocks: [] };
      const avg = d.changeRates.reduce((a, b) => a + b, 0) / d.changeRates.length;
      d.names.sort((a, b) => b.changeRate - a.changeRate);
      return { name, avgChange: parseFloat(avg.toFixed(2)), count: d.codes.length, stocks: d.names.slice(0, 20) };
    }).filter(s => s.count > 0);

    const payload = { sectors, updatedAt: Date.now() };
    sectorsCache.data = payload;
    sectorsCache.ts = Date.now();
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message, sectors: [] });
  }
});

// ── corp_code 매핑 인메모리 메모 ────────────────────────────────────
// loadCorpCodeMap은 전 상장사 매핑이 담긴 단일 블롭 행을 읽어 JSON.parse 한다(약 3,930개 항목).
// 요청마다 부르면 종목 상세를 열 때마다 100KB 파싱이 반복되므로 프로세스 안에서 1시간 캐시한다.
let corpMapMemo = { map: null, ts: 0 };
const CORP_MAP_TTL = 60 * 60 * 1000;
async function resolveCorpCode(code) {
  if (CORP_MAP[code]) return CORP_MAP[code];
  if (!corpMapMemo.map || Date.now() - corpMapMemo.ts > CORP_MAP_TTL) {
    const map = await loadCorpCodeMap().catch(() => null);
    // loadCorpCodeMap은 실패 시 예외가 아니라 {}를 돌려준다. {}는 truthy라 그대로 메모하면
    // Supabase가 순간 장애난 시점에 걸린 요청 하나가 1시간짜리 장애를 만든다 —
    // 그동안 하드코딩 CORP_MAP에 없는 모든 종목이 400으로 떨어지고 자가 회복도 없다.
    if (map && Object.keys(map).length > 0) corpMapMemo = { map, ts: Date.now() };
  }
  return corpMapMemo.map?.[code] || null;
}

// ── /api/financials ────────────────────────────────────────────────
// 캐시 우선. 이 엔드포인트는 호출 1회당 DART 5회(최근 5개 사업연도)를 쓰는데,
// 종목 상세를 열 때마다 그대로 나가면 사용자 몇 명이 훑는 것만으로 일일 쿼터가 녹는다.
// 백필이 채워둔 __multiyear__를 읽고, 없을 때만 실시간 조회 후 같은 캐시에 적재한다.
app.get('/api/financials', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });
  try {
    const cached = await getMultiYearCache(code).catch(() => undefined);
    if (cached !== undefined && cached !== null) {
      // 분기·개황도 함께 실어 보낸다 — 프런트가 TTM·업종을 별도 요청 없이 쓴다.
      const [quarterly, company] = await Promise.all([
        getQuarterlyCache(code).catch(() => null),
        getCompanyInfoCache(code).catch(() => null),
      ]);
      return res.json({ code, rows: cached, quarterly: quarterly ?? null, company: company ?? null, cached: true });
    }

    const dartKey = process.env.DART_API_KEY || '';
    // 하드코딩 CORP_MAP에만 의존하면 매핑에 없는 대다수 종목이 400으로 떨어진다.
    // kt_corp_codes에 전 상장사가 적재돼 있으므로 그쪽까지 조회한다.
    const corpCode = await resolveCorpCode(code);
    if (!dartKey || !corpCode) {
      return res.status(400).json({ error: 'DART API 키 또는 종목 코드 매핑 없음', code });
    }
    const rows = await fetchDartMultiYear(corpCode, dartKey);
    // 원소 존재가 아니라 필드 내용으로 판정한다(data.js hasYearData 주석 참조).
    // some(v => v != null)로 쓰면 DART 장애 중 사용자가 종목 상세를 한 번 여는 것만으로
    // 빈 껍데기가 100일 TTL로 적재되고, 그 종목이 백필에서 100일간 제외된다.
    if (Array.isArray(rows) && rows.some(hasYearData)) {
      await setMultiYearCache(code, rows).catch(() => {});
    }
    res.json({ code, rows, quarterly: null, company: null, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/disclosures ───────────────────────────────────────────────
// DART 최근 공시 (리포트용, 90일 이내 최대 5건)
const disclosureCache = new Map(); // code → { data, ts }
const DISCLOSURE_TTL = 60 * 60 * 1000; // 1h

app.get('/api/disclosures', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 필요' });
  const dartKey = process.env.DART_API_KEY || '';
  const corpCode = CORP_MAP[code];
  if (!dartKey || !corpCode) return res.json({ code, items: [] });

  const cached = disclosureCache.get(code);
  if (cached && Date.now() - cached.ts < DISCLOSURE_TTL)
    return res.json({ code, items: cached.data, fromCache: true });

  try {
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const end = new Date();
    const bgn = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${dartKey}&corp_code=${corpCode}&bgn_de=${fmt(bgn)}&end_de=${fmt(end)}&page_count=5`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    const items = data.status === '000'
      ? (data.list || []).slice(0, 5).map(it => ({
          date: it.rcept_dt || '', title: it.report_nm || '', corp: it.corp_name || '',
        }))
      : [];
    disclosureCache.set(code, { data: items, ts: Date.now() });
    res.json({ code, items });
  } catch {
    res.json({ code, items: [] });
  }
});

// ── /api/supply ────────────────────────────────────────────────────
// Per-stock investor (foreign/inst/indiv) net buy data for supply chart (F026)
const supplyCache = new Map(); // code → { data, ts }
const SUPPLY_TTL = 20 * 60 * 1000; // 20 min

app.get('/api/supply', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 필요' });

  const cached = supplyCache.get(code);
  if (cached && Date.now() - cached.ts < SUPPLY_TTL)
    return res.json({ code, rows: cached.data, fromCache: true });

  const rows = await fetchNaverInvestor(code);
  if (!rows) return res.json({ code, rows: [], message: '수급 데이터를 가져올 수 없습니다' });

  supplyCache.set(code, { data: rows, ts: Date.now() });
  res.json({ code, rows });
});

// /api/supply-demand — alias for /api/supply (F061)
app.get('/api/supply-demand', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 필요' });
  const cached = supplyCache.get(code);
  if (cached && Date.now() - cached.ts < SUPPLY_TTL)
    return res.json({ code, rows: cached.data, fromCache: true });
  const rows = await fetchNaverInvestor(code);
  if (!rows) return res.json({ code, rows: [], message: '수급 데이터를 가져올 수 없습니다' });
  supplyCache.set(code, { data: rows, ts: Date.now() });
  res.json({ code, rows });
});

// ── /api/supply-ranking ────────────────────────────────────────────
// Top N stocks by foreign or institutional net buy (F021)
const rankingCache = new Map(); // key → { data, ts }
const RANKING_TTL = 30 * 60 * 1000; // 30 min

app.get('/api/supply-ranking', async (req, res) => {
  const period = ['5', '20'].includes(req.query.period) ? req.query.period : '1';
  const type   = req.query.type === 'inst' ? 'inst' : 'foreign';
  const cacheKey = `${type}-${period}`;

  const cached = rankingCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < RANKING_TTL)
    return res.json({ ...cached.data, fromCache: true });

  // Scan top 50 KS + 20 KQ universe stocks in parallel (batched to avoid rate limit)
  const SCAN_CODES = [...KS_UNIVERSE.slice(0, 45), ...KQ_UNIVERSE.slice(0, 15)];
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < SCAN_CODES.length; i += BATCH) {
    const batch = SCAN_CODES.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async code => {
      try {
        const rows = await fetchNaverInvestor(code);
        if (!rows || !rows.length) return null;
        const days = parseInt(period);
        const subset = rows.slice(0, days);
        const net = subset.reduce((s, d) => s + (type === 'inst' ? d.inst : d.foreign), 0);
        if (net === 0) return null;
        // Get name from Naver
        return { code, net, period, type };
      } catch { return null; }
    }));
    results.push(...batchResults.filter(Boolean));
  }

  // Sort by net buy
  results.sort((a, b) => b.net - a.net);
  const top = results.slice(0, 15);

  // Enrich with names from screener cache or Naver
  const codes = top.map(t => t.code);
  let nameMap = {};
  try {
    const sb = getSupabase();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: nameRows } = await sb.from('kt_daily_analysis')
      .select('code, analysis_json').in('code', codes).gte('analysis_date', cutoff)
      .order('analysis_date', { ascending: false });
    const seenCodes = new Set();
    for (const r of nameRows || []) {
      if (!seenCodes.has(r.code)) {
        seenCodes.add(r.code);
        try { nameMap[r.code] = JSON.parse(r.analysis_json || '{}').name || r.code; } catch {}
      }
    }
  } catch {}

  const items = top.map(t => ({
    ...t,
    name: nameMap[t.code] || KRX_STOCKS.find(s => s.code === t.code)?.name || t.code,
  }));
  const payload = { items, total: results.length, type, period, scannedAt: Date.now() };
  rankingCache.set(cacheKey, { data: payload, ts: Date.now() });
  res.json(payload);
});

// ── /api/gemini ────────────────────────────────────────────────────
app.get('/api/gemini/analyze', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });
  try {
    const analysisRes = await fetch(`http://localhost:${PORT}/api/analysis?code=${code}`, {
      headers: { authorization: req.headers.authorization },
    });
    if (!analysisRes.ok) return res.status(502).json({ error: '종목 데이터 조회 실패' });
    const analysisData = await analysisRes.json();
    if (analysisData.error) return res.status(400).json({ error: analysisData.error });
    const { analyzeStock } = await import('./gemini.js');
    const result = await analyzeStock(analysisData);
    res.json(result);
  } catch (e) {
    res.status(429).json({ error: e.message });
  }
});

// ── /api/ai-guide — 보유 종목 홀드/매도 AI 판단 (Gemini → 룰 기반 폴백) ──
app.post('/api/ai-guide', authMiddleware, async (req, res) => {
  const { code, name, buyPrice, currentPrice, shares } = req.body || {};
  if (!code || !currentPrice) return res.status(400).json({ error: 'code·currentPrice 필요' });

  const cur    = Number(currentPrice);
  const buyPx  = Number(buyPrice) || 0;
  const nm     = name || code;

  try {
    // 오늘자 차트 분석 캐시에서 조회
    const today = new Date().toISOString().slice(0, 10);
    const { data: cached } = await getSupabase()
      .from('kt_daily_analysis')
      .select('analysis_json')
      .eq('code', code)
      .eq('analysis_date', today)
      .maybeSingle()
      .catch(() => ({ data: null }));

    const analysis = cached?.analysis_json
      ? (typeof cached.analysis_json === 'string' ? JSON.parse(cached.analysis_json) : cached.analysis_json)
      : null;

    try {
      const { analyzeHolding } = await import('./gemini.js');
      const result = await analyzeHolding(
        { code, name: nm, buyPrice: buyPx, currentPrice: cur, shares: Number(shares) || 0 },
        analysis,
      );
      return res.json({ ...result, source: 'gemini' });
    } catch {
      // Gemini 실패(키 미설정·한도 초과 등) → 룰 기반 즉시 응답
      return res.json(ruleBasedAiGuide({ name: nm, buyPrice: buyPx, currentPrice: cur, analysis }));
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gemini/validate-thesis', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const { data: rows } = await getSupabase()
      .from('theses')
      .select('story,growth,valuation,exit_plan,name')
      .eq('user_email', req.user.email)
      .eq('code', code)
      .maybeSingle();
    if (!rows) return res.status(404).json({ error: 'Thesis가 없습니다. 먼저 Thesis를 작성하세요.' });
    const { validateThesis } = await import('./gemini.js');
    const result = await validateThesis(rows, rows.name || code);
    res.json(result);
  } catch (e) {
    res.status(e.message?.includes('한도') ? 429 : 500).json({ error: e.message });
  }
});

// ── /api/gemini/analyze-deep — 멀티 에이전트 병렬 심층 분석 (Feature 5) ──
app.get('/api/gemini/analyze-deep', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });
  try {
    const analysisRes = await fetch(`http://localhost:${PORT}/api/analysis?code=${code}`, {
      headers: { authorization: req.headers.authorization },
    });
    if (!analysisRes.ok) return res.status(502).json({ error: '종목 데이터 조회 실패' });
    const analysisData = await analysisRes.json();
    if (analysisData.error) return res.status(400).json({ error: analysisData.error });
    const { analyzeStockMultiPerspective } = await import('./gemini.js');
    const result = await analyzeStockMultiPerspective(analysisData);
    res.json(result);
  } catch (e) {
    res.status(e.message?.includes('한도') ? 429 : 500).json({ error: e.message });
  }
});

// ── /api/gemini/news-pulse — 주가 급등락 원인 귀인 (Feature 3) ──────
app.get('/api/gemini/news-pulse', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });
  try {
    const analysisRes = await fetch(`http://localhost:${PORT}/api/analysis?code=${code}`, {
      headers: { authorization: req.headers.authorization },
    });
    if (!analysisRes.ok) return res.status(502).json({ error: '종목 데이터 조회 실패' });
    const d = await analysisRes.json();
    if (d.error) return res.status(400).json({ error: d.error });
    const { analyzeNewsPulse } = await import('./gemini.js');
    const result = await analyzeNewsPulse({
      code, name: d.name, changeRate: d.changeRate, close: d.close,
      rsi: d.rsi, volRatio: d.volRatio, market: d.market,
    });
    res.json(result);
  } catch (e) {
    res.status(e.message?.includes('한도') ? 429 : 500).json({ error: e.message });
  }
});

// ── /api/quality-screen — 품질 스크린 7개 필터 (Feature 4) ──────────
app.get('/api/quality-screen', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code 파라미터 필요' });
  try {
    const analysisRes = await fetch(`http://localhost:${PORT}/api/analysis?code=${code}`, {
      headers: { authorization: req.headers.authorization },
    });
    if (!analysisRes.ok) return res.status(502).json({ error: '종목 데이터 조회 실패' });
    const d = await analysisRes.json();
    if (d.error) return res.status(400).json({ error: d.error });
    const { calcQualityScreen } = await import('./analysis.js');
    const result = calcQualityScreen(d.dart, d.fundamentals, d.pScore, d.fScore);
    res.json({ ...result, code, name: d.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/thesis/track — Thesis 현재 유효성 추적 (Feature 2) ─────────
app.get('/api/thesis/track', authMiddleware, async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const [thesisResult, analysisResult] = await Promise.all([
      getSupabase().from('theses').select('story,growth,valuation,exit_plan,name')
        .eq('user_email', req.user.email).eq('code', code).maybeSingle(),
      fetch(`http://localhost:${PORT}/api/analysis?code=${code}`, {
        headers: { authorization: req.headers.authorization },
      }).then(r => r.json()).catch(() => null),
    ]);
    const thesis = thesisResult.data;
    if (!thesis) return res.status(404).json({ error: 'Thesis가 없습니다.' });
    const { trackThesisValidity } = await import('./gemini.js');
    const result = await trackThesisValidity(thesis, analysisResult, thesis.name || code);
    res.json(result);
  } catch (e) {
    res.status(e.message?.includes('한도') ? 429 : 500).json({ error: e.message });
  }
});

// ── /api/calendar ──────────────────────────────────────────────────
const calendarCache = new Map(); // key=codes_hash, { data, ts }
const CALENDAR_TTL = 60 * 60 * 1000; // 1h

app.get('/api/calendar', async (req, res) => {
  const codes = (req.query.codes || '').split(',').filter(Boolean).slice(0, 30);
  if (!codes.length) return res.json({ items: [] });
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) return res.json({ items: [] });

  const cacheKey = [...codes].sort().join(',');
  const hit = calendarCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CALENDAR_TTL) return res.json(hit.data);

  try {
    const results = await Promise.allSettled(
      codes.map(async (code) => {
        const corpCode = CORP_MAP[code];
        if (!corpCode) return [];
        const discs = await fetchDartDisclosures(corpCode, dartKey);
        return discs.map(d => ({ ...d, code, name: '' }));
      })
    );
    const items = results
      .flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 50);

    // Enrich with stock names from watchlist/portfolio (best-effort)
    const nameMap = {};
    try {
      const { data: wl } = await getSupabase()
        .from('kt_watchlist')
        .select('code,name')
        .eq('user_email', req.user.email);
      (wl || []).forEach(r => { nameMap[r.code] = r.name; });
      const { data: ph } = await getSupabase()
        .from('kt_trades')
        .select('code,name')
        .eq('user_email', req.user.email);
      (ph || []).forEach(r => { nameMap[r.code] = r.name; });
    } catch {}
    items.forEach(item => { if (nameMap[item.code]) item.name = nameMap[item.code]; });

    const payload = { items };
    calendarCache.set(cacheKey, { data: payload, ts: Date.now() });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

app.get('/api/gemini/market', async (req, res) => {
  // 캐시 히트 (4시간) — Gemini 429 방지
  if (cache.geminiMarket.data && Date.now() - cache.geminiMarket.ts < CACHE_TTL_GEMINI_MARKET) {
    return res.json({ ...cache.geminiMarket.data, fromCache: true });
  }
  try {
    const macroRes = await fetch(`http://localhost:${PORT}/api/macro`, {
      headers: { authorization: req.headers.authorization },
    });
    const macroData = await macroRes.json();
    const { analyzeMarket } = await import('./gemini.js');
    const result = await analyzeMarket(macroData);
    cache.geminiMarket = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    // 캐시가 만료됐더라도 이전 데이터가 있으면 반환 (429 루프 방지)
    if (cache.geminiMarket.data) {
      return res.json({ ...cache.geminiMarket.data, fromCache: true, stale: true });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── /api/brief/morning — 아침 브리핑 (앱 내 카드용) ──────────────
app.get('/api/brief/morning', async (req, res) => {
  try {
    const brief = await getLatestMorningBrief();
    res.json({ brief });
  } catch (e) {
    res.status(500).json({ error: e.message, brief: null });
  }
});

// ── /api/scan/us — 미국 스캔 결과 (다우30+나스닥100 핵심) ─────────
app.get('/api/scan/us', async (req, res) => {
  try {
    const data = await getUsScan();
    res.json(data || { stocks: [], count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message, stocks: [] });
  }
});

// ── AI 키 설정 (마스터) — Render 환경변수 없이 DB에 보관 ─────────
app.get('/api/admin/ai-key', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const envKey = process.env.GEMINI_API_KEY;
    const dbKey  = envKey ? null : await getAppConfig('gemini_api_key');
    const k = envKey || dbKey;
    res.json({
      set: !!k,
      source: envKey ? 'env(Render)' : (dbKey ? 'db(설정화면)' : 'none'),
      masked: k ? `${k.slice(0, 4)}...${k.slice(-4)}` : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ai-key', authMiddleware, adminMiddleware, async (req, res) => {
  const key = (req.body?.key || '').trim();
  if (key.length < 20) return res.status(400).json({ error: '유효한 키를 입력하세요 (AI Studio 키는 보통 AIza로 시작)' });
  try {
    await setAppConfig('gemini_api_key', key);
    res.json({ ok: true, masked: `${key.slice(0, 4)}...${key.slice(-4)}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DART 재무 캐시 전체 삭제 (마스터) — 스코어링 변경 후 강제 재수집 ──
app.post('/api/admin/clear-dart-cache', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const n = await clearDartCache();
    res.json({ ok: true, cleared: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DART 기업코드 매핑 갱신 (마스터) — 전체 상장사 corp_code 적재 ──
app.post('/api/admin/refresh-corpcodes', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { refreshCorpCodes } = await import('./cron.js');
    const r = await refreshCorpCodes();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/portfolio ─────────────────────────────────────────────────
app.get('/api/portfolio/holdings', async (req, res) => {
  try {
    const holdings = await getHoldings(req.user.email);
    res.json({ holdings });
  } catch (e) {
    res.status(500).json({ error: e.message, holdings: [] });
  }
});

app.get('/api/portfolio/trades', async (req, res) => {
  const code = req.query.code || null;
  try {
    const trades = await getTrades(req.user.email, code);
    res.json({ trades });
  } catch (e) {
    res.status(500).json({ error: e.message, trades: [] });
  }
});

app.post('/api/portfolio/trade', async (req, res) => {
  const { code, name, market, trade_type, shares, price, trade_date, memo } = req.body || {};
  if (!code || !name || !trade_type || !shares || !price || !trade_date)
    return res.status(400).json({ error: 'code, name, trade_type, shares, price, trade_date 필요' });
  if (!['buy', 'sell'].includes(trade_type))
    return res.status(400).json({ error: 'trade_type은 buy 또는 sell' });
  try {
    const trade = await addTrade(req.user.email, { code, name, market, trade_type, shares, price, trade_date, memo });
    res.json({ ok: true, trade });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/portfolio/trade/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id 필요' });
  try {
    await deleteTrade(req.user.email, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/thesis ────────────────────────────────────────────────────
app.get('/api/thesis', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    try { const items = await listTheses(req.user.email); return res.json({ items }); }
    catch (e) { return res.status(500).json({ error: e.message, items: [] }); }
  }
  try {
    const thesis = await getThesis(req.user.email, code);
    res.json(thesis || { code, story: '', growth: '', valuation: '', exit_plan: '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/thesis', async (req, res) => {
  const { code, name, story, growth, valuation, exit_plan } = req.body;
  if (!code) return res.status(400).json({ error: 'code 필요' });
  try {
    const result = await upsertThesis(req.user.email, { code, name, story, growth, valuation, exit_plan });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/thesis/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const { error } = await getSupabase().from('kt_thesis')
      .delete().eq('user_email', req.user.email).eq('code', code);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/watchlist ─────────────────────────────────────────────────
app.get('/api/watchlist', async (req, res) => {
  try {
    const items = await getWatchlist(req.user.email);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

app.post('/api/watchlist', async (req, res) => {
  const { code, name, market } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code, name 필요' });
  try {
    const item = await addToWatchlist(req.user.email, code, name, market || '');
    res.json({ ok: true, item });
  } catch (e) {
    const status = e.message?.includes('최대') || e.message?.includes('이미') ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

app.delete('/api/watchlist/:code', async (req, res) => {
  const code = req.params.code.replace(/\D/g, '').slice(0, 6);
  if (!code) return res.status(400).json({ error: 'code 필요' });
  try {
    await removeFromWatchlist(req.user.email, code);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/alert-settings ────────────────────────────────────────────
app.get('/api/alert-settings', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('alert_settings')
      .select('*')
      .eq('user_email', req.user.email)
      .order('code');
    if (error) throw error;
    res.json({ settings: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message, settings: [] });
  }
});

app.post('/api/alert-settings', authMiddleware, async (req, res) => {
  const { code, target_price, stop_loss, rsi_high, rsi_low, is_active } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code 필요' });
  const row = {
    user_email: req.user.email,
    code: code.trim().slice(0, 6),
    target_price: target_price != null ? Number(target_price) : null,
    stop_loss: stop_loss != null ? Number(stop_loss) : null,
    rsi_high: rsi_high != null ? Number(rsi_high) : null,
    rsi_low: rsi_low != null ? Number(rsi_low) : null,
    is_active: is_active !== false,
  };
  try {
    const { data, error } = await getSupabase()
      .from('alert_settings')
      .upsert(row, { onConflict: 'user_email,code' })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, setting: data });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/alert-settings/:code', authMiddleware, async (req, res) => {
  const code = req.params.code.replace(/\D/g, '').slice(0, 6);
  if (!code) return res.status(400).json({ error: 'code 필요' });
  try {
    const { error } = await getSupabase()
      .from('alert_settings')
      .delete()
      .eq('user_email', req.user.email)
      .eq('code', code);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── React SPA 폴백 (모든 미매칭 GET → index.html) ────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// ── 자동 마이그레이션 (서버 시작 시 schema.sql 자동 적용) ──────────
async function autoMigrate() {
  if (!process.env.DATABASE_URL) {
    console.log('[AutoMigrate] DATABASE_URL 미설정 — 건너뜀');
    return;
  }
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const { default: fsModule } = await import('fs');
    const rawSql = fsModule.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = rawSql.split(';').map(s => s.trim()).filter(Boolean);
    let ok = 0, skip = 0;
    for (const stmt of statements) {
      try { await client.query(stmt); ok++; } catch { skip++; }
    }
    await client.end();
    console.log(`[AutoMigrate] 완료 — ${ok}개 실행, ${skip}개 건너뜀`);
  } catch (e) {
    console.error('[AutoMigrate] 오류 (서비스 계속 실행):', e.message);
  }
}

// ── 서버 시작 ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`KT Trading API → http://localhost:${PORT}`);
  await autoMigrate();
  startCron();
});
