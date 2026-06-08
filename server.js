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
import fs from 'fs';
import pg from 'pg';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { startCron } from './cron.js';
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
  CORP_MAP, fetchYahooSummary, fetchDartFinancials, fetchNaverFundamentals,
  krxStock, naverStock, naverHistory, yahooStock,
  krxHistory, yahooHistory, isValidYahooResult,
  fetchDartDisclosures, fetchYahooNews,
  KRX_INDICES, YAHOO_SYMBOLS, fetchIndex, fetchYahooSymbol, fetchIndexOHLCV,
  KS_UNIVERSE, KQ_UNIVERSE,
} from './data.js';
import { saveAnalysisToDB, getScanResults, getScanStatus, getStockHistory, getMacroHistory, saveMacroSnapshot, validateAppUser, getAppUsers, createAppUser, deleteAppUser, updateAppUserPassword, getSupabase } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

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
// JWT_SECRET: Render 환경변수에서 반드시 설정. 미설정 시 시작 거부
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET 환경변수가 설정되지 않았습니다. Render 대시보드에서 설정하세요.');
  process.exit(1);
}
const MASTER_EMAIL    = process.env.MASTER_EMAIL || 'dlrudxo002@gmail.com';
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

// ── 정적 파일 서빙 (index.html, login.html) ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// ── 인메모리 캐시 (무버스, 매크로) ─────────────────────────────
const cache = {
  movers:     { data: null, ts: 0 },
  macro:      { data: null, ts: 0 },
  indexChart: {},   // keyed by id, each { data, ts }
};
const CACHE_TTL_MOVERS     = 60 * 60 * 1000; // 1시간
const CACHE_TTL_MACRO      = 30 * 60 * 1000; // 30분
const CACHE_TTL_INDEX_CHART = 60 * 60 * 1000; // 1시간

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

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

// ── 어드민 미들웨어 ───────────────────────────────────────────────
function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'master') return res.status(403).json({ error: '마스터 계정만 접근 가능합니다' });
  next();
}

// ── /api/migrate (일회성 스키마 초기화, JWT 불필요 — SCAN_SECRET으로 보호) ──
app.post('/api/migrate', async (req, res) => {
  const secret = req.headers['x-scan-secret'];
  if (!process.env.SCAN_SECRET || secret !== process.env.SCAN_SECRET) {
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

// 이하 모든 /api/* 는 인증 필요
app.use('/api', authMiddleware);

// ── 헬스체크 (Render keep-alive, UptimeRobot 용) ─────────────────
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));


// ── /api/quotes ──────────────────────────────────────────────────
app.get('/api/quotes', async (req, res) => {
  const codes = (req.query.codes || '').split(',').filter(Boolean).slice(0, 30);
  if (!codes.length) return res.status(400).json({ error: 'codes 파라미터 필요' });
  const quotes = await Promise.all(codes.map(async code => {
    const krx = await krxStock(code);
    return krx ?? (await yahooStock(code));
  }));
  res.json({ quotes, serverTime: Date.now(), count: quotes.length });
});

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
    const high52w = Math.max(...closes.slice(-125));
    const low52w  = Math.min(...closes.slice(-125));
    const macd    = calcMACD(closes);
    const bb      = calcBollinger(closes);
    const atr     = calcATR(highs, lows, closes);
    const mdd     = calcMDD(closes);
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
      high52w, low52w, deviation: ma20.at(-1) ? (price / ma20.at(-1) - 1) * 100 : 0,
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
  const high52w2 = Math.max(...vc.slice(-125));
  const low52w2  = Math.min(...vc.slice(-125));
  const macd2    = calcMACD(vc);
  const bb2      = calcBollinger(vc);
  const atr2     = calcATR(vh, vl, vc);
  const mdd2     = calcMDD(vc);
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
    high52w: high52w2, low52w: low52w2, deviation: ma20.at(-1) ? (last / ma20.at(-1) - 1) * 100 : 0,
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
  const [krxResults, yahooResults] = await Promise.all([
    Promise.all(KRX_INDICES.map(e => fetchIndex(e))),
    Promise.all(YAHOO_SYMBOLS.map(fetchYahooSymbol)),
  ]);
  res.json({ market: [...krxResults, ...yahooResults], serverTime: Date.now() });
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

// ── /api/ai-guide (피터린치 AI 투자 가이드 — 룰 기반) ────────────────
app.post('/api/ai-guide', async (req, res) => {
  try {
    const { code, name, buyPrice, currentPrice, profitPct, analysis, market } = req.body ?? {};
    if (!code || !name) return res.status(400).json({ error: 'code, name 필수' });

    const rsi        = analysis?.rsi ?? null;
    const macdCross  = analysis?.macd?.lastCross ?? null;
    const bb         = analysis?.bb ?? null;
    const ma5        = analysis?.ma5 ?? null;
    const ma20       = analysis?.ma20 ?? null;
    const ma60       = analysis?.ma60 ?? null;
    const near52w    = analysis?.near52wHigh ?? false;
    const signal     = analysis?.combinedSignal?.signal ?? analysis?.signal ?? 'HOLD';
    const confidence = analysis?.combinedSignal?.confidence ?? 50;
    const pScore     = analysis?.pScore ?? 0;
    const lScore     = analysis?.lScore ?? 0;
    const profit     = typeof profitPct === 'number' ? profitPct : 0;
    const cur        = typeof currentPrice === 'number' ? currentPrice : 0;
    const buyPx      = typeof buyPrice === 'number' ? buyPrice : 0;

    const isDeadCross   = macdCross === 'dead';
    const isGoldenCross = macdCross === 'golden';
    const maAligned     = ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60;
    const maInverted    = ma5 && ma20 && ma5 < ma20;
    const rsiOverbought = rsi !== null && rsi > 75;
    const rsiOversold   = rsi !== null && rsi < 30;

    const mktArr      = Array.isArray(market) ? market : [];
    const kospiChg    = mktArr.find(m => m.id === 'kospi')?.changeRate ?? 0;
    const kosdaqChg   = mktArr.find(m => m.id === 'kosdaq')?.changeRate ?? 0;
    const marketWeak  = kospiChg < -1 || kosdaqChg < -1;

    // 판정
    let verdict = '관망';
    if (profit <= -15 || (profit < -8 && isDeadCross)) {
      verdict = '손절검토';
    } else if (
      (profit >= 30 && (isDeadCross || signal === 'SELL')) ||
      (profit >= 25 && rsiOverbought) ||
      (signal === 'SELL' && confidence >= 65 && profit > 5)
    ) {
      verdict = '매도검토';
    } else if ((isGoldenCross || maAligned) && !rsiOverbought && profit > -5) {
      verdict = '보유';
    }

    // 보유 이유
    const holdReasons = [];
    if (isGoldenCross)                                 holdReasons.push('MACD 골든크로스 — 추세 상승 전환 신호');
    if (maAligned)                                     holdReasons.push('단·중·장기 이동평균 정배열 — 강세 추세 유지');
    if (rsi !== null && rsi >= 50 && rsi <= 70)        holdReasons.push(`RSI ${Math.round(rsi)} — 적정 모멘텀 구간`);
    if (near52w)                                       holdReasons.push('52주 신고가 근접 — 상승 모멘텀 지속');
    if (pScore >= 50)                                  holdReasons.push(`피터린치 점수 ${pScore}점 — 펀더멘털 양호`);
    if (lScore >= 50)                                  holdReasons.push(`리버모어 점수 ${lScore}점 — 기술적 추세 양호`);
    if (bb && bb.percentB >= 40 && bb.percentB <= 80) holdReasons.push('볼린저밴드 중간권 — 추세 안정적');

    // 매도 트리거
    const sellTriggers = [];
    if (isDeadCross)            sellTriggers.push('MACD 데드크로스 — 즉시 비중 축소 검토');
    if (rsiOverbought)          sellTriggers.push(`RSI ${Math.round(rsi)} 과매수 구간 — 기술적 조정 가능성`);
    if (maInverted)             sellTriggers.push('단기 이동평균 하락 이탈 — 추세 약화 신호');
    if (profit >= 20)           sellTriggers.push(`수익률 ${Math.round(profit)}% 달성 — 분할 익절 고려`);
    if (bb && bb.percentB > 90) sellTriggers.push('볼린저밴드 상단 돌파 — 과열 구간');
    if (!sellTriggers.length)   sellTriggers.push('뚜렷한 매도 신호 없음 — 손절 기준 준수 시 보유 유효');

    // 리스크
    const riskFactors = [];
    if (profit < -5)                    riskFactors.push(`평가손실 ${Math.abs(Math.round(profit))}% — 추가 방어선 설정 권고`);
    if (rsiOversold)                    riskFactors.push(`RSI ${Math.round(rsi)} 과매도 — 반등 전 추가 하락 가능성`);
    if (marketWeak)                     riskFactors.push('지수 하락 국면 — 시장 전반 약세로 개별주 영향 주의');
    if (isDeadCross && profit > 0)      riskFactors.push('익절 구간에서 데드크로스 발생 — 수익 반납 리스크');
    if (!riskFactors.length)            riskFactors.push('현재 구간 내 주요 리스크 지표 미감지');

    // 손절 기준
    const stopBase = cur > 0 ? cur : buyPx;
    const stopLossPrice = stopBase > 0 ? Math.round(stopBase * 0.9) : 0;
    const stopLoss = stopLossPrice > 0
      ? `₩${stopLossPrice.toLocaleString()} (현재가 대비 -10%)`
      : '현재가 기준 -10% 이탈 시 손절 권고';

    // 요약
    const profitStr = profit >= 0 ? `+${Math.round(profit)}%` : `${Math.round(profit)}%`;
    const summaryMap = {
      '보유':     `${name} ${profitStr} — 기술적 추세 양호, 보유 유지 권고`,
      '관망':     `${name} ${profitStr} — 뚜렷한 방향성 없음, 추세 확인 후 대응`,
      '매도검토': `${name} ${profitStr} — 과매수·매도 신호 감지, 익절·비중 축소 검토`,
      '손절검토': `${name} ${profitStr} — 손절 기준 접근, 포지션 재검토 필요`,
    };
    const summary = summaryMap[verdict] ?? summaryMap['관망'];

    // 상세 추론
    const parts = [`현재가 ₩${cur > 0 ? cur.toLocaleString() : '—'}, 매수가 ₩${buyPx > 0 ? buyPx.toLocaleString() : '—'}`];
    if (rsi !== null) parts.push(`RSI ${Math.round(rsi)}${rsiOverbought ? '(과매수)' : rsiOversold ? '(과매도)' : ''}`);
    if (macdCross)    parts.push(`MACD ${isGoldenCross ? '골든크로스' : '데드크로스'}`);
    if (maAligned)    parts.push('이평선 정배열');
    else if (maInverted) parts.push('이평선 역배열');
    if (marketWeak)   parts.push('지수 약세');
    const conclusionMap = {
      '보유':     '청산 신호 없음 — 손절가 준수 하에 보유 지속 권고.',
      '관망':     '추세 불명확 — 명확한 신호 출현 시 대응.',
      '매도검토': '기술적 과열 또는 추세 반전 신호 감지 — 분할 매도 또는 비중 축소 권고.',
      '손절검토': '손실이 임계치 접근 — 추가 손실 방지를 위해 포지션 정리를 검토하세요.',
    };
    const reasoning = parts.join(', ') + '. ' + (conclusionMap[verdict] ?? conclusionMap['관망']);

    res.json({ verdict, summary, reasoning, holdReasons, sellTriggers, riskFactors, stopLoss });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const users = await getAppUsers();
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message, users: [] });
  }
});

app.post('/api/admin/users', adminMiddleware, async (req, res) => {
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

app.patch('/api/admin/users/:email', adminMiddleware, async (req, res) => {
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

app.delete('/api/admin/users/:email', adminMiddleware, async (req, res) => {
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

// ── /api/scan/trigger (수동 스캔 트리거, 내부용) ─────────────────
app.post('/api/scan/trigger', async (req, res) => {
  const secret = req.headers['x-scan-secret'];
  if (!process.env.SCAN_SECRET || secret !== process.env.SCAN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { runDailyScan } = await import('./cron.js');
  runDailyScan().catch(console.error);
  res.json({ ok: true, message: '스캔 시작됨 (비동기)' });
});

// ── /api/admin/db-diag (pg 연결 진단) ────────────────────────────
app.get('/api/admin/db-diag', adminMiddleware, async (req, res) => {
  const dbUrl = process.env.DATABASE_URL ||
    'postgresql://postgres.gvpaprczqxdhldotoxqk:enova8757%21%21@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  let result = { pgUrl: dbUrl.replace(/:[^:@]+@/, ':***@'), connected: false, tableExists: false, error: null };
  try {
    await client.connect();
    result.connected = true;
    const r = await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='kt_stocks')`);
    result.tableExists = r.rows[0].exists;
    if (!result.tableExists) {
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await client.query(sql);
      result.migrationRan = true;
      result.tableExists = true;
    }
  } catch (e) {
    result.error = e.message;
  } finally {
    await client.end().catch(() => {});
  }
  res.json(result);
});

// ── /api/admin/fix-market-codes (C-2 DB 일회성 수정) ────────────
app.post('/api/admin/fix-market-codes', adminMiddleware, async (req, res) => {
  try {
    const sb = getSupabase();

    // 1. 잘못된 KOSPI 행 5개 삭제
    const { data: deleted, error: e1 } = await sb
      .from('kt_stocks')
      .delete()
      .in('code', ['247540','086520','041510','035900','122870'])
      .eq('market', 'KOSPI')
      .select('code,name,market');
    if (e1) throw new Error('DELETE 실패: ' + e1.message);

    // 2. 만도 → KOSPI 이동
    const { error: e2 } = await sb
      .from('kt_stocks')
      .update({ market: 'KOSPI', yahoo_suffix: 'KS' })
      .eq('code', '204320');
    if (e2) throw new Error('UPDATE 만도 실패: ' + e2.message);

    // 3. 5개 KOSDAQ 종목 upsert
    const kosdaqRows = [
      { code:'247540', name:'에코프로비엠',    market:'KOSDAQ', sector:'이차전지', yahoo_suffix:'KQ' },
      { code:'086520', name:'에코프로',         market:'KOSDAQ', sector:'이차전지', yahoo_suffix:'KQ' },
      { code:'041510', name:'에스엠',            market:'KOSDAQ', sector:'엔터',    yahoo_suffix:'KQ' },
      { code:'035900', name:'JYP엔터테인먼트',  market:'KOSDAQ', sector:'엔터',    yahoo_suffix:'KQ' },
      { code:'122870', name:'와이지엔터테인먼트',market:'KOSDAQ', sector:'엔터',    yahoo_suffix:'KQ' },
    ];
    const { error: e3 } = await sb
      .from('kt_stocks')
      .upsert(kosdaqRows, { onConflict: 'code' });
    if (e3) throw new Error('UPSERT KOSDAQ 실패: ' + e3.message);

    res.json({
      ok: true,
      deleted: deleted?.map(r => `${r.code} ${r.name} (${r.market})`),
      updated: '만도(204320) → KOSPI',
      upserted: kosdaqRows.map(r => `${r.code} ${r.name} → KOSDAQ`),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DB 스키마 자동 마이그레이션 ──────────────────────────────────
async function runMigration() {
  const dbUrl = process.env.DATABASE_URL ||
    'postgresql://postgres.gvpaprczqxdhldotoxqk:enova8757%21%21@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(sql);
    console.log('[Migration] schema.sql 실행 완료 (CREATE IF NOT EXISTS — 멱등)');
  } catch (e) {
    console.error('[Migration] 스키마 마이그레이션 실패 (서버는 계속 실행):', e.message);
  } finally {
    await client.end().catch(() => {});
  }
}

// ── 서버 시작 ─────────────────────────────────────────────────────
runMigration().then(() => {
  app.listen(PORT, () => {
    console.log(`KT Trading API → http://localhost:${PORT}`);
    startCron();
  });
});
