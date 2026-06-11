// API 전수 점검 스크립트 — 모든 주요 GET 엔드포인트 상태 확인
import 'dotenv/config';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const email = process.env.MASTER_EMAIL || 'ktlee@enova.co.kr';
const password = process.env.MASTER_PASS;
if (!password) { console.error('MASTER_PASS 없음'); process.exit(1); }

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const loginData = await login.json();
if (!login.ok) { console.error('로그인 실패:', login.status, loginData); process.exit(1); }
const token = loginData.token;
console.log('로그인 OK');

const endpoints = [
  '/api/market',
  '/api/quotes?codes=005930,000660',
  '/api/analysis?code=005930',
  '/api/naver-stock/005930',
  '/api/stock/search?q=삼성',
  '/api/news/home',
  '/api/news?code=005930',
  '/api/macro',
  '/api/movers',
  '/api/scan/results',
  '/api/scan/status',
  '/api/history/005930',
  '/api/screener?preset=lynch',
  '/api/52w?dir=high',
  '/api/peers?code=005930',
  '/api/sectors',
  '/api/financials?code=005930',
  '/api/disclosures?code=005930',
  '/api/supply?code=005930',
  '/api/supply-ranking',
  '/api/calendar',
  '/api/index-chart/KOSPI',
  '/api/portfolio/holdings',
  '/api/portfolio/trades',
  '/api/watchlist',
  '/api/thesis?code=005930',
  '/api/alert-settings',
  '/api/alerts',
];

for (const ep of endpoints) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${ep}`, { headers: { Authorization: `Bearer ${token}` } });
    const ms = Date.now() - t0;
    let info = '';
    const text = await r.text();
    if (!r.ok) {
      info = ' → ' + text.slice(0, 120);
    } else {
      try {
        const d = JSON.parse(text);
        const keys = Array.isArray(d) ? `array(${d.length})` : Object.keys(d).slice(0, 5).join(',');
        info = ` [${keys}]`;
      } catch { info = ' [non-json]'; }
    }
    console.log(`${r.status} ${String(ms).padStart(5)}ms ${ep}${info}`);
  } catch (e) {
    console.log(`ERR  ${ep} → ${e.message}`);
  }
}
