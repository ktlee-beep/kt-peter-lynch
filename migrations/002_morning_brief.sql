-- 아침 브리핑 저장 테이블 (매 영업일 08:00 KST 생성, 1일 1행)
CREATE TABLE IF NOT EXISTS kt_morning_brief (
  brief_date  DATE PRIMARY KEY,
  brief_json  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
