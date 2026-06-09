import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

export default function NewsFeed() {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/news/home', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!cancelled) { setNews(d.news || []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="px-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">시장 뉴스</h3>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 bg-surface-900 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : news.length === 0 ? (
        <p className="text-sm text-slate-500 py-4 text-center">뉴스를 불러올 수 없습니다</p>
      ) : (
        <div className="divide-y divide-slate-800">
          {news.map((item, i) => (
            <a
              key={i}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block py-3 group"
            >
              <p className="text-sm text-slate-200 group-hover:text-white line-clamp-2 leading-snug">
                {item.title}
              </p>
              <div className="flex gap-2 mt-1">
                <span className="text-[11px] text-slate-500">{item.publisher}</span>
                <span className="text-[11px] text-slate-600">{item.date}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
