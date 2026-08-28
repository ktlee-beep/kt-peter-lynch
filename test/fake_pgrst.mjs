// PostgREST/DART 가짜 서버 — Supabase 자격증명 없이 db.js·cron.js의 DB 구간을 검증한다.
// globalThis.fetch를 가로채므로 db.js가 getSupabase()로 클라이언트를 만들기 "전에" 설치해야 한다
// (supabase-js는 생성 시점의 fetch 바인딩을 캡처한다).

export const table  = { rows: [] }; // kt_fundamentals_cache. 삽입 순서 보존 — ORDER BY 없는 OFFSET의 위험을 재현하려면 필요
export const stocks = { rows: [] }; // kt_stocks

function storeFor(pathname) {
  return pathname.endsWith('/kt_stocks') ? stocks.rows : table.rows;
}
export const stats = { dartCalls: 0, pgSelects: 0, pgUpserts: 0, pgUpdates: 0, naverCalls: 0 };

// PostgREST db-max-rows 상한을 흉내낸다. 서버 설정이 낮아진 상황을 만들 수 있어야
// 페이지네이션 종료 조건이 그 값에 의존하는지 확인할 수 있다.
export const cfg = {
  maxRows: 1000,
  honorOrder: true,   // false면 ORDER BY를 무시하는 서버(=정렬 없는 OFFSET)를 흉내낸다
  onPageServed: null, // 페이지 응답 직후 훅 — 페이지 사이 쓰기를 끼워 넣는 데 쓴다
};

const SB = 'https://fake.supabase.co';
export const SUPABASE_URL = SB;

// 네이버 일괄 시세 원천의 상태. mode로 장애·형식변경·부분응답을 재현한다.
export const naver = { mode: 'ok', items: [] };

// supabase-js는 헤더를 Headers 인스턴스로 넘길 수도, 평범한 객체로 넘길 수도 있다.
// 한쪽만 보면 Prefer를 못 읽어 count가 조용히 null이 된다(하네스 자체 버그였음).
function readHeaders(init) {
  const src = init.headers instanceof Headers
    ? [...init.headers]
    : Object.entries(init.headers || {});
  return Object.fromEntries(src.map(([k, v]) => [String(k).toLowerCase(), v]));
}
const wantsCount = (init) => String(readHeaders(init).prefer || '').includes('count=exact');
// PostgREST는 쓰기 요청에도 count=exact가 있으면 Content-Range로 영향 행수를 돌려준다.
// 흉내내지 않으면 count가 항상 null이라 "실제 반영 행수"를 쓰는 코드가 검증되지 않는다.
const countRange = (n) => ({ 'Content-Range': `*/${n}` });

function applyFilters(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'offset' || k === 'limit') continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq')       out = out.filter(r => String(r[k]) === val);
    else if (op === 'gte') out = out.filter(r => String(r[k]) >= val);
    else if (op === 'in') {
      // PostgREST 형식: code=in.("a","b") — 값에 따라 따옴표가 붙기도, 안 붙기도 한다.
      const set = new Set(val.replace(/^\(|\)$/g, '').split(',')
        .map(s => s.trim().replace(/^"|"$/g, '')));
      out = out.filter(r => set.has(String(r[k])));
    }
    else if (op === 'like') {
      // PostgREST의 like: '*'를 '%'로 바꿔 보낸다. '_'는 단일문자 와일드카드다.
      const rx = new RegExp('^' + val.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/[*%]/g, '.*').replace(/_/g, '.') + '$');
      out = out.filter(r => rx.test(String(r[k])));
    }
  }
  return out;
}

export function install() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();

    if (url.startsWith(SB)) {
      const u = new URL(url);
      const params = [...u.searchParams.entries()];
      // 테이블별로 저장소를 나눈다. 한 배열에 몰면 KV 행(__universe__ 등)이 kt_stocks
      // 집계에 섞여 검증이 엉뚱한 수치를 본다 — 실제로 한 번 오탐이 났던 지점.
      const store = storeFor(u.pathname);

      if (method === 'POST') { // upsert
        stats.pgUpserts++;
        const body = JSON.parse(init.body);
        const recs = Array.isArray(body) ? body : [body];
        // 실제 Postgres는 같은 본문에 같은 PK가 두 번 오면 21000
        // (ON CONFLICT DO UPDATE command cannot affect row a second time)로 요청을 거부한다.
        // 하네스가 조용히 두 번 덮어쓰면 원천 중복이 통과해 검증이 사고를 못 잡는다.
        const dups = recs.map(r => r.code).filter((c, i, a) => a.indexOf(c) !== i);
        if (dups.length) {
          return Response.json({ code: '21000',
            message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' }, { status: 400 });
        }
        for (const rec of recs) {
          const i = store.findIndex(r => r.code === rec.code);
          // Postgres의 UPDATE는 힙 튜플을 새 위치에 쓴다 — 갱신된 행이 물리적으로 뒤로 간다.
          // 이 이동이 정렬 없는 OFFSET 페이지네이션에서 행 건너뜀을 만든다.
          const old = i >= 0 ? store[i] : null;
          if (i >= 0) store.splice(i, 1);
          // PostgREST의 ON CONFLICT DO UPDATE는 payload에 있는 컬럼만 SET한다.
          // payload에 없는 컬럼(kt_stocks.sector 등)은 기존 값이 남는다 — 덮어쓰기로
          // 흉내내면 "sector가 보존되는가" 같은 검증이 통과해 버린다.
          store.push({ ...(old || {}), ...rec });
        }
        return new Response(null, { status: 201, headers: wantsCount(init) ? countRange(recs.length) : {} });
      }

      if (method === 'PATCH') { // update
        stats.pgUpdates++;
        const patch = JSON.parse(init.body);
        const targets = applyFilters(store, params);
        for (const t of targets) Object.assign(t, patch);
        return new Response(null, { status: 204, headers: wantsCount(init) ? countRange(targets.length) : {} });
      }

      stats.pgSelects++;
      let rows = applyFilters(store, params);
      const order = u.searchParams.get('order');
      if (order && cfg.honorOrder) {
        const [col, dir] = order.split('.');
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      const total = rows.length;
      const offset = Number(u.searchParams.get('offset') || 0);
      const askLimit = Number(u.searchParams.get('limit') || Infinity);
      const limit = Math.min(askLimit, cfg.maxRows); // 서버 상한이 요청 limit을 이긴다
      let page = rows.slice(offset, offset + limit);

      const headers = { 'Content-Type': 'application/json' };
      if (wantsCount(init)) headers['Content-Range'] = `${offset}-${offset + page.length - 1}/${total}`;

      const sel = u.searchParams.get('select');
      if (sel && sel !== '*') {
        const cols = sel.split(',').map(s => s.trim());
        page = page.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
      }
      if (cfg.onPageServed) cfg.onPageServed({ offset, served: page.length });
      if (method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(JSON.stringify(page), { status: 200, headers });
    }

    // 네이버 일괄 시세 목록 (유니버스 원천)
    if (url.includes('siseListJson.nhn')) {
      stats.naverCalls++;
      // 'live'는 DB만 가짜로 두고 원천은 실제로 때린다 — 응답 형식이 바뀌었는지
      // (필드명·단위·페이지 규약) 실물로 확인하는 용도.
      if (naver.mode === 'live') return realFetch(input, init);
      if (naver.mode === 'down') return new Response('service unavailable', { status: 503 });
      // 응답 형식이 바뀐 상황 — itemList가 통째로 없다. 빈 배열로 흘려보내면
      // 유니버스가 0이 되어 전 종목이 이탈로 판정되는 경로를 재현한다.
      if (naver.mode === 'malformed') return Response.json({ result: { totCnt: 10 } });
      const q = new URL(url).searchParams;
      const sosok = Number(q.get('sosok'));
      const page = Number(q.get('page') || 1);
      const size = Number(q.get('pageSize') || 100);
      const items = naver.items.filter(x => x._sosok === sosok);
      // 서버가 pageSize를 무시하고 자체 상한으로 자르는 상황. totCnt까지 사라지면
      // 종료 조건과 완전성 검사가 한꺼번에 무력화되므로 두 변화를 같이 재현한다.
      if (naver.mode === 'capped') {
        return Response.json({ result: { itemList: items.slice((page - 1) * 1000, page * 1000) } });
      }
      // totCnt 필드 자체가 없는 응답.
      if (naver.mode === 'noTotCnt') {
        return Response.json({ result: { itemList: items.slice((page - 1) * size, page * size) } });
      }
      // 한 시장만 정상 형식의 빈 응답을 주는 상황 — 형식이 멀쩡해 itemList 검사를 통과한다.
      if (naver.mode === 'emptyMarket' && sosok === 1) {
        return Response.json({ result: { totCnt: 0, itemList: [] } });
      }
      // totCnt만 부풀린 응답 — 서버가 조용히 일부만 주는 상황.
      const totCnt = naver.mode === 'truncated' ? items.length + 50 : items.length;
      return Response.json({ result: { totCnt, itemList: items.slice((page - 1) * size, page * size) } });
    }

    if (url.includes('opendart.fss.or.kr')) {
      stats.dartCalls++;
      if (url.includes('/company.json')) {
        return Response.json({ status: '000', corp_name: '테스트', stock_code: '000001',
          induty_code: '264', corp_cls: 'Y', acc_mt: '12', est_dt: '19690113' });
      }
      if (url.includes('/fnlttSinglAcnt.json')) {
        const yr = Number(new URL(url).searchParams.get('bsns_year'));
        const mk = (nm, sj, cur, cum) => ({ fs_div: 'CFS', sj_div: sj, account_nm: nm,
          thstrm_amount: String(cur), thstrm_add_amount: String(cum),
          frmtrm_amount: String(Math.round(cur * 0.9)), frmtrm_add_amount: String(Math.round(cum * 0.9)) });
        return Response.json({ status: '000', list: [
          mk('매출액', 'IS', 1e11 + yr, 2e11 + yr),
          mk('영업이익', 'IS', 1e10 + yr, 2e10 + yr),
          mk('당기순이익', 'IS', 8e9, 1.6e10),
          mk('자본총계', 'BS', 5e11, 5e11),
          mk('부채총계', 'BS', 2e11, 2e11),
        ] });
      }
      return Response.json({ status: '013', message: 'no data' });
    }

    return realFetch(input, init);
  };
}

export function seed(code, obj, ageDays = 0) {
  table.rows.push({ code, raw_json: JSON.stringify(obj),
    updated_at: new Date(Date.now() - ageDays * 86400000).toISOString() });
}
export function reset() {
  table.rows.length = 0;
  stocks.rows.length = 0;
  for (const k of Object.keys(stats)) stats[k] = 0;
  naver.mode = 'ok'; naver.items.length = 0;
}

// 시세 목록 원본 1행. 실제 응답 필드명을 그대로 쓴다 — 단위 환산(백만원→억원)과
// 필드 매핑이 정규화 함수 안에 갇혀 있는지 확인하려면 원본 형태로 넣어야 한다.
export function siseItem({ cd, nm, sosok = 0, capEok = 5000, valEok = 50, etf = false, etn = false, tyn = 'N' }) {
  return { cd, nm, _sosok: sosok, etf, etn, tyn, nv: 10000,
    marketSumRaw: capEok * 100, mks: capEok, aa: valEok * 100, aq: 1000 };
}
