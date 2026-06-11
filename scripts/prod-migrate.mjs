// 프로덕션 DB 마이그레이션 + 스캔 트리거 (마스터 JWT 인증)
import 'dotenv/config';

const BASE = process.env.SMOKE_BASE || 'https://kt-peter-lynch.onrender.com';
const email = process.env.MASTER_EMAIL || 'ktlee@enova.co.kr';
const password = process.env.MASTER_PASS;

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const { token } = await login.json();
if (!token) { console.error('로그인 실패'); process.exit(1); }
console.log('로그인 OK');
const h = { Authorization: `Bearer ${token}` };

const mode = process.argv[2] || 'migrate';

if (mode === 'migrate') {
  const r = await fetch(`${BASE}/api/migrate`, { method: 'POST', headers: h });
  const d = await r.json();
  console.log('migrate:', r.status, 'statements:', d.count);
  for (const s of d.results || []) {
    if (!s.ok) console.log('  FAIL:', s.stmt, '→', s.err);
  }
  const okCount = (d.results || []).filter(s => s.ok).length;
  console.log(`OK ${okCount}/${d.count}`);
} else if (mode === 'scan') {
  const r = await fetch(`${BASE}/api/scan/trigger`, { method: 'POST', headers: h });
  console.log('scan trigger:', r.status, await r.text());
} else if (mode === 'status') {
  const r = await fetch(`${BASE}/api/scan/status`, { headers: h });
  console.log('status:', r.status, JSON.stringify(await r.json()).slice(0, 300));
} else if (mode === 'results') {
  const r = await fetch(`${BASE}/api/scan/results?signal=BUY&limit=10`, { headers: h });
  const d = await r.json();
  console.log('results:', r.status, 'total:', d.total);
  for (const x of (d.results || []).slice(0, 10)) {
    console.log(` ${x.name || x.code} 린치:${x.lynch_score} 리버모어:${x.livermore_score} F:${x.piotroski_score} 신뢰도:${x.confidence}`);
  }
}
