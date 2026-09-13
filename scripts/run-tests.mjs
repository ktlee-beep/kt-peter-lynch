// test/*.test.mjs 일괄 실행기.
//
// 각 테스트는 통과 시 종료코드 0, 실패 시 1을 낸다. 쉘 글로브(`node test/*.test.mjs`)는
// Windows에서 확장되지 않으므로 러너를 따로 둔다.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

const run = (file) => new Promise((resolve) => {
  const p = spawn(process.execPath, [file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });
  p.on('close', code => resolve({ code, out }));
});

const files = (await readdir(TEST_DIR)).filter(f => f.endsWith('.test.mjs')).sort();
if (!files.length) { console.error('test/*.test.mjs 없음'); process.exit(1); }

let failed = 0;
for (const f of files) {
  const { code, out } = await run(path.join(TEST_DIR, f));
  const tally = out.match(/통과 (\d+) \/ 실패 (\d+)/);
  const label = tally ? `통과 ${tally[1]} / 실패 ${tally[2]}` : '';
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${f.padEnd(34)} ${label}`);
  if (code !== 0) {
    failed++;
    // 실패한 것만 본문을 보여준다. 전부 쏟으면 정작 실패가 묻힌다.
    out.split('\n').filter(l => /FAIL|Error|에러/.test(l)).slice(0, 15).forEach(l => console.log(`      ${l}`));
  }
}
console.log(`\n${files.length}개 파일 중 실패 ${failed}개`);
process.exit(failed === 0 ? 0 : 1);
