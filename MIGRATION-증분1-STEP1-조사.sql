-- =====================================================================
-- 증분 1 착수 전 조사 질의 (STEP 1) — 읽기 전용. 쓰기 문장 없음.
-- 실행 위치: Supabase 대시보드 > SQL Editor
-- 승인: 사용자 승인 2026-09-14 (질의 5건)
-- 소요: 전부 합쳐 수 초. 락을 잡지 않는다.
--
-- 왜 필요한가 (질의 -> 이 결과로 확정되는 것)
--   Q5 -> P2 전제조건. PG 11 미만이면 ADD COLUMN ... DEFAULT 가 테이블을
--         전량 재작성한다. 그러면 DDL 을 DEFAULT 없이 쪼개야 한다.
--   Q3 -> CREATE INDEX 가 장 마감 후 ~ 20:00 KST 창에 들어가는지 판단.
--   Q1 -> data_source NULL 레거시 행 유무. 'cron-holiday' 신설 시 비교문 영향.
--   Q2 -> L-4 임계값 교정. 현재 사양의 6시간은 근거 없는 수치다 [확인 필요].
--   Q4 -> 신설 대상 컬럼이 이미 있는지. 있으면 DDL 에서 빼야 한다.
--   X1/X2 -> 인덱스 중복 여부, 테이블 물리 크기.
--
-- 결과 전달: 각 블록 결과를 그대로 붙여넣어 주시면 된다.
--            개인정보·자격증명이 나오는 질의는 없다.
-- =====================================================================


-- [Q5] PostgreSQL 버전  ** 착수 전제조건 P2 **
SHOW server_version;


-- [Q3] kt_daily_analysis 전수 행수
SELECT count(*)::bigint AS total_rows FROM kt_daily_analysis;


-- [Q1] data_source 분포 (NULL 포함)
SELECT coalesce(data_source, '(NULL)') AS data_source,
       count(*)::bigint AS n
  FROM kt_daily_analysis
 GROUP BY 1
 ORDER BY 2 DESC;


-- [Q2-a] kt_scan_batches 요약 — completed_at 기입률과 미완료 잔류 배치
SELECT count(*)::bigint                                          AS total,
       count(completed_at)::bigint                               AS with_completed,
       count(*) FILTER (WHERE status = 'running')::bigint         AS running_now,
       count(*) FILTER (WHERE status = 'running'
                        AND started_at < now() - interval '6 hours')::bigint
                                                                 AS running_over_6h
  FROM kt_scan_batches;


-- [Q2-b] 스캔 유형별 소요시간 분포 — L-4 임계값의 실제 근거
SELECT scan_type,
       count(*)::bigint AS n,
       round((avg(extract(epoch FROM (completed_at - started_at))) / 60.0)::numeric, 1) AS avg_min,
       round((max(extract(epoch FROM (completed_at - started_at))) / 60.0)::numeric, 1) AS max_min,
       round(((percentile_cont(0.95) WITHIN GROUP (
                ORDER BY extract(epoch FROM (completed_at - started_at)))) / 60.0)::numeric, 1) AS p95_min
  FROM kt_scan_batches
 WHERE completed_at IS NOT NULL
   AND started_at  IS NOT NULL
 GROUP BY 1
 ORDER BY 2 DESC;


-- [Q4] 신설 대상 컬럼의 기존 존재 여부 + 기존 관련 컬럼의 실제 타입
SELECT table_name, column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (
        (table_name = 'kt_daily_analysis' AND column_name IN
           ('engine', 'horizon_days', 'composite_score', 'decided_count', 'reason_tags',
            'confidence', 'signal', 'data_source', 'scan_batch_id', 'reasons', 'analysis_date'))
     OR (table_name = 'kt_scan_batches' AND column_name IN
           ('gate_tally', 'analysis_date', 'status', 'started_at', 'completed_at', 'scan_type'))
       )
 ORDER BY table_name, column_name;


-- [X1] 두 테이블의 기존 인덱스 — 신설 인덱스와 중복되는지
SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN ('kt_daily_analysis', 'kt_scan_batches')
 ORDER BY 1, 2;


-- [X2] kt_daily_analysis 물리 크기 — 인덱스 빌드 시간 추정의 실제 입력
SELECT pg_size_pretty(pg_total_relation_size('kt_daily_analysis')) AS total_size,
       pg_size_pretty(pg_relation_size('kt_daily_analysis'))       AS heap_size;


-- =====================================================================
-- 여기까지가 STEP 1. DDL(STEP 2)은 위 결과를 받은 뒤 별도 파일로 확정한다.
-- STEP 2 는 장 마감 후 ~ 20:00 KST 스캔 이전 창에서 1회만 실행한다.
-- =====================================================================
