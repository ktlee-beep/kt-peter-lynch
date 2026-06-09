export async function searchStocks(query) {
  if (!query || query.trim().length < 1) return [];
  const res = await fetch(`/api/stock/search?q=${encodeURIComponent(query.trim())}`, {
    credentials: 'include',
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}
