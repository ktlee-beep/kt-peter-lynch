-- KT Trading — Supabase PostgreSQL 스키마
-- 기존 ERP 테이블과 충돌 방지: kt_ 접두사 사용
-- 실행: Supabase 대시보드 → SQL Editor 에서 붙여넣기 후 실행

-- ── 종목 마스터 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kt_stocks (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  market        TEXT NOT NULL,
  sector        TEXT,
  is_active     INTEGER DEFAULT 1,
  yahoo_suffix  TEXT DEFAULT 'KS',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 일별 분석 결과 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kt_daily_analysis (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT NOT NULL,
  analysis_date   DATE NOT NULL,
  signal          TEXT NOT NULL DEFAULT 'HOLD',
  confidence      INTEGER DEFAULT 0,
  lynch_score     REAL DEFAULT 0,
  livermore_score REAL DEFAULT 0,
  piotroski_score INTEGER DEFAULT 0,
  combined_score  REAL DEFAULT 0,
  rsi             REAL,
  macd_cross      TEXT,
  close_price     INTEGER,
  change_rate     REAL,
  vol_ratio       REAL,
  analysis_json   TEXT,
  data_source     TEXT DEFAULT 'on-demand',
  scan_batch_id   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (code, analysis_date),
  -- PostgREST 임베드(kt_stocks(...)) 해석에 필요한 FK. 신규 생성 시 인라인 적용.
  CONSTRAINT fk_kt_daily_code FOREIGN KEY (code) REFERENCES kt_stocks (code)
);

CREATE INDEX IF NOT EXISTS idx_kt_daily_date_signal ON kt_daily_analysis (analysis_date, signal);
CREATE INDEX IF NOT EXISTS idx_kt_daily_code ON kt_daily_analysis (code);

-- 이미 테이블이 존재(FK 없이 생성)하는 배포 대상: 멱등 FK 추가
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_kt_daily_code'
      AND table_name = 'kt_daily_analysis'
  ) THEN
    ALTER TABLE kt_daily_analysis
      ADD CONSTRAINT fk_kt_daily_code FOREIGN KEY (code) REFERENCES kt_stocks (code);
  END IF;
END $$;

-- PostgREST 스키마 캐시 갱신 (테이블/관계 변경 후 즉시 반영)
NOTIFY pgrst, 'reload schema';

-- ── 스캔 배치 로그 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kt_scan_batches (
  batch_id      TEXT PRIMARY KEY,
  scan_type     TEXT DEFAULT 'daily',
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  total_stocks  INTEGER DEFAULT 0,
  processed     INTEGER DEFAULT 0,
  failed        INTEGER DEFAULT 0,
  buy_signals   INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'running'
);

-- ── 매크로 스냅샷 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kt_macro_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  snapshot_at  TIMESTAMPTZ DEFAULT NOW(),
  usdkrw       REAL,
  kospi        REAL,
  kosdaq       REAL,
  vix          REAL,
  us10y        REAL,
  raw_json     TEXT
);

-- ── 재무 캐시 ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kt_fundamentals_cache (
  code        TEXT PRIMARY KEY,
  raw_json    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 앱 사용자 (마스터가 직접 발급) ───────────────────────────────
CREATE TABLE IF NOT EXISTS app_users (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  memo          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- ── 이메일 인증 (회원가입 시 인증코드 임시 저장) ──────────────────
-- 인증 성공 시 app_users로 이관 후 삭제. code_hash/password_hash 모두 bcrypt.
CREATE TABLE IF NOT EXISTS email_verifications (
  email         TEXT PRIMARY KEY,
  code_hash     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  attempts      INT  NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 종목 마스터 시드 (KOSPI + KOSDAQ 주요 종목) ───────────────────
INSERT INTO kt_stocks (code, name, market, sector, yahoo_suffix) VALUES
  ('005930','삼성전자','KOSPI','반도체·전자','KS'),
  ('000660','SK하이닉스','KOSPI','반도체·전자','KS'),
  ('003670','포스코퓨처엠','KOSPI','이차전지','KS'),
  ('373220','LG에너지솔루션','KOSPI','이차전지','KS'),
  ('207940','삼성바이오로직스','KOSPI','바이오·헬스','KS'),
  ('005380','현대차','KOSPI','자동차','KS'),
  ('000270','기아','KOSPI','자동차','KS'),
  ('035420','NAVER','KOSPI','IT·인터넷','KS'),
  ('035720','카카오','KOSPI','IT·인터넷','KS'),
  ('028260','삼성물산','KOSPI','건설·유통','KS'),
  ('105560','KB금융','KOSPI','금융','KS'),
  ('055550','신한지주','KOSPI','금융','KS'),
  ('086790','하나금융지주','KOSPI','금융','KS'),
  ('316140','우리금융지주','KOSPI','금융','KS'),
  ('032830','삼성생명','KOSPI','보험','KS'),
  ('000810','삼성화재','KOSPI','보험','KS'),
  ('012330','현대모비스','KOSPI','자동차부품','KS'),
  ('006400','삼성SDI','KOSPI','이차전지','KS'),
  ('066570','LG전자','KOSPI','전자','KS'),
  ('051910','LG화학','KOSPI','화학','KS'),
  ('096770','SK이노베이션','KOSPI','에너지·화학','KS'),
  ('034730','SK','KOSPI','지주','KS'),
  ('017670','SK텔레콤','KOSPI','통신','KS'),
  ('030200','KT','KOSPI','통신','KS'),
  ('003550','LG','KOSPI','지주','KS'),
  ('010140','삼성중공업','KOSPI','조선','KS'),
  ('329180','현대중공업','KOSPI','조선','KS'),
  ('042660','한화오션','KOSPI','조선','KS'),
  ('000120','CJ대한통운','KOSPI','운송·물류','KS'),
  ('011200','HMM','KOSPI','해운','KS'),
  ('003490','대한항공','KOSPI','항공','KS'),
  ('010950','S-Oil','KOSPI','에너지','KS'),
  ('009830','한화솔루션','KOSPI','화학·에너지','KS'),
  ('034220','LG디스플레이','KOSPI','디스플레이','KS'),
  ('009150','삼성전기','KOSPI','전자부품','KS'),
  ('000100','유한양행','KOSPI','제약','KS'),
  ('128940','한미약품','KOSPI','제약','KS'),
  ('326030','SK바이오팜','KOSPI','바이오','KS'),
  ('302440','SK바이오사이언스','KOSPI','바이오','KS'),
  ('352820','하이브','KOSPI','엔터','KS'),
  ('004020','현대제철','KOSPI','철강','KS'),
  ('005490','POSCO홀딩스','KOSPI','철강','KS'),
  ('011780','금호석유','KOSPI','화학','KS'),
  ('010130','고려아연','KOSPI','비철금속','KS'),
  ('000720','현대건설','KOSPI','건설','KS'),
  ('006360','GS건설','KOSPI','건설','KS'),
  ('007070','GS리테일','KOSPI','유통','KS'),
  ('069960','현대백화점','KOSPI','유통','KS'),
  ('023530','롯데쇼핑','KOSPI','유통','KS'),
  ('267250','HD현대','KOSPI','지주','KS'),
  ('000880','한화','KOSPI','지주','KS'),
  ('139480','이마트','KOSPI','유통','KS'),
  ('097950','CJ제일제당','KOSPI','식품','KS'),
  ('042700','한미반도체','KOSPI','반도체장비','KS'),
  ('014680','한솔케미칼','KOSPI','화학','KS'),
  ('015760','한국전력','KOSPI','공기업·에너지','KS'),
  ('024110','기업은행','KOSPI','금융','KS'),
  ('138040','메리츠금융지주','KOSPI','금융','KS'),
  ('016360','삼성증권','KOSPI','증권','KS'),
  ('006800','미래에셋증권','KOSPI','증권','KS'),
  ('034020','두산에너빌리티','KOSPI','에너지기계','KS'),
  ('204320','만도','KOSPI','자동차부품','KS'),
  -- KOSDAQ
  ('039030','이오테크닉스','KOSDAQ','레이저장비','KQ'),
  ('058610','에스에프에이','KOSDAQ','장비','KQ'),
  ('196170','알테오젠','KOSDAQ','바이오','KQ'),
  ('263750','펄어비스','KOSDAQ','게임','KQ'),
  ('293490','카카오게임즈','KOSDAQ','게임','KQ'),
  ('112040','위메이드','KOSDAQ','게임','KQ'),
  ('035760','CJ ENM','KOSDAQ','미디어·엔터','KQ'),
  ('053800','안랩','KOSDAQ','보안SW','KQ'),
  ('068270','셀트리온','KOSDAQ','바이오','KQ'),
  ('214150','클래시스','KOSDAQ','의료기기','KQ'),
  ('357780','솔브레인','KOSDAQ','반도체소재','KQ'),
  ('089030','테크윙','KOSDAQ','반도체장비','KQ'),
  ('276730','제주항공','KOSDAQ','항공','KQ'),
  ('317770','현대오토에버','KOSDAQ','IT서비스','KQ'),
  ('012860','에스앤에스텍','KOSDAQ','반도체소재','KQ'),
  ('418470','HD현대마린솔루션','KOSDAQ','조선서비스','KQ'),
  ('247540','에코프로비엠','KOSDAQ','이차전지','KQ'),
  ('086520','에코프로','KOSDAQ','이차전지','KQ'),
  ('041510','에스엠','KOSDAQ','엔터','KQ'),
  ('035900','JYP엔터테인먼트','KOSDAQ','엔터','KQ'),
  ('122870','와이지엔터테인먼트','KOSDAQ','엔터','KQ')
ON CONFLICT (code) DO NOTHING;
