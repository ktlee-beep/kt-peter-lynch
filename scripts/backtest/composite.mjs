// 측정값으로 만든 합성 점수 — 가중치를 사람이 정하지 않고 conditions-v1.json에서 뽑는다.
//
// 선정 규칙(코드로 고정한다. 눈으로 보고 고르면 그 순간 검증이 아니라 사후설명이 된다):
//   1. 신호 표본이 MIN_N 이상일 것 — 표본이 적으면 큰 초과수익도 우연이다.
//   2. 목표 보유기간에서 in 구간과 out 구간의 초과수익이 둘 다 같은 부호일 것.
//      한쪽에서만 좋은 조건은 국면 효과이지 신호가 아니다.
//   3. 두 구간 초과수익의 절댓값 평균이 MIN_EDGE 이상일 것.
// 가중치는 그 평균값 자체다. 추정한 숫자가 아니라 측정한 크기에 비례한다.
//
// 중요한 한계: 위 규칙은 조건 측정 파일의 out 구간 수치를 쓴다. 그 수치를 보고
// 만든 모델을 같은 구간으로 다시 평가하면 검증이 아니다. 그래서 실제 판정은
// measure-composite.mjs가 한 번도 측정하지 않은 과거 구간(--end-offset)에서 한다.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDITIONS } from './conditions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MIN_N = 1000;
export const MIN_EDGE = 0.4;   // %p — 비용(0.21%)의 두 배 남짓. 이보다 작으면 잡음과 구분 안 된다.

export async function buildComposite({ file = 'conditions-v2.json', horizon = 20 } = {}) {
  const data = JSON.parse(await readFile(path.join(HERE, file), 'utf8'));
  const picks = [];
  for (const row of data.conditions) {
    const h = row.h?.[horizon];
    if (!h || h.n < MIN_N) continue;
    const { excessIn: eIn, excessOut: eOut } = h;
    if (eIn == null || eOut == null) continue;
    if (Math.sign(eIn) !== Math.sign(eOut) || eIn === 0) continue;
    const edge = (eIn + eOut) / 2;
    if (Math.abs(edge) < MIN_EDGE) continue;
    if (!CONDITIONS[row.key]) continue;   // 카탈로그에서 사라진 조건은 버린다
    picks.push({ key: row.key, axis: row.axis, weight: parseFloat(edge.toFixed(3)), n: h.n, eIn, eOut, rate: row.rate });
  }
  picks.sort((a, b) => b.weight - a.weight);

  const score = (s) => {
    let sum = 0, decided = 0;
    for (const p of picks) {
      const v = CONDITIONS[p.key](s);
      if (v == null) continue;             // 판정 불가는 0점이 아니라 미참여다
      decided++;
      if (v) sum += p.weight;
    }
    // 참여한 조건이 절반도 안 되면 점수를 신뢰할 수 없다 — null을 돌려 신호를 내지 않는다.
    return decided < picks.length / 2 ? null : sum;
  };

  const maxScore = picks.filter(p => p.weight > 0).reduce((a, p) => a + p.weight, 0);
  const minScore = picks.filter(p => p.weight < 0).reduce((a, p) => a + p.weight, 0);
  return { picks, score, maxScore, minScore, horizon, source: file, params: { MIN_N, MIN_EDGE } };
}
