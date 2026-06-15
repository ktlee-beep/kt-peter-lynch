-- DART 기업코드 매핑 (전체 상장사 code → corp_code) + DART 재무 캐시
CREATE TABLE IF NOT EXISTS kt_corp_codes (
  code        TEXT PRIMARY KEY,
  corp_code   TEXT NOT NULL,
  corp_name   TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kt_dart_cache (
  code        TEXT PRIMARY KEY,
  dart_json   TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
