// 환경변수 로더 — 중앙 키 저장소(~/.secrets/api-keys.env) → 프로젝트 .env 순서로 읽는다.
// 이미 설정된 환경변수는 덮어쓰지 않는다. 중앙 파일이 없는 환경(Render 등)에서는 조용히 건너뛴다.
// 중앙 파일의 빈 값은 건너뛴다 — 빈 칸(예: TOSS_ACCOUNT=)이 프로젝트 .env 값을 막지 않게 (K-stock kt_env.py 와 같은 동작).
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CENTRAL = process.env.KT_SECRETS_FILE || path.join(os.homedir(), '.secrets', 'api-keys.env');
let central = {};
try {
  central = dotenv.parse(fs.readFileSync(CENTRAL));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;   // 파일은 있는데 못 읽는 경우(권한 등)는 키 누락으로 숨기지 않는다
}
for (const [k, v] of Object.entries(central)) {
  if (v && !(k in process.env)) process.env[k] = v;
}
dotenv.config({ quiet: true });
