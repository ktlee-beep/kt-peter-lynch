/**
 * alert_settings 테이블 생성 스크립트
 * 실행: node scripts/create-alert-settings.mjs
 *
 * 필수 환경변수 (Render 대시보드에서 복사):
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *
 * 실행 방법:
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."
 *   node scripts/create-alert-settings.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL 및 SUPABASE_SERVICE_ROLE_KEY 환경변수를 설정하세요.');
  process.exit(1);
}

const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];

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
);
`;

async function run() {
  // Supabase Management API - 프로젝트 DB 쿼리 실행
  const mgmtUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

  console.log(`프로젝트: ${projectRef}`);
  console.log('Management API로 테이블 생성 시도...');

  const resp = await fetch(mgmtUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Management API는 personal access token이 필요하므로
      // service role key로 직접 PostgREST 경유 방식 사용
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ query: SQL }),
  });

  if (resp.ok) {
    const data = await resp.json();
    console.log('완료:', data);
    return;
  }

  // Management API 실패 시 → pg 직접 연결 시도
  console.log(`Management API 실패 (${resp.status}). pg 직접 연결 시도...`);

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL도 설정되지 않았습니다. 아래 SQL을 Supabase SQL Editor에서 실행하세요:\n');
    console.log(SQL);
    process.exit(1);
  }

  const { default: pg } = await import('pg');
  const { Client } = pg;
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(SQL);
    console.log('alert_settings 테이블 생성 완료 (pg 직접 연결)');
  } finally {
    await client.end();
  }
}

run().catch(e => {
  console.error('오류:', e.message);
  console.error('\nSupabase SQL Editor에서 아래 SQL을 직접 실행하세요:\n');
  console.error(SQL);
  process.exit(1);
});
