-- KT Trading: alert_settings 테이블 생성
-- Supabase SQL Editor에서 실행하거나 /api/admin/init-tables 엔드포인트로 자동 실행

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

-- 업데이트 시 updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION update_alert_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS alert_settings_updated_at_trigger ON alert_settings;
CREATE TRIGGER alert_settings_updated_at_trigger
  BEFORE UPDATE ON alert_settings
  FOR EACH ROW EXECUTE FUNCTION update_alert_settings_updated_at();

-- Row Level Security (개인용 앱이므로 서비스 롤 키로만 접근 — RLS 비활성화)
ALTER TABLE alert_settings DISABLE ROW LEVEL SECURITY;
