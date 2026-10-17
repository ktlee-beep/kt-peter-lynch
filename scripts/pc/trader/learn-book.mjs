// 규칙 학습 장부 — learn.mjs 가 쓰고 매매 화면 서버(server.mjs)가 읽는다. 판정 기준을 한 곳에 둬서 두 쪽이 어긋나지 않게 한다.
//   candidates.json : 얼린 설정과 학습 마지막 날 "뒤에" 온 날의 성적(전진 시험)
//   holdout-*.json  : 시험일을 완전히 숨기고 학습한 뒤 그날만 돌린 성적
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEARN_DIR = process.env.LEARN_OUT ? path.resolve(process.env.LEARN_OUT) : path.join(HERE, 'learn');   // LEARN_OUT: 시험할 때 실제 장부 대신 쓸 폴더
export const CAND = path.join(LEARN_DIR, 'candidates.json');

// 판정 기준(전진 결과를 보기 전 2026-10-17 에 정함): 전진 5거래일 이상 · 합계 + · 20판 이상이면 '합격',
// 5거래일 이상인데 합계 0 이하면 '탈락'. 합격해도 실주문이 아니라 실시간 모의로 올릴 후보일 뿐이다.
export const PASS = { days: 5, rounds: 20 };

export const loadCand = () => { try { return JSON.parse(fs.readFileSync(CAND, 'utf8')); } catch { return { v: 1, list: [] }; } };

export function grade(x) {
  const ds = Object.values(x.forward).filter(d => !d.skip);
  const pnl = ds.reduce((a, d) => a + d.pnl, 0), rounds = ds.reduce((a, d) => a + d.rounds, 0);
  const verdict = ds.length < PASS.days ? '시험 중' : pnl > 0 && rounds >= PASS.rounds ? '합격' : pnl > 0 ? '판 수 부족' : '탈락';
  return { days: ds.length, pnl, rounds, plusDays: ds.filter(d => d.pnl > 0).length, verdict };
}

export function holdouts() {
  let files = [];
  try { files = fs.readdirSync(LEARN_DIR).filter(f => /^holdout-.*\.json$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { const h = JSON.parse(fs.readFileSync(path.join(LEARN_DIR, f), 'utf8')); out.push({ file: f, ...h }); } catch { /* 쓰는 중이거나 깨진 파일은 건너뛴다 */ }
  }
  return out;
}

// 매매 화면용 요약 — 장부 전체와 날짜별 시험일 성적
export function summary() {
  const c = loadCand();
  return {
    pass: PASS,
    candidates: c.list.map(x => ({ n: x.n, opts: x.opts, trainedThrough: x.trainedThrough, from: x.from, frozenAt: x.frozenAt, train: x.train, forward: x.forward, grade: grade(x) })),
    holdouts: holdouts().map(h => ({ file: h.file, test: h.test, train: h.train, seed: h.seed, n: h.n, sess: h.sess, finals: h.finals })),
  };
}
