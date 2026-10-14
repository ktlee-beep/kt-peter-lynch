// 수집기가 받아 쓸 universe-builder 빌드의 시각 창. 수집기(stream-collector.mjs)와 제어판(scripts/pc/panel.mjs)이 같이 쓴다.
//
// 후보는 장 마감 뒤 빌드만 쓴다. 장 시작 전 아침 빌드는 네이버 스냅샷의 거래대금이 0이라 전 종목이 하한에서
// 탈락했다(2026-10-14 08:50 빌드: passed 0, 1090종목 PREOPEN). 창 = [직전 평일 15:40, 당일 07:00), KST.
// 빌드 파일명 앞 15자(YYYY-MM-DD_HHmm, KST)로 비교한다.

// 직전 평일(KST 날짜 문자열 YYYY-MM-DD). 공휴일은 모른다 — 공휴일 다음 날은 공휴일 저녁 빌드(그 전 거래일 값)를 받는다.
export const prevWeekday = ymd => {
  const d = new Date(`${ymd}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
};
export const buildWindow = today => [`${prevWeekday(today)}_1540`, `${today}_0700`];
export const inBuildWindow = (name, today) => { const [lo, hi] = buildWindow(today); const k = name.slice(0, 15); return k >= lo && k < hi; };
export const BUILD_FILE_RE = /^\d{4}-\d{2}-\d{2}_\d{4}\.json$/;
