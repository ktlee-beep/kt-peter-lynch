// KT 단타 수집기를 프로그램처럼 설치한다: 실행 파일(scripts/pc/bin/KT-Collector.exe)과 바탕화면·시작 메뉴 바로가기.
//
// 사용: node scripts/pc/install-app.mjs                 실행 파일을 만들고 바로가기를 만든다(다시 실행하면 덮어쓴다)
//       node scripts/pc/install-app.mjs --no-shortcut   실행 파일만 만든다(시험용)
//       node scripts/pc/panel.mjs --install             위와 같다
//
// 실행 파일은 Windows 에 들어 있는 C# 컴파일러(.NET Framework 4 의 csc.exe)로 scripts/pc/launcher.cs 를 컴파일해 만든다.
// 따로 내려받는 도구는 없다. 아이콘도 여기서 그려 bin/ 에 둔다. bin/ 은 이 PC 전용이라 git 에 올리지 않는다(.gitignore).
// 저장소 폴더를 옮기거나 Node.js 를 다시 깔았으면 이 스크립트를 다시 실행하면 된다.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(HERE, 'bin');
const EXE = path.join(BIN, 'KT-Collector.exe');
const ICO = path.join(BIN, 'kt-collector.ico');
const NAME = 'KT 단타 수집기';
const noShortcut = process.argv.includes('--no-shortcut');

const run = (file, args) => new Promise((resolve, reject) =>
  execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (err, out, errOut) =>
    err ? reject(new Error(`${(out || '').trim()}\n${(errOut || '').trim()}\n${err.message}`.trim())) : resolve(out)));

// ---------- 아이콘: 파란 둥근 사각형 위 흰 막대 3개(오르는 막대그래프) ----------
function iconPixels(size) {
  const inRound = (x, y) => {   // 0~1 좌표, 여백 0.04, 모서리 반지름 0.2
    const m = 0.04, r = 0.2;
    if (x < m || x > 1 - m || y < m || y > 1 - m) return false;
    const cx = Math.min(Math.max(x, m + r), 1 - m - r), cy = Math.min(Math.max(y, m + r), 1 - m - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bars = [[0.22, 0.34, 0.56], [0.44, 0.56, 0.42], [0.66, 0.78, 0.24]];   // [왼쪽, 오른쪽, 위], 아래는 0.78
  const inBar = (x, y) => bars.some(([l, r, t]) => x >= l && x <= r && y >= t && y <= 0.78);
  const S = 4, px = Buffer.alloc(size * size * 4);   // 4x4 표본으로 가장자리를 부드럽게, BGRA
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (col + (sx + 0.5) / S) / size, y = (row + (sy + 0.5) / S) / size;
        if (!inRound(x, y)) continue;
        a++;
        if (inBar(x, y)) { r += 255; g += 255; b += 255; } else { r += 0x24; g += 0x57; b += 0xd6; }
      }
      const o = ((size - 1 - row) * size + col) * 4;   // BMP 는 아래 줄부터
      if (a) { px[o] = Math.round(b / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(r / a); px[o + 3] = Math.round(255 * a / (S * S)); }
    }
  }
  return px;
}

function buildIco(sizes) {
  const images = sizes.map(size => {
    const head = Buffer.alloc(40);
    head.writeUInt32LE(40, 0); head.writeInt32LE(size, 4); head.writeInt32LE(size * 2, 8);   // 높이는 색+마스크라 두 배
    head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
    const maskRow = Math.ceil(size / 32) * 4;
    return Buffer.concat([head, iconPixels(size), Buffer.alloc(maskRow * size)]);   // AND 마스크는 0(알파를 쓴다)
  });
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e); dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

// ---------- 컴파일 ----------
const csc = ['Framework64', 'Framework']
  .map(f => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
  .find(existsSync);
if (!csc) {
  console.error('C# 컴파일러(.NET Framework 4 의 csc.exe)를 찾지 못했습니다. 대신 node scripts/pc/panel.mjs 로 제어판을 열 수 있습니다.');
  process.exit(1);
}
mkdirSync(BIN, { recursive: true });
writeFileSync(ICO, buildIco([16, 24, 32, 48, 64, 256]));
writeFileSync(path.join(BIN, 'node-path.txt'), process.execPath);   // 실행 파일이 이 node 로 제어판을 띄운다
try {
  await run(csc, ['/nologo', '/utf8output', '/target:winexe', '/codepage:65001', '/optimize+', `/out:${EXE}`, `/win32icon:${ICO}`,
    '/r:System.Windows.Forms.dll', path.join(HERE, 'launcher.cs')]);
} catch (e) {
  console.error(`실행 파일을 만들지 못했습니다(방금 실행했거나 백신이 검사 중이면 잠겨 있을 수 있습니다. 잠시 뒤 다시 해 보세요):\n${e.message}`);
  process.exit(1);
}
console.log(`실행 파일: ${EXE}`);

// ---------- 바로가기 ----------
if (!noShortcut) {
  const q = s => s.replace(/'/g, "''");
  const ps = [
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
    `$ErrorActionPreference = 'Stop'`,   // 저장에 실패하면 경로를 찍지 않고 오류로 끝낸다
    `$w = New-Object -ComObject WScript.Shell`,
    `foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {`,
    `  $p = Join-Path $d '${q(NAME)}.lnk'`,
    `  $s = $w.CreateShortcut($p)`,
    `  $s.TargetPath = '${q(EXE)}'`,
    `  $s.Arguments = ''`,
    `  $s.WorkingDirectory = '${q(ROOT)}'`,
    `  $s.IconLocation = '${q(EXE)},0'`,
    `  $s.WindowStyle = 1`,
    `  $s.Description = '${q(NAME)} 제어판 (이 PC 전용)'`,
    `  $s.Save()`,
    `  $p`,
    `}`,
  ].join('\n');
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]);
    for (const p of out.trim().split(/\r?\n/)) console.log(`바로가기: ${p}`);
  } catch (e) {
    console.error(`바로가기를 만들지 못했습니다. 실행 파일을 직접 두 번 눌러도 됩니다:\n${e.message}`);
    process.exit(1);
  }
  console.log(`바탕화면이나 시작 메뉴의 "${NAME}"를 두 번 누르면 제어판이 프로그램 창으로 열립니다.`);
  console.log('작업 표시줄에 고정하려면 시작 메뉴에서 오른쪽 클릭 > 작업 표시줄에 고정.');
}
