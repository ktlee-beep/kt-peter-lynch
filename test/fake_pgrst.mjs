// PostgREST/DART 가짜 서버 — Supabase 자격증명 없이 db.js·cron.js의 DB 구간을 검증한다.
// globalThis.fetch를 가로채므로 db.js가 getSupabase()로 클라이언트를 만들기 "전에" 설치해야 한다
// (supabase-js는 생성 시점의 fetch 바인딩을 캡처한다).

export const table = { rows: [] }; // 삽입 순서 보존 — ORDER BY 없는 OFFSET의 위험을 재현하려면 필요
export const stats = { dartCalls: 0, pgSelects: 0, pgUpserts: 0 };

// PostgREST db-max-rows 상한을 흉내낸다. 서버 설정이 낮아진 상황을 만들 수 있어야
// 페이지네이션 종료 조건이 그 값에 의존하는지 확인할 수 있다.
export const cfg = {
  maxRows: 1000,
  honorOrder: true,   // false면 ORDER BY를 무시하는 서버(=정렬 없는 OFFSET)를 흉내낸다
  onPageServed: null, // 페이지 응답 직후 훅 — 페이지 사이 쓰기를 끼워 넣는 데 쓴다
};

const SB = 'https://fake.supabase.co';
export const SUPABASE_URL = SB;

function applyFilters(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'offset' || k === 'limit') continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq')       out = out.filter(r => String(r[k]) === val);
    else if (op === 'gte') out = out.filter(r => String(r[k]) >= val);
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

      if (method === 'POST') { // upsert
        stats.pgUpserts++;
        const body = JSON.parse(init.body);
        for (const rec of (Array.isArray(body) ? body : [body])) {
          const i = table.rows.findIndex(r => r.code === rec.code);
          // Postgres의 UPDATE는 힙 튜플을 새 위치에 쓴다 — 갱신된 행이 물리적으로 뒤로 간다.
          // 이 이동이 정렬 없는 OFFSET 페이지네이션에서 행 건너뜀을 만든다.
          if (i >= 0) table.rows.splice(i, 1);
          table.rows.push({ ...rec });
        }
        return new Response(null, { status: 201 });
      }

      stats.pgSelects++;
      let rows = applyFilters(table.rows, params);
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

      // supabase-js는 헤더를 Headers 인스턴스로 넘길 수도, 평범한 객체로 넘길 수도 있다.
      // 한쪽만 보면 Prefer를 못 읽어 count가 조용히 null이 된다(하네스 자체 버그였음).
      const h = init.headers instanceof Headers
        ? Object.fromEntries([...init.headers].map(([k, v]) => [k.toLowerCase(), v]))
        : Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const wantCount = String(h.prefer || '').includes('count=exact');
      const headers = { 'Content-Type': 'application/json' };
      if (wantCount) headers['Content-Range'] = `${offset}-${offset + page.length - 1}/${total}`;

      const sel = u.searchParams.get('select');
      if (sel && sel !== '*') {
        const cols = sel.split(',').map(s => s.trim());
        page = page.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
      }
      if (cfg.onPageServed) cfg.onPageServed({ offset, served: page.length });
      if (method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(JSON.stringify(page), { status: 200, headers });
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
export function reset() { table.rows.length = 0; stats.dartCalls = 0; stats.pgSelects = 0; stats.pgUpserts = 0; }
