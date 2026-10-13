// PC 작업 스케줄러가 정시에 부르는 신호 스크립트.
//
// 왜 PC가 신호를 주나: GitHub schedule 은 수 시간씩 밀린다(2026-10-12 국내 스캔 11:00Z 예정 →
// 20:04Z 실행, 9시간 지연 → 스캔이 KST 05:06 에 돌았다). Render 무료 서버는 15분 무활동이면
// 잠들어서 서버 안 node-cron 도 그 시각에 돌지 못한다. 그래서 PC가 정시에
//   1) 서버를 직접 깨우고(/healthz),
//   2) daily-cron.yml 을 workflow_dispatch 로 부른다 — 워크플로가 SCAN_SECRET 으로 작업을 트리거.
// SCAN_SECRET 은 GitHub 시크릿에만 있고 PC로 옮기지 않는다. schedule 은 PC가 꺼진 날의 예비다.
//
// 사용: node scripts/pc/signal.mjs <kr|us|brief|all|wake>   (인자 없으면 wake = 서버만 깨움, 동작 확인용)
// 기록: scripts/pc/signal.log 에 한 줄씩 append (.gitignore 대상)
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOBS = ['all', 'kr', 'us', 'brief', 'wake'];
const GH = process.env.GH_BIN || 'C:\\Program Files\\GitHub CLI\\gh.exe';
const REPO = 'ktlee-beep/kt-peter-lynch';
const HEALTHZ = 'https://kt-peter-lynch.onrender.com/healthz';
const LOG = join(dirname(fileURLToPath(import.meta.url)), 'signal.log');

const job = process.argv[2] || 'wake';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

if (!JOBS.includes(job)) {
  log(`거부: 알 수 없는 job=${job} (허용 ${JOBS.join('|')})`);
  process.exit(2);
}

// 1) 직접 깨우기 — 실패해도 2)의 워크플로가 다시 깨우므로 치명적이지 않다.
const t0 = Date.now();
try {
  const r = await fetch(HEALTHZ, { signal: AbortSignal.timeout(90_000) });
  log(`healthz ${r.status} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  log(`healthz 실패 ${((Date.now() - t0) / 1000).toFixed(1)}s ${e.name}: ${e.message}`);
}

// 2) 워크플로 호출 — 실제 트리거는 이쪽. 실패하면 종료 코드 1로 작업 스케줄러 기록에 남긴다.
try {
  const out = execFileSync(GH, ['workflow', 'run', 'daily-cron.yml', '-R', REPO, '-f', `job=${job}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  log(`dispatch job=${job} OK ${out.trim()}`);
} catch (e) {
  log(`dispatch job=${job} 실패 exit=${e.status} ${String(e.stderr || e.message).trim()}`);
  process.exit(1);
}
