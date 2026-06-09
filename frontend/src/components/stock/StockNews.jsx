import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

function NewsItem({ title, date, url, source, type }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block py-3 border-b border-slate-800 last:border-0 group"
    >
      <div className="flex items-start gap-2">
        {type === 'dart' && (
          <span className="flex-shrink-0 mt-0.5 text-[10px] px-1.5 py-px bg-blue-500/20 text-blue-400 rounded font-medium">공시</span>
        )}
        <p className="text-sm text-slate-200 group-hover:text-white leading-snug line-clamp-2 flex-1">{title}</p>
      </div>
      <div className="flex gap-2 mt-1">
        {source && <span className="text-[11px] text-slate-500">{source}</span>}
        {date && <span className="text-[11px] text-slate-600">{date}</span>}
      </div>
    </a>
  );
}

export default function StockNews({ code }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/news?code=${encodeURIComponent(code)}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const discItems = (d.disclosures || []).slice(0, 5).map(x => ({
          title: x.report_nm || x.title,
          date: x.rcept_dt ? x.rcept_dt.slice(0, 10) : '',
          url: x.url || `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}`,
          source: 'DART 공시',
          type: 'dart',
        }));
        const newsItems = (d.yahooNews || []).slice(0, 5).map(x => ({
          title: x.title,
          date: x.date,
          url: x.url || x.link,
          source: x.publisher,
          type: 'news',
        }));
        setItems([...discItems, ...newsItems]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [code]);

  return (
    <section className="px-4 mt-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-1">뉴스 / 공시</h3>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 bg-surface-900 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500 py-4 text-center">뉴스/공시 정보가 없습니다</p>
      ) : (
        <div>
          {items.map((item, i) => (
            <NewsItem key={i} {...item} />
          ))}
        </div>
      )}
    </section>
  );
}
