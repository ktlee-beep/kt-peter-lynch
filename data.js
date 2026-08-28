// KT Trading — 외부 데이터 수집 (KRX, Yahoo, Naver, OpenDart)
// env.* → process.env.* 으로 변환
import AdmZip from 'adm-zip';

export const CORP_MAP = {
  '005930': '00126380', '000660': '00164779', '373220': '01515323',
  '207940': '00877059', '005380': '00164742', '000270': '00164645',
  '012330': '00164788', '011210': '00256145', '204320': '00266961',
  '012860': '00136961', '058610': '00498553', '276730': '00803401',
  '317770': '00973518', '042700': '00164772', '039030': '00161488',
  '014680': '00132818', '418470': '01133967', '035420': '00266961',
  '035720': '00258801', '247540': '00803395', '086520': '00496924',
  '028260': '00126362', '105560': '00688996', '055550': '00382199',
  '086790': '00547583', '316140': '01036050', '352820': '01233059',
  '041510': '00139822', '035900': '00280222', '122870': '00658494',
};

export async function fetchYahooSummary(code) {
  for (const suffix of ['KS', 'KQ']) {
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${code}.${suffix}`
        + `?modules=summaryDetail,financialData,defaultKeyStatistics`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      const res = data.quoteSummary?.result?.[0];
      if (!res) continue;
      const sd = res.summaryDetail        || {};
      const fd = res.financialData        || {};
      const ks = res.defaultKeyStatistics || {};
      const n  = (obj, key) => obj[key]?.raw ?? null;
      const pct = (obj, key) => obj[key]?.raw != null ? obj[key].raw * 100 : null;
      return {
        per:           n(sd, 'trailingPE'),
        forwardPer:    n(sd, 'forwardPE'),
        pbr:           n(sd, 'priceToBook'),
        marketCap:     n(sd, 'marketCap'),
        beta:          n(sd, 'beta'),
        dividendYield: pct(sd, 'dividendYield'),
        roe:           pct(fd, 'returnOnEquity'),
        roa:           pct(fd, 'returnOnAssets'),
        opMargin:      pct(fd, 'operatingMargins'),
        profitMargin:  pct(fd, 'profitMargins'),
        revenueGrowth: pct(fd, 'revenueGrowth'),
        debtToEquity:  n(fd, 'debtToEquity'),
        currentRatio:  n(fd, 'currentRatio'),
        peg:           n(ks, 'pegRatio'),
        eps:           n(ks, 'trailingEps'),
      };
    } catch {}
  }
  return null;
}

// Naver Finance 기본 재무 지표 (Yahoo v10 crumb 이슈 대체)
export async function fetchNaverFundamentals(code) {
  try {
    const url = `https://api.finance.naver.com/service/itemSummary.nhn?itemcode=${code}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://finance.naver.com/',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const n = (v) => {
      if (v == null || v === '' || v === 'N/A' || v === '-') return null;
      const x = parseFloat(String(v).replace(/,/g, ''));
      return isNaN(x) ? null : x;
    };
    const ms = n(d.marketSum);
    return {
      per:           n(d.per),
      eps:           n(d.eps),
      roe:           n(d.roe),
      pbr:           n(d.pbr),
      dividendYield: n(d.yield),
      // Naver marketSum은 백만원 단위 → 억원으로 변환(÷100). 프런트/스크리너는 모두 억원 가정.
      marketCap:     ms != null ? ms / 100 : null,
    };
  } catch { return null; }
}

// fnlttSinglAcnt는 fs_div 요청 파라미터를 무시하고 연결(CFS)·별도(OFS)를 항상 함께 반환한다
// (2026-08-28 삼성전자·카카오·한미반도체 등 7종목에서 CFS 요청과 OFS 요청의 응답이 동일함을 확인).
// 그래서 fs_div를 바꿔 재요청하는 폴백은 순수 낭비이고, 골라내는 일은 행 단위로 해야 한다.
// 필터하지 않으면 같은 account_nm이 두 벌 존재해 find()가 배열 순서에 의존하게 되며,
// 순서가 뒤집히는 종목에서 무증상으로 별도재무제표를 집는다(삼성전자 26년 반기 매출 171.5조 vs 149.3조).
// 엘브이엠씨처럼 한쪽만 오는 종목이 있어 CFS가 없으면 OFS로 넘어간다.
function pickFsRows(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const cfs = list.filter(i => i.fs_div === 'CFS');
  if (cfs.length) return cfs;
  const ofs = list.filter(i => i.fs_div === 'OFS');
  if (ofs.length) return ofs;
  // fs_div로 못 가르는 예외 응답. 중복 계정이 없으면 그대로 써도 안전하지만,
  // 중복이 있는데 못 갈랐다면 그건 정확히 이 함수가 막으려던 상황이므로 포기한다.
  const seen = new Set();
  const hasDupe = list.some(i => {
    const k = `${i.sj_div}|${i.account_nm}`;
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  return hasDupe ? null : list;
}

export async function fetchDartMultiYear(corpCode, dartKey) {
  const curYear = new Date().getFullYear();
  const years = [curYear - 1, curYear - 2, curYear - 3, curYear - 4, curYear - 5];
  const toNum = (s) => {
    const n = parseInt((s || '0').replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
  };

  async function fetchYear(year) {
    try {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${dartKey}`
                + `&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`;
      const r = await fetch(url).catch(() => null);
      if (!r?.ok) return null;
      const j = await r.json().catch(() => null);
      if (j?.status !== '000') return null;
      // CFS(연결) 우선, 없으면 OFS(개별) — 재요청이 아니라 행 필터다(pickFsRows 주석 참조)
      const rows = pickFsRows(j.list);
      if (!rows) return null;

      const BSrows = rows.filter(i => i.sj_div === 'BS');
      const ISrows = rows.filter(i => i.sj_div === 'IS');

      const find = (rows, kws) => {
        for (const kw of kws) {
          const item = rows.find(i => i.account_nm?.includes(kw));
          if (item) return { cur: toNum(item.thstrm_amount), prev: toNum(item.frmtrm_amount) };
        }
        return null;
      };

      const rev  = find(ISrows, ['매출액', '수익(매출액)', '영업수익', '매출']);
      const op   = find(ISrows, ['영업이익', '영업손익']);
      const net  = find(ISrows, ['당기순이익', '분기순이익']);
      const eq   = find(BSrows, ['자본총계', '총자본']);
      const debt = find(BSrows, ['부채총계', '총부채']);
      const ca   = find(BSrows, ['유동자산']);
      const cl   = find(BSrows, ['유동부채']);

      const revAmt = rev?.cur ?? null;
      const opAmt  = op?.cur  ?? null;
      const netAmt = net?.cur ?? null;
      const equityAmt = eq?.cur ?? null;
      const debtAmt   = debt?.cur ?? null;
      const caAmt = ca?.cur ?? null;
      const clAmt = cl?.cur ?? null;

      const toEok = (v) => v !== null ? Math.round(v / 1e8) : null;
      const roe = (equityAmt && netAmt && equityAmt > 0) ? (netAmt / equityAmt) * 100 : null;
      const debtRatio = (equityAmt && debtAmt && equityAmt > 0) ? (debtAmt / equityAmt) * 100 : null;
      const currentRatio = (caAmt && clAmt && clAmt > 0) ? (caAmt / clAmt) * 100 : null;
      const opMargin = (revAmt && opAmt && revAmt > 0) ? (opAmt / revAmt) * 100 : null;

      if (revAmt === null || revAmt === 0) return null;
      return {
        year,
        revenue: toEok(revAmt),
        operatingProfit: toEok(opAmt),
        netIncome: toEok(netAmt),
        equity: toEok(equityAmt),
        debt: toEok(debtAmt),
        roe: roe !== null ? parseFloat(roe.toFixed(2)) : null,
        debtRatio: debtRatio !== null ? parseFloat(debtRatio.toFixed(1)) : null,
        currentRatio: currentRatio !== null ? parseFloat(currentRatio.toFixed(1)) : null,
        opMargin: opMargin !== null ? parseFloat(opMargin.toFixed(2)) : null,
      };
    } catch { return null; }
  }

  const results = await Promise.all(years.map(fetchYear));
  // 연도 오름차순. 미확보 연도는 null 원소가 아니라 "전 필드 null인 자리표시 객체"로 채운다
  // — 호출부가 인덱스↔연도 대응을 유지할 수 있게 하기 위함이다.
  // 그래서 "자료가 있는가"를 `some(v => v != null)`로 판정하면 안 된다. 객체는 언제나 non-null이라
  // 항상 true가 되고, DART 장애로 5개년이 전부 비어도 "수집 성공"으로 보인다. hasYearData를 쓸 것.
  return years.map((yr, i) => results[i] || { year: yr, revenue: null, operatingProfit: null, netIncome: null, equity: null, debt: null, roe: null, debtRatio: null, currentRatio: null, opMargin: null }).reverse();
}

// fetchDartMultiYear 한 원소에 실제 재무 수치가 담겼는지. 자리표시 객체와 실데이터를 가르는 유일한 기준.
// 캐시 적재 여부와 "판정 불가" 판정이 모두 이 함수에 걸려 있으므로 사본을 만들지 말 것.
export function hasYearData(y) {
  return !!y && (y.revenue != null || y.operatingProfit != null || y.netIncome != null || y.equity != null);
}

// DART 기업개황 — 표준산업분류·시장구분·결산월
// induty_code(한국표준산업분류)는 동종업계 상대 밸류에이션의 기준이다. 절대 PER로는
// 저평가를 판정할 수 없다 — 반도체 PER 15와 유틸리티 PER 15는 의미가 정반대다.
// acc_mt(결산월)가 12월이 아니면 연간 실적의 기준 시점이 달라 타사와 직접 비교할 수 없다.
export async function fetchDartCompanyInfo(corpCode, dartKey) {
  try {
    const r = await fetch(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${dartKey}&corp_code=${corpCode}`);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (j?.status !== '000') return null;
    const s = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    return {
      corpName:   s(j.corp_name),
      stockCode:  s(j.stock_code),
      indutyCode: s(j.induty_code),
      // corp_cls: Y=유가증권 K=코스닥 N=코넥스 E=기타.
      // corpCls 원본도 함께 돌려준다 — market만 있으면 "기타법인(E)"과 "필드 자체가 없음"이
      // 둘 다 null로 붕괴해 호출부가 상장 구분 실패와 기타법인을 구별할 수 없다.
      corpCls: s(j.corp_cls),
      market: { Y: 'KOSPI', K: 'KOSDAQ', N: 'KONEX' }[j.corp_cls] ?? null,
      // 숫자로 정규화. '12' 문자열이면 accMonth !== 12가 항상 참이 되어 전 종목이
      // 비12월 결산으로 오판된다 — fetchDartQuarterly가 이 값으로 제출월을 판정한다.
      accMonth: Number.isFinite(Number(j.acc_mt)) ? Number(j.acc_mt) : null,
      estDt:    s(j.est_dt),
    };
  } catch { return null; }
}

// 분기·반기보고서 코드. 사업보고서(11011)는 fetchDartMultiYear가 담당한다.
const DART_QUARTER_REPORTS = [
  { code: '11014', quarter: 3 },
  { code: '11012', quarter: 2 },
  { code: '11013', quarter: 1 },
];

// DART 분기 실적 — 연간만 보면 최신 실적이 최대 15개월 묵는다. 실적이 돌아선 지
// 세 분기가 지나 주가가 이미 오른 뒤에야 알아차리게 되므로 "선점"이 성립하지 않는다.
//
// 응답 구조(2026-08-28 삼성전자 실응답으로 확인):
//   thstrm_amount     = 해당 분기 3개월 금액
//   thstrm_add_amount = 당기 누적
//   frmtrm_amount     = 전년 동분기 3개월   → YoY를 호출 1회로 얻는다
//   frmtrm_add_amount = 전년 동기 누적
// 검증: 25Q1 79.14조 + 25Q2 74.57조 + 25Q3 86.06조 = 3분기 누적 239.77조 일치.
//
// accMonth는 fetchDartCompanyInfo의 acc_mt(결산월). 12월 결산이 아니면 아래 제출월 추정이
// 성립하지 않으므로 최적화를 끄고 전 분기를 조회한다 — 자세한 이유는 dueMonth 주석 참조.
export async function fetchDartQuarterly(corpCode, dartKey, accMonth = 12) {
  const toNum = (v) => {
    if (v == null || v === '' || v === '-') return null;
    const n = parseInt(String(v).replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
  };
  const find = (rows, kws) => {
    for (const kw of kws) {
      const it = rows.find(i => i.account_nm?.includes(kw));
      if (it) return it;
    }
    return null;
  };
  const pull = async (year, code) => {
    const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${dartKey}`
              + `&corp_code=${corpCode}&bsns_year=${year}&reprt_code=${code}&fs_div=CFS`;
    const r = await fetch(url).catch(() => null);
    if (!r?.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.status === '000' ? pickFsRows(j.list) : null;
  };

  const now = new Date();
  const curYear = now.getFullYear(), m = now.getMonth() + 1;
  // 「자본시장과 금융투자업에 관한 법률」 제160조 — 분기·반기보고서는 "사업연도 개시일부터
  // 3개월간·6개월간·9개월간의 기간이 경과한 날부터 45일 이내" 제출. 기준은 달력이 아니라
  // 사업연도다. 12월 결산사에서만 1분기 5/15, 반기 8/14, 3분기 11/14로 떨어진다.
  // 기한 전 분기는 조회해도 없으므로 전종목 스캔의 헛호출을 줄이려고 건너뛴다.
  //
  // 3월 결산사(사업연도 4월 개시)는 제출월이 8/11/익년2월이라 아래 표와 세 분기 모두 어긋난다.
  // 루프가 첫 성공에서 return하므로 한번 잘못 걸러내면 더 최신 보고서가 서버에 있어도
  // 영원히 도달하지 못한다. 비12월 결산사는 소수이므로 최적화를 포기하고 전 분기를 조회한다
  // (연도 경계를 넘는 환산을 잘못 짜서 무증상 오답을 내는 것보다 호출 몇 번이 낫다).
  const isDecFY = Number(accMonth) === 12;
  const dueMonth = { 1: 5, 2: 8, 3: 11 };
  const thisYearReports = isDecFY
    ? DART_QUARTER_REPORTS.filter(q => m >= dueMonth[q.quarter])
    : DART_QUARTER_REPORTS;

  for (const [year, reports] of [[curYear, thisYearReports], [curYear - 1, DART_QUARTER_REPORTS]]) {
    for (const { code, quarter } of reports) {
      const rows = await pull(year, code);
      if (!rows) continue;
      const IS = rows.filter(i => i.sj_div === 'IS');
      const rev = find(IS, ['매출액', '수익(매출액)', '영업수익', '매출']);
      const op  = find(IS, ['영업이익', '영업손익']);
      // 보험사 등은 '보험료수익'처럼 표기해 매출 키워드에 걸리지 않는다. 매출만 보고 버리면
      // 연간 경로(fetchDartFinancials)에서는 잡히던 종목이 분기 경로에서만 사라진다.
      if (!rev && !op) continue;
      const net = find(IS, ['당기순이익', '분기순이익', '반기순이익']);

      const toEok = (v) => v !== null ? Math.round(v / 1e8) : null;
      const pick = (row, key) => row ? toNum(row[key]) : null;
      // 전년이 적자면 부호가 뒤집혀 증감률이 무의미해진다. 분모에 절대값을 써서
      // "적자 -100 → 흑자 50"이 +150%로 나오게 한다(방향은 보존).
      // 다만 분모가 미미하면 비율이 폭발한다 — 전년 영업이익 -1억에서 올해 1000억이면
      // +100,100%가 나와 정렬 상단을 점거하고 진짜 성장주를 밀어낸다. 1억원 미만 분모는 포기.
      const MIN_DENOM = 1e8;
      const growth = (cur, prev) => (cur !== null && prev !== null && Math.abs(prev) >= MIN_DENOM)
        ? parseFloat((((cur - prev) / Math.abs(prev)) * 100).toFixed(2)) : null;

      const qRev = pick(rev, 'thstrm_amount'), qRevPrev = pick(rev, 'frmtrm_amount');
      const qOp  = pick(op,  'thstrm_amount'), qOpPrev  = pick(op,  'frmtrm_amount');
      const qNet = pick(net, 'thstrm_amount'), qNetPrev = pick(net, 'frmtrm_amount');

      // 누적 금액. 1분기는 누적 ≡ 3개월이라 폴백이 정확하지만, 2·3분기에서 같은 폴백을
      // 하면 3개월치가 cumRevenue라는 이름을 달고 나간다. 그 값이 TTM 분모로 들어가면
      // 밸류에이션이 3배 가까이 왜곡되고, 하필 "초저평가" 방향이라 스크리너 상단에 올라온다.
      // 2·3분기에는 폴백 없이 null로 둬서 calcTTM이 정직하게 null을 반환하게 한다.
      const cumOf = (row, key, q3m) => {
        const c = pick(row, key);
        return c !== null ? c : (quarter === 1 ? q3m : null);
      };

      return {
        year, quarter, reportCode: code, label: `${year}년 ${quarter}분기`,
        revenue: toEok(qRev), operatingProfit: toEok(qOp), netIncome: toEok(qNet),
        revenueYoY: growth(qRev, qRevPrev),
        opYoY:      growth(qOp,  qOpPrev),
        netYoY:     growth(qNet, qNetPrev),
        // 누적치 — TTM = 당기누적 + 전년연간 − 전년동기누적 (연간 데이터는 호출부가 보유).
        // calcTTM에 넘길 때 prevFullYearOf는 반드시 year - 1이어야 한다.
        prevFullYearRef: year - 1,
        cumRevenue:         toEok(cumOf(rev, 'thstrm_add_amount', qRev)),
        cumOperatingProfit: toEok(cumOf(op,  'thstrm_add_amount', qOp)),
        prevCumRevenue:         toEok(cumOf(rev, 'frmtrm_add_amount', qRevPrev)),
        prevCumOperatingProfit: toEok(cumOf(op,  'frmtrm_add_amount', qOpPrev)),
      };
    }
  }
  return null;
}

// DART 전체 상장사 corp_code 매핑 다운로드 (corpCode.xml ZIP → 상장사만 추출)
// 반환: [{ code(6자리), corp_code(8자리), corp_name }] — 약 3,900개
export async function fetchCorpCodeMap(dartKey) {
  const r = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${dartKey}`);
  if (!r.ok) throw new Error(`DART corpCode HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const entry = new AdmZip(buf).getEntries().find(e => e.entryName.toUpperCase().endsWith('.XML'));
  if (!entry) throw new Error('corpCode.xml 항목 없음');
  const xml = entry.getData().toString('utf8');
  const rows = [];
  for (const b of xml.match(/<list>[\s\S]*?<\/list>/g) || []) {
    const corp  = (b.match(/<corp_code>([^<]*)<\/corp_code>/)  || [])[1]?.trim();
    const name  = (b.match(/<corp_name>([^<]*)<\/corp_name>/)  || [])[1]?.trim();
    const stock = (b.match(/<stock_code>([^<]*)<\/stock_code>/) || [])[1]?.trim();
    if (corp && stock && /^\d{6}$/.test(stock)) rows.push({ code: stock, corp_code: corp, corp_name: name || '' });
  }
  return rows;
}

// ── 유니버스 원천: 전 종목 시총·거래대금 일괄 조회 ────────────────
// 계획서는 KRX(data.krx.co.kr getJsonData.cmd)를 1순위로 뒀지만 2026-08-28 실측에서
// 세션 쿠키 발급이 막혀 본문 "LOGOUT"과 함께 HTTP 400만 돌아왔다. 메인 페이지를 먼저
// 받아 쿠키를 챙기는 웜업을 붙여도 __smVisitorID만 오고 JSESSIONID가 발급되지 않는다.
// 대신 네이버 모바일 시세 목록이 같은 정보(코드·이름·시장·시총·거래대금)를 한 번에 준다.
// 시장당 2회, 총 4회 호출로 전 종목을 받으므로 종목별 조회(3,900회) 대비 비용이 없는 수준.
const SISE_LIST_URL = 'https://m.stock.naver.com/api/json/sise/siseListJson.nhn';
const SISE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://finance.naver.com/sise/sise_market_sum.naver',
  'Accept': 'application/json',
};

// 응답 1행 → 내부 표준형. 단위 환산이 이 함수에만 있도록 가둔다.
// marketSumRaw·aa 모두 백만원 단위다(삼성전자 실측: marketSumRaw 1,502,493,602 =
// 1,502조원). 앱 전체가 억원을 가정하므로(fetchNaverFundamentals와 동일) 100으로 나눈다.
// 불리언 플래그가 true·"true"·1 중 무엇으로 올지 네이버가 보장하지 않는다. === true만 보면
// 표현이 바뀌는 순간 ETF/ETN이 전부 통과하는데, 이들 종목코드는 대부분 끝자리가 0이라
// 보통주 정규식이 백스톱이 되어주지 못한다(069500·102110·550010 전부 통과).
const flag = (v) => v === true || v === 1 || v === 'true' || v === 'Y' || v === '1';

function normalizeSiseRow(it, market) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const cap = num(it.marketSumRaw);
  const val = num(it.aa);
  return {
    code: String(it.cd || ''),
    name: String(it.nm || '').trim(),
    market,
    marketCap:    cap != null ? cap / 100 : null,  // 억원
    tradingValue: val != null ? val / 100 : null,  // 억원 (당일 누적 거래대금)
    price: num(it.nv),
    isEtf: flag(it.etf),
    isEtn: flag(it.etn),
    // tyn의 의미는 네이버가 공개하지 않는다 [확인 필요]. 실측상 Y인 종목은 시총 중앙값이
    // 낮고 거래대금이 미미해 거래정지로 보이지만, 추정으로 종목을 떨어뜨리진 않는다.
    // 필터에 쓰지 않고 원본만 남겨 나중에 판단할 근거로 둔다.
    tyn: it.tyn ?? null,
  };
}

export async function fetchNaverMarketSum() {
  const rows = [];
  for (const [sosok, market] of [[0, 'KOSPI'], [1, 'KOSDAQ']]) {
    let seen = 0, total = null;
    // pageSize 2000은 서버가 받아준 값이고 상한 광고는 없다. 총건수를 응답에서 받아
    // 그만큼만 돌고, 페이지 상한에서 소리 내며 멈춘다 — 무한 루프로 새지 않게.
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`${SISE_LIST_URL}?menu=market_sum&sosok=${sosok}&pageSize=2000&page=${page}`,
        { headers: SISE_HEADERS });
      if (!r.ok) throw new Error(`네이버 시세목록 HTTP ${r.status} (${market} p${page})`);
      const j = await r.json();
      const res = j?.result || j;
      // 형식이 바뀌면 빈 배열로 흘려보내면 안 된다 — 유니버스가 0이 되어 전 종목이
      // 상장폐지처럼 보인다. 모양이 다르면 즉시 실패시켜 폴백 경로를 타게 한다.
      if (!Array.isArray(res?.itemList)) throw new Error(`네이버 시세목록 응답 형식 변경 (${market} p${page})`);
      // totCnt는 루프 종료 조건이자 아래 완전성 검사의 기준값이다. 이 한 필드를 `|| 0`으로
      // 흘리면 결함이 둘 동시에 생긴다 — (a) seen >= 0이 즉시 참이라 1페이지에서 탈출하고
      // (b) "수집 부족" 검사가 공허해진다. 그 조합이면 한 시장이 통째로 비어도 예외 없이
      // 성공하고, 빠진 종목 전부가 유니버스 이탈로 판정돼 is_active가 꺼진다.
      // itemList는 엄격히 검증하면서 totCnt만 느슨하게 두면 그 비대칭이 그대로 사고가 된다.
      if (total == null) {
        total = Number(res.totCnt);
        if (!Number.isFinite(total) || total <= 0) {
          throw new Error(`네이버 시세목록 totCnt 이상 (${market}): ${JSON.stringify(res.totCnt)}`);
        }
      }
      if (res.itemList.length === 0) break;
      for (const it of res.itemList) rows.push(normalizeSiseRow(it, market));
      seen += res.itemList.length;
      if (seen >= total) break;
    }
    // 총건수보다 적게 받았으면 조용히 넘어가지 않는다. 반쪽 유니버스를 그대로 반영하면
    // 빠진 종목이 전부 "유니버스 이탈"로 판정돼 is_active가 꺼진다.
    // total은 위에서 양수임이 보장되므로 `total &&` 같은 단락 조건을 붙이지 않는다.
    if (seen < total) throw new Error(`${market} 수집 부족: ${seen}/${total}`);
  }
  return rows;
}

// 스팩(기업인수목적회사)은 합병 전까지 영업활동이 없어 성장 스크리닝 대상이 아니다.
const SPAC_RE = /스팩|기업인수목적/;

// 유니버스 필터. 순수 함수로 분리해 원천 없이도 단위 검증이 가능하게 둔다.
export function filterUniverse(rows, { minCapEok = 1000, minValueEok = 3 } = {}) {
  const stats = { total: rows.length, dup: 0, etfEtn: 0, preferred: 0, spac: 0, noData: 0, belowCap: 0, belowValue: 0 };
  const kept = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.isEtf || r.isEtn) { stats.etfEtn++; continue; }
    // 보통주만 남긴다. KRX 종목코드는 보통주만 끝자리가 0이고 우선주는 5·7·9 또는
    // 영문(00680K 미래에셋증권2우B)이 붙는다. 2026-08-28 전 종목 실측에서 ETF/ETN을
    // 제외한 끝자리 비(非)0 종목 114개가 전부 우선주였다 — 오탈락 0건.
    if (!/^\d{5}0$/.test(r.code)) { stats.preferred++; continue; }
    if (SPAC_RE.test(r.name)) { stats.spac++; continue; }
    if (r.marketCap == null || r.tradingValue == null) { stats.noData++; continue; }
    if (r.marketCap < minCapEok) { stats.belowCap++; continue; }
    // 거래대금 하한은 낮게 잡는다. 이 전략의 표적은 "실적은 좋은데 주가가 빠진" 종목이라
    // 거래가 한산한 경우가 많다 — 하한을 높이면 찾으려는 대상을 먼저 잘라낸다.
    // 거래정지·껍데기 종목만 걷어내는 용도.
    if (r.tradingValue < minValueEok) { stats.belowValue++; continue; }
    // 원천 목록은 실시간 시가총액 순이라 페이지 사이에 순위가 바뀌면 같은 종목이 두 페이지에
    // 걸쳐 온다. 그대로 두면 한 upsert 본문에 같은 PK가 두 번 들어가고, Postgres가
    // "ON CONFLICT DO UPDATE command cannot affect row a second time"(SQLSTATE 21000)로
    // 청크를 통째로 거부해 갱신 전체가 실패한다. PostgREST 페이지네이션 쪽에서 정렬 불안정을
    // 이미 다뤘으니 원천 쪽도 같은 기준으로 막는다 — 여기가 오히려 정렬 키가 더 불안정하다.
    // 탈락 집계를 흐리지 않도록 모든 필터를 통과한 뒤에 본다 — 문제는 upsert 본문의 중복이다.
    if (seen.has(r.code)) { stats.dup++; continue; }
    seen.add(r.code);
    kept.push(r);
  }
  return { kept, stats };
}

export async function fetchDartFinancials(corpCode, dartKey) {
  const curYear = new Date().getFullYear();
  for (const bsnsYear of [curYear - 1, curYear - 2]) {
    try {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json`
        + `?crtfc_key=${dartKey}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=11011&fs_div=CFS`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      if (data.status !== '000' || !Array.isArray(data.list)) continue;
      const fsRows = pickFsRows(data.list);
      if (!fsRows) continue;
      const IS = fsRows.filter(i => i.sj_div === 'IS');
      const toNum = (s) => parseInt((s || '0').replace(/,/g, ''), 10);
      const find = (keywords) => {
        for (const kw of keywords) {
          const item = IS.find(i => i.account_nm?.includes(kw));
          if (item) return { cur: toNum(item.thstrm_amount), prev: toNum(item.frmtrm_amount) };
        }
        return null;
      };
      const rev = find(['매출액', '수익(매출액)', '영업수익', '매출']);
      const op  = find(['영업이익', '영업손익']);  // '영업이익(손실)' 포함 (includes 매칭)
      const net = find(['당기순이익', '당기순손익']);
      // 금융사 등은 매출액이 없으므로 영업이익만 있어도 진행
      if ((!rev || rev.cur === 0) && (!op || op.cur === 0)) continue;
      const hasRev = rev && rev.cur !== 0;
      const revenueGrowth = hasRev && rev.prev ? ((rev.cur - rev.prev) / Math.abs(rev.prev)) * 100 : null;
      const opMargin      = hasRev && rev.cur > 0 && op ? (op.cur / rev.cur) * 100 : null;
      const opGrowth      = op && op.prev > 0   ? ((op.cur - op.prev) / Math.abs(op.prev)) * 100 : null;
      const netGrowth     = net && net.prev > 0 ? ((net.cur - net.prev) / Math.abs(net.prev)) * 100 : null;
      return {
        revenueGrowth, opMargin, opGrowth, netGrowth,
        opProfit: op?.cur ?? null, netProfit: net?.cur ?? null,
        year: bsnsYear,
      };
    } catch {}
  }
  return null;
}

export async function krxStock(code) {
  const serviceKey = process.env.KRX_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const url = `https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo`
      + `?serviceKey=${serviceKey}&likeSrtnCd=${code}&numOfRows=5&resultType=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const raw = data.response?.body?.items?.item;
    if (!raw) return null;
    const list = Array.isArray(raw) ? raw : [raw];
    const item = list.find(i => i.srtnCd === code) || list[0];
    if (!item) return null;
    const price = parseInt(item.clpr, 10);
    const change = parseInt(item.vs, 10);
    return {
      code, source: 'KRX', market: item.mrktCtg, name: item.itmsNm,
      price, previousClose: price - change, change,
      changeRate: parseFloat(item.fltRt),
      volume: parseInt(item.trqu, 10), date: item.basDt, ts: Date.now(),
    };
  } catch { return null; }
}

export async function naverStock(code) {
  try {
    const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' } });
    if (!r.ok) return null;
    const d = await r.json();
    const price = parseFloat(d.closePrice?.replace(/,/g, '') || '0');
    const change = parseFloat(d.compareToPreviousClosePrice?.replace(/,/g, '') || '0');
    const changeRate = parseFloat(d.fluctuationsRatio || '0');
    const volume = parseInt(d.accumulatedTradingVolume?.replace(/,/g, '') || '0', 10);
    const market = d.stockExchangeType?.code?.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI';
    const name = d.stockName || '';
    if (!price) return null;
    return { code, source: 'Naver', market, name, price, previousClose: price - change,
      change, changeRate, volume, ts: Date.now() };
  } catch { return null; }
}

export async function fetchNaverInvestor(code) {
  const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' };
  // Try multiple Naver investor API endpoints
  const urls = [
    `https://m.stock.naver.com/api/stock/${code}/investor`,
    `https://m.stock.naver.com/domestic/stock/${code}/investorTradingTrends`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: H });
      if (!r.ok) continue;
      const raw = await r.json();
      const arr = Array.isArray(raw) ? raw : (raw.data || raw.items || raw.result || null);
      if (!Array.isArray(arr) || !arr.length) continue;
      return arr.slice(0, 25).map(d => ({
        date: d.stckBsopDt || d.date || '',
        foreign: parseInt(d.frgn_netbuy ?? d.foreignNetBuy ?? d.frgn ?? 0),
        inst:    parseInt(d.inst_netbuy  ?? d.instNetBuy  ?? d.inst  ?? 0),
        indiv:   parseInt(d.priv_netbuy  ?? d.privNetBuy  ?? d.indiv ?? 0),
      })).filter(d => d.date);
    } catch { /* try next URL */ }
  }
  return null;
}

export async function naverHistory(code) {
  try {
    // count=280: 52주 고저·MDD·120일선 산출에 필요한 거래일 252일 + 휴장 버퍼
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=280&requestType=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' } });
    if (!r.ok) return null;
    const text = await r.text();
    const items = [];
    for (const m of text.matchAll(/data="([^"]+)"/g)) {
      const [date, open, high, low, close, volume] = m[1].split('|');
      const c = parseInt(close, 10), o = parseInt(open, 10);
      const h = parseInt(high, 10), l = parseInt(low, 10), v = parseInt(volume, 10);
      if (!c) continue;
      items.push({ date, o, h, l, c, v });
    }
    if (items.length < 20) return null;
    const info = await naverStock(code);
    const market = info?.market || 'KOSDAQ';
    const name   = info?.name  || code;
    return { items, market, name, price: info?.price || items.at(-1).c,
      previousClose: info?.previousClose || 0,
      change: info?.change || 0, changeRate: info?.changeRate || 0,
      volume: info?.volume || items.at(-1).v };
  } catch { return null; }
}

export async function yahooStock(code) {
  for (const suffix of ['KS', 'KQ']) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.${suffix}?interval=1d&range=5d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      const result = data.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      if (!isValidYahooResult(meta, code, suffix)) continue;
      const closes = result.indicators?.quote?.[0]?.close || [];
      const volumes = result.indicators?.quote?.[0]?.volume || [];
      const last = meta.regularMarketPrice || closes[closes.length - 1];
      const prev = meta.previousClose || meta.chartPreviousClose;
      return {
        code, source: 'Yahoo', market: suffix === 'KS' ? 'KOSPI' : 'KOSDAQ',
        price: last, previousClose: prev, change: last - prev,
        changeRate: prev ? ((last - prev) / prev) * 100 : 0,
        volume: volumes[volumes.length - 1] || 0,
        ts: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
      };
    } catch {}
  }
  return (await naverStock(code)) || { code, error: 'NOT_FOUND' };
}

export function isValidYahooResult(meta, code, suffix) {
  if (!meta) return false;
  const sym = (meta.symbol || '').toUpperCase();
  const expected = `${code}.${suffix}`;
  if (sym && sym !== expected.toUpperCase()) return false;
  const name = meta.longName || meta.shortName || '';
  if (name.includes(',')) return false;
  return true;
}

export async function krxHistory(code) {
  const serviceKey = process.env.KRX_SERVICE_KEY;
  if (!serviceKey) return null;
  const now = new Date();
  const endDt = now.toISOString().slice(0, 10).replace(/-/g, '');
  const from = new Date(now); from.setMonth(from.getMonth() - 14); // 52주 + 휴장 버퍼
  const beginDt = from.toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const url = `https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo`
      + `?serviceKey=${serviceKey}&likeSrtnCd=${code}&beginBasDt=${beginDt}&endBasDt=${endDt}&numOfRows=300&resultType=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const body = data.response?.body;
    const raw = body?.items?.item;
    if (!raw) return null;
    // likeSrtnCd는 부분일치라 복수 종목이 잡히면 numOfRows에서 잘린다. API 기본 정렬이
    // 과거순이면 최신 봉이 통째로 유실돼 1년 전 종가가 현재가로 응답되는 무증상 오류가 된다.
    // 잘림이 의심되면 폴백(Naver/Yahoo)으로 넘긴다.
    if (Number(body?.totalCount) > 300) return null;
    const list = Array.isArray(raw) ? raw : [raw];
    const filtered = list.filter(i => i.srtnCd === code);
    const items = (filtered.length > 0 ? filtered : list).sort((a, b) => a.basDt.localeCompare(b.basDt));
    // 최신 봉 유실 2차 방어 — 장기 연휴(최대 5영업일)를 넘는 공백이면 신뢰하지 않는다
    const lastDt = items.at(-1)?.basDt;
    if (!lastDt) return null;
    const lastMs = Date.parse(`${lastDt.slice(0, 4)}-${lastDt.slice(4, 6)}-${lastDt.slice(6, 8)}`);
    if (!Number.isFinite(lastMs) || Date.now() - lastMs > 14 * 24 * 60 * 60 * 1000) return null;
    return items;
  } catch { return null; }
}

export async function yahooHistory(code) {
  for (const suffix of ['KS', 'KQ']) {
    try {
      // range=1y: 52주 고저·MDD 산출에 필요. 6mo이면 "최근 1년 최대낙폭" 표기가 실제와 어긋난다.
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.${suffix}?interval=1d&range=1y`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      const result = data.chart?.result?.[0];
      if (!result) continue;
      if (!isValidYahooResult(result.meta, code, suffix)) continue;
      return { result, market: suffix === 'KS' ? 'KOSPI' : 'KOSDAQ' };
    } catch {}
  }
  return null;
}

export function classifyDisclosure(title) {
  if (/사업보고서|분기보고서|반기보고서/.test(title)) return 'earnings';
  if (/주요사항/.test(title))  return 'major';
  if (/임원|주요주주/.test(title)) return 'insider';
  if (/자기주식/.test(title))  return 'buyback';
  if (/공개매수/.test(title))  return 'takeover';
  if (/합병|인수|분할/.test(title)) return 'ma';
  return 'general';
}

export async function fetchDartDisclosures(corpCode, dartKey) {
  const now = new Date();
  const bgn = new Date(now); bgn.setDate(bgn.getDate() - 90);
  const bgnDe = bgn.toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const url = `https://opendart.fss.or.kr/api/list.json`
      + `?crtfc_key=${dartKey}&corp_code=${corpCode}&bgn_de=${bgnDe}&sort=date&sort_mth=desc&page_count=10`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    if (data.status !== '000' || !Array.isArray(data.list)) return [];
    return data.list.slice(0, 8).map(item => ({
      title: item.report_nm,
      date: `${item.rcept_dt.slice(0,4)}-${item.rcept_dt.slice(4,6)}-${item.rcept_dt.slice(6,8)}`,
      type: classifyDisclosure(item.report_nm),
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
    }));
  } catch { return []; }
}

export async function fetchYahooNews(code) {
  for (const suffix of ['KS', 'KQ']) {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${code}.${suffix}&newsCount=6&enableFuzzyQuery=false&lang=ko-KR`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      const news = data.news || [];
      if (!news.length) continue;
      return news.slice(0, 6).map(n => ({
        title: n.title,
        date: new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10),
        publisher: n.publisher,
        url: n.link,
      }));
    } catch {}
  }
  return [];
}

export const KRX_INDICES = [
  { id: 'kospi',  idxNm: '코스피', name: '코스피',  yahooSymbol: '^KS11' },
  { id: 'kosdaq', idxNm: '코스닥', name: '코스닥', yahooSymbol: '^KQ11' },
];

export const YAHOO_SYMBOLS = [
  { id: 'sp500',  symbol: '^GSPC',  name: 'S&P 500' },
  { id: 'nasdaq', symbol: '^IXIC',  name: '나스닥' },
  { id: 'dow',    symbol: '^DJI',   name: '다우' },
  { id: 'usdkrw', symbol: 'KRW=X',  name: 'USD/KRW' },
  { id: 'us10y',  symbol: '^TNX',   name: '美 10Y' },
  { id: 'vix',    symbol: '^VIX',   name: 'VIX' },
];

export async function fetchIndex(entry) {
  const serviceKey = process.env.KRX_SERVICE_KEY;
  if (serviceKey) {
    try {
      const url = `https://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getStockMarketIndex`
        + `?serviceKey=${serviceKey}&idxNm=${encodeURIComponent(entry.idxNm)}&numOfRows=1&resultType=json`;
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        const raw = data.response?.body?.items?.item;
        if (raw) {
          const item = Array.isArray(raw) ? raw[0] : raw;
          const price  = parseFloat(String(item.clpr).replace(/,/g, ''));
          const change = parseFloat(String(item.vs).replace(/,/g, ''));
          return { id: entry.id, name: entry.name, source: 'KRX', price, previousClose: price - change, change, changeRate: parseFloat(item.fltRt) };
        }
      }
    } catch {}
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${entry.yahooSymbol}?interval=1d&range=2d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { id: entry.id, name: entry.name, error: true };
    const data = await r.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return { id: entry.id, name: entry.name, error: true };
    const price = meta.regularMarketPrice;
    const prev  = meta.previousClose || meta.chartPreviousClose;
    return { id: entry.id, name: entry.name, source: 'Yahoo(fallback)', price, previousClose: prev, change: price - prev, changeRate: prev ? (price - prev) / prev * 100 : 0 };
  } catch { return { id: entry.id, name: entry.name, error: true }; }
}

// 코스피200 선물 — Hyperliquid 'xyz' 빌더 dex의 KR200 무기한 선물(perp).
// 정규장·시간외 무관 24시간 시세 → 장 마감 후 다음날 방향 신호. (hlkr.co.kr 방식)
// 공식 KRX 정규 선물이 아닌 24h 참고용 합성가이므로 name에 '(24h)' 명시.
export async function fetchKospiFutures() {
  const FALLBACK = { id: 'kf', name: '코스피200 선물(24h)', error: true };
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }),
    });
    if (!r.ok) return FALLBACK;
    const data = await r.json();
    const universe = data?.[0]?.universe || [];
    const ctxs     = data?.[1] || [];
    const idx = universe.findIndex(u => u.name === 'xyz:KR200');
    if (idx < 0) return FALLBACK;
    const c = ctxs[idx] || {};
    const price = parseFloat(c.markPx ?? c.midPx);
    const prev  = parseFloat(c.prevDayPx);
    if (!Number.isFinite(price)) return FALLBACK;
    const hasPrev = Number.isFinite(prev) && prev > 0;
    return {
      id: 'kf', name: '코스피200 선물(24h)', source: 'HL(perp)',
      price,
      previousClose: hasPrev ? prev : null,
      change:        hasPrev ? price - prev : null,
      changeRate:    hasPrev ? (price - prev) / prev * 100 : null,
    };
  } catch { return FALLBACK; }
}

export async function fetchYahooSymbol(entry) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${entry.symbol}?interval=1d&range=2d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { ...entry, error: true };
    const meta = (await r.json()).chart?.result?.[0]?.meta;
    if (!meta) return { ...entry, error: true };
    const price = meta.regularMarketPrice;
    const prev  = meta.previousClose || meta.chartPreviousClose;
    return { id: entry.id, name: entry.name, source: 'Yahoo', price, previousClose: prev, change: price - prev, changeRate: prev ? (price - prev) / prev * 100 : 0 };
  } catch { return { ...entry, error: true }; }
}

// ── 미국 유니버스 (다우30 + 나스닥100 핵심) — [티커, 이름, 섹터] ──
export const US_UNIVERSE = [
  // 빅테크/반도체
  ['AAPL','애플','IT'], ['MSFT','마이크로소프트','IT'], ['GOOGL','알파벳','IT'],
  ['AMZN','아마존','유통소비재'], ['META','메타','IT'], ['NVDA','엔비디아','반도체'],
  ['AVGO','브로드컴','반도체'], ['AMD','AMD','반도체'], ['INTC','인텔','반도체'],
  ['QCOM','퀄컴','반도체'], ['TXN','텍사스인스트루먼트','반도체'], ['MU','마이크론','반도체'],
  ['AMAT','어플라이드머티어리얼즈','반도체'], ['LRCX','램리서치','반도체'], ['ADI','아나로그디바이스','반도체'],
  ['TSLA','테슬라','자동차'], ['NFLX','넷플릭스','IT'], ['ADBE','어도비','IT'],
  ['CRM','세일즈포스','IT'], ['ORCL','오라클','IT'], ['CSCO','시스코','IT'],
  ['IBM','IBM','IT'], ['NOW','서비스나우','IT'], ['INTU','인튜이트','IT'],
  ['PLTR','팔란티어','IT'], ['PANW','팔로알토','IT'], ['SNPS','시놉시스','반도체'],
  ['KLAC','KLA','반도체'], ['MRVL','마벨','반도체'],
  // 소비재/유통
  ['COST','코스트코','유통소비재'], ['WMT','월마트','유통소비재'], ['HD','홈디포','유통소비재'],
  ['MCD','맥도날드','유통소비재'], ['NKE','나이키','유통소비재'], ['SBUX','스타벅스','유통소비재'],
  ['PEP','펩시코','식품음료'], ['KO','코카콜라','식품음료'], ['PG','P&G','유통소비재'],
  ['DIS','디즈니','IT'], ['BKNG','부킹','유통소비재'], ['MDLZ','몬델리즈','식품음료'],
  // 금융
  ['JPM','JP모건','금융'], ['V','비자','금융'], ['MA','마스터카드','금융'],
  ['BAC','뱅크오브아메리카','금융'], ['WFC','웰스파고','금융'], ['GS','골드만삭스','금융'],
  ['MS','모건스탠리','금융'], ['AXP','아메리칸익스프레스','금융'], ['BLK','블랙록','금융'],
  // 헬스케어/바이오
  ['UNH','유나이티드헬스','바이오'], ['JNJ','존슨앤존슨','바이오'], ['LLY','일라이릴리','바이오'],
  ['ABBV','애브비','바이오'], ['MRK','머크','바이오'], ['PFE','화이자','바이오'],
  ['TMO','써모피셔','바이오'], ['AMGN','암젠','바이오'], ['GILD','길리어드','바이오'],
  ['ISRG','인튜이티브서지컬','바이오'], ['VRTX','버텍스','바이오'], ['REGN','리제네론','바이오'],
  // 산업/에너지/기타
  ['XOM','엑슨모빌','에너지화학'], ['CVX','셰브론','에너지화학'], ['CAT','캐터필러','산업재'],
  ['BA','보잉','조선방산'], ['GE','GE에어로스페이스','조선방산'], ['HON','하니웰','산업재'],
  ['RTX','RTX','조선방산'], ['LMT','록히드마틴','조선방산'], ['UNP','유니온퍼시픽','물류운송'],
  ['UPS','UPS','물류운송'], ['DE','디어','산업재'], ['LIN','린데','에너지화학'],
  // 통신/미디어
  ['T','AT&T','통신'], ['VZ','버라이즌','통신'], ['CMCSA','컴캐스트','통신'],
  ['TMUS','T모바일','통신'],
];

// 미국 개별종목 일봉 (Yahoo) — 미국 스캔용
// range=1y: 52주 고가 산출에 필요. 8mo이면 "52주 신고가" 판정이 실제로는 8개월 고가가 되어
// 한국 종목(252봉)과 livermoreScore를 교차 비교할 수 없다.
export async function fetchUsStockDaily(ticker, range = '1y') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const result = (await r.json()).chart?.result?.[0];
    const meta = result?.meta;
    const q = result?.indicators?.quote?.[0];
    if (!meta || !q) return null;
    const ts = result.timestamp || [];
    const valid = (q.close || []).map((c, i) => c != null ? i : -1).filter(i => i >= 0);
    if (valid.length < 30) return null;
    return {
      closes:  valid.map(i => q.close[i]),
      highs:   valid.map(i => q.high[i]),
      lows:    valid.map(i => q.low[i]),
      volumes: valid.map(i => q.volume[i] || 0),
      price: meta.regularMarketPrice ?? q.close[valid.at(-1)],
      prevClose: meta.previousClose ?? meta.chartPreviousClose ?? null,
    };
  } catch { return null; }
}

export async function fetchIndexOHLCV(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const d = await r.json();
  const result = d.chart?.result?.[0];
  if (!result) throw new Error('no result');
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] ?? null }))
    .filter(x => x.close != null);
}

// 전체 스캔 유니버스
export const KS_UNIVERSE = [
  // ── 반도체/전기전자 ──
  '005930','000660','009150','034220','012330','066570','011070',
  '373220','006400','051910','003670','010130','011780','298050','285130','010060',
  '000990', // DB하이텍
  '010120', // LS ELECTRIC (구 LS산전)
  // ── 자동차/부품 ──
  '005380','000270','064350','004020','018880','204320',
  '161390', // 한국타이어앤테크놀로지
  '073240', // 금호타이어
  '002350', // 넥센타이어
  '017800', // 현대엘리베이터
  // ── 금융/은행/보험 ──
  '105560','055550','086790','316140','071050','005940','006800','016360',
  '000810','001450','039490','138040',
  '138930', // BNK금융지주
  '175330', // JB금융지주
  '029780', // 삼성카드
  '003540', // 대신증권
  '001500', // 현대차증권
  '001720', // 신영증권
  '000060', // 메리츠화재
  // ── 제약/바이오 ──
  '207940','128940','069620','000100','302440','068270','326030',
  '006280', // 녹십자
  '170900', // 동아에스티
  '000020', // 동화약품
  '001060', // JW홀딩스
  '003220', // 대원제약
  // ── IT/플랫폼/게임 ──
  '035420','035720','017670','030200','032640','036570','251270','259960',
  '181710', // NHN
  // ── 에너지/화학 ──
  '010950','096770','009830','011170','002380',
  '078930', // GS
  '036490', // SK가스
  '004210', // 삼천리
  '006650', // 대한유화
  '001430', // 세아베스틸지주
  '120110', // 코오롱인더스트리
  // ── 조선/방산/항공 ──
  '000720','047810','011200','034730','329180','010140','042660','012450','034020','272210',
  '009540', // HD한국조선해양
  '010620', // HD현대미포조선
  '042670', // HD현대인프라코어
  // ── 건설/엔지니어링 ──
  '006360','375500','294870',
  '047040', // 대우건설
  '028050', // 삼성엔지니어링
  '000210', // DL
  // ── 유통/소비재 ──
  '139480','023530','001800','033780','097950','007070','069960','004370','271560','051900',
  '004170', // 신세계
  '035250', // 강원랜드
  '021240', // 코웨이
  '008770', // 호텔신라
  '009240', // 한샘
  '111770', // 영원무역
  // ── 식품/음료 ──
  '000080', // 하이트진로
  '007310', // 오뚜기
  '003230', // 삼양식품
  '280360', // 롯데웰푸드
  '001790', // 대한제당
  // ── 지주/복합 ──
  '028260','003550','032830','352820','005490','011790','005830','001040',
  '002790', // 아모레G
  '090430', // 아모레퍼시픽
  '001740', // SK네트웍스
  // ── 전력/유틸리티 ──
  '015760','036460','000880','088350','088790','024110','003490',
  '051600', // 한전KPS
  '052690', // 한전기술
  // ── 지주사/기타 대형주 ──
  '000150','006260','267250',
  '086280','000120','047050','030000','004490','180640',
  // ── 반도체장비/소재 ──
  '042700','014680',
  // ── 물류/운송 ──
  '011500', // 한진
  // ── 시멘트/건자재 ──
  '003300', // 한일시멘트
  '004700', // 조선내화
];

export const KQ_UNIVERSE = [
  '247540','086520','278530','357780','066970',
  '039030','058610','095340','058470','089030','240810','036930','084370','067310','403870',
  '104830','166090',
  '196170','145020','185750','214150','039200','096530','277810','298380',
  '041510','035900','122870','293490','263750','112040','225570',
  '053800','276730','317770','099430','035760',
  '012860','418470','377300','090460','161890','178320','049070','054620','112610',
];
