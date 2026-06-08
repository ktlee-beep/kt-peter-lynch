// KT Trading — 외부 데이터 수집 (KRX, Yahoo, Naver, OpenDart)
// env.* → process.env.* 으로 변환

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
    return {
      per:           n(d.per),
      eps:           n(d.eps),
      roe:           n(d.roe),
      pbr:           n(d.pbr),
      dividendYield: n(d.yield),
      marketCap:     n(d.marketSum),   // 억원 단위
    };
  } catch { return null; }
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
      const IS = data.list.filter(i => i.sj_div === 'IS');
      const toNum = (s) => parseInt((s || '0').replace(/,/g, ''), 10);
      const find = (keywords) => {
        for (const kw of keywords) {
          const item = IS.find(i => i.account_nm?.includes(kw));
          if (item) return { cur: toNum(item.thstrm_amount), prev: toNum(item.frmtrm_amount) };
        }
        return null;
      };
      const rev = find(['매출액', '수익(매출액)', '영업수익', '매출']);
      const op  = find(['영업이익', '영업손익']);
      if (!rev || rev.cur === 0) continue;
      const revenueGrowth = rev.prev ? ((rev.cur - rev.prev) / Math.abs(rev.prev)) * 100 : null;
      const opMargin      = rev.cur  > 0 && op ? (op.cur / rev.cur) * 100 : null;
      const opGrowth      = op && op.prev > 0  ? ((op.cur - op.prev) / Math.abs(op.prev)) * 100 : null;
      return { revenueGrowth, opMargin, opGrowth, year: bsnsYear };
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

export async function naverHistory(code) {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=130&requestType=0`;
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
  const sixAgo = new Date(now); sixAgo.setMonth(sixAgo.getMonth() - 6);
  const beginDt = sixAgo.toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const url = `https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo`
      + `?serviceKey=${serviceKey}&likeSrtnCd=${code}&beginBasDt=${beginDt}&endBasDt=${endDt}&numOfRows=200&resultType=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const raw = data.response?.body?.items?.item;
    if (!raw) return null;
    const list = Array.isArray(raw) ? raw : [raw];
    const filtered = list.filter(i => i.srtnCd === code);
    const items = (filtered.length > 0 ? filtered : list).sort((a, b) => a.basDt.localeCompare(b.basDt));
    return items;
  } catch { return null; }
}

export async function yahooHistory(code) {
  for (const suffix of ['KS', 'KQ']) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.${suffix}?interval=1d&range=6mo`;
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
  '005380','000270','064350','004020','018880',
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
  '204320','012860','418470','377300','090460','161890','178320','049070','054620','112610',
];
