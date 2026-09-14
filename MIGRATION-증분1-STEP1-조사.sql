-- =====================================================================
-- 증분 1 착수 전 조사 질의 (STEP 1) — 읽기 전용. 쓰기 문장 없음.
-- 실행 위치: Supabase 대시보드 > SQL Editor
-- 승인: 사용자 승인 2026-09-14
-- 소요: 전부 합쳐 수 초. 락을 잡지 않는다.
--
-- 2026-09-14 개정 — 프로덕션 실측으로 4건이 불필요해져 삭제했다.
--   삭제: [Q3] 전수 행수    -> /api/history 로 확인함. 005930·000660 모두 36행
--                             (2026-07-23 ~ 2026-09-14). 유니버스 1116종목이므로
--                             약 4만 행. CREATE INDEX 가 창에 들어가는지 걱정할
--                             규모가 아니다.
--   삭제: [X1] 기존 인덱스   -> schema.sql:41-42 에 두 개뿐임을 직접 확인함.
--   삭제: [X2] 물리 크기     -> 위 행수 추정으로 대체됨.
--   삭제 아님·순서 승격: [Q2-a] 를 1번으로 올렸다. 아래 사유 참조.
--
-- 왜 필요한가 (질의 -> 이 결과로 확정되는 것)
--   Q2-a -> 2026-09-14 야간 스캔이 processed=870/1116 에서 동결하고 배치 행이
--           status='running' 인 채 남은 것을 확인했다(15분간 4회 표본 동일).
--           과거에 같은 좌초가 몇 건 쌓여 있는지가 이 질의로 나온다.
--           f9dc52b 에 킵얼라이브와 markStaleBatches 를 배포했으므로,
--           이 숫자는 "고쳐지기 전까지 누적된 양"의 확정치가 된다.
--   Q5   -> P2 전제조건. PG 11 미만이면 ADD COLUMN ... DEFAULT 가 테이블을
--           전량 재작성한다. 그러면 DDL 을 DEFAULT 없이 쪼개야 한다.
--   Q4   -> 신설 대상 컬럼이 이미 있는지. 있으면 DDL 에서 빼야 한다.
--           컬럼이 없는 상태로 v2 쓰기를 올리면 PGRST204 로 요청 전체가 실패한다.
--   Q1   -> data_source NULL 레거시 행 유무. 'cron-holiday' 신설 시 비교문 영향.
--   Q2-b -> (선택) markStaleBatches 의 6시간 임계값에 대한 유일한 실측 근거.
--           현재 6시간은 근거 없는 수치다 [확인 필요]. 안 돌려도 착수는 가능하다.
--
-- 결과 전달: 각 블록 결과를 그대로 붙여넣어 주시면 된다.
--            개인정보·자격증명이 나오는 질의는 없다.
-- =====================================================================


-- [Q2-a] kt_scan_batches 요약 — completed_at 기입률과 미완료 잔류 배치
SELECT count(*)::bigint                                          AS total,
       count(completed_at)::bigint                               AS with_completed,
       count(*) FILTER (WHERE status = 'running')::bigint         AS running_now,
       count(*) FILTER (WHERE status = 'running'
                        AND started_at < now() - interval '6 hours')::bigint
                                                                 AS running_over_6h
  FROM kt_scan_batches;


-- [Q5] PostgreSQL 버전  ** 착수 전제조건 P2 **
SHOW server_version;


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


-- [Q1] data_source 분포 (NULL 포함)
SELECT coalesce(data_source, '(NULL)') AS data_source,
       count(*)::bigint AS n
  FROM kt_daily_analysis
 GROUP BY 1
 ORDER BY 2 DESC;


-- [Q2-b] (선택) 스캔 유형별 소요시간 분포 — 6시간 임계값의 실제 근거
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


-- =====================================================================
-- 여기까지가 STEP 1. DDL(STEP 2)은 위 결과를 받은 뒤 별도 파일로 확정한다.
-- STEP 2 는 장 마감 후 ~ 20:00 KST 스캔 이전 창에서 1회만 실행한다.
-- =====================================================================
