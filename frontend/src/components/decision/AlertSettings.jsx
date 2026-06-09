import { useState, useEffect } from 'react';
import { authHeaders } from '../../contexts/AuthContext';
import StockSearchBar from '../discover/StockSearchBar';

const EMPTY_FORM = { stock: null, target_price: '', stop_loss: '', rsi_high: '75', rsi_low: '30' };

export default function AlertSettings() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/alert-settings', { headers: authHeaders() });
      const d = await r.json();
      setSettings(d.settings || []);
    } catch { setSettings([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.stock) return;
    setSaving(true);
    try {
      const body = {
        code: form.stock.code,
        name: form.stock.name,
        target_price: form.target_price !== '' ? Number(form.target_price) : null,
        stop_loss: form.stop_loss !== '' ? Number(form.stop_loss) : null,
        rsi_high: form.rsi_high !== '' ? Number(form.rsi_high) : null,
        rsi_low: form.rsi_low !== '' ? Number(form.rsi_low) : null,
        is_active: true,
      };
      await fetch('/api/alert-settings', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch {}
    setSaving(false);
  };

  const toggle = async (s) => {
    try {
      await fetch('/api/alert-settings', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...s, is_active: !s.is_active }),
      });
      setSettings(prev => prev.map(x => x.code === s.code ? { ...x, is_active: !x.is_active } : x));
    } catch {}
  };

  const remove = async (code) => {
    try {
      await fetch(`/api/alert-settings/${code}`, { method: 'DELETE', headers: authHeaders() });
      setSettings(prev => prev.filter(x => x.code !== code));
    } catch {}
  };

  if (loading) return (
    <div className="flex items-center justify-center py-10 gap-2">
      <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
      <span className="text-xs text-slate-500">알림 설정 로딩 중...</span>
    </div>
  );

  return (
    <div className="px-4 pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-white">알림 설정</p>
        <button
          onClick={() => setShowForm(v => !v)}
          className="text-xs text-brand-400 border border-brand-400/30 rounded-lg px-3 py-1.5 hover:bg-brand-400/10 transition-colors"
        >
          + 추가
        </button>
      </div>

      {showForm && (
        <div className="bg-surface-900 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-medium text-slate-400">새 알림 규칙</p>

          <div className="rounded-xl overflow-hidden border border-slate-800">
            <StockSearchBar onSelect={s => setForm(p => ({ ...p, stock: s }))} />
          </div>
          {form.stock && (
            <div className="flex items-center gap-2 px-3 py-2 bg-brand-500/10 border border-brand-500/20 rounded-xl">
              <span className="text-sm font-medium text-white">{form.stock.name}</span>
              <span className="text-xs text-slate-500 font-mono">{form.stock.code}</span>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, stock: null }))}
                className="ml-auto text-slate-500 hover:text-slate-300"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-600 mb-1 block">목표가</label>
              <input
                type="number"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-400"
                placeholder="80000"
                value={form.target_price}
                onChange={e => setForm(p => ({ ...p, target_price: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-600 mb-1 block">손절가</label>
              <input
                type="number"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-400"
                placeholder="60000"
                value={form.stop_loss}
                onChange={e => setForm(p => ({ ...p, stop_loss: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-600 mb-1 block">RSI 과매수</label>
              <input
                type="number"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-400"
                value={form.rsi_high}
                onChange={e => setForm(p => ({ ...p, rsi_high: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-600 mb-1 block">RSI 과매도</label>
              <input
                type="number"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-400"
                value={form.rsi_low}
                onChange={e => setForm(p => ({ ...p, rsi_low: e.target.value }))}
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving || !form.stock}
              className="flex-1 bg-brand-400 text-slate-900 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {saving ? '저장 중...' : '저장'}
            </button>
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
              className="px-4 bg-slate-800 text-slate-400 rounded-xl py-2.5 text-sm"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {settings && settings.length === 0 && !showForm && (
        <div className="py-8 text-center">
          <p className="text-sm text-slate-500">설정된 알림이 없습니다</p>
          <p className="text-xs text-slate-700 mt-1">목표가·손절가·RSI 기준을 종목별로 설정하세요</p>
        </div>
      )}

      {settings && settings.length > 0 && (
        <div className="space-y-2">
          {settings.map(s => (
            <div key={s.code} className={`bg-surface-900 rounded-2xl p-3.5 ${!s.is_active ? 'opacity-50' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-semibold text-white">{s.name || s.code}</span>
                  {s.name && <span className="text-[11px] text-slate-500 ml-1.5 font-mono">{s.code}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggle(s)}
                    className={`relative w-10 h-5 rounded-full transition-colors ${s.is_active ? 'bg-brand-400' : 'bg-slate-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${s.is_active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                  <button
                    onClick={() => remove(s.code)}
                    className="text-slate-600 hover:text-loss transition-colors p-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {s.target_price != null && (
                  <p className="text-[10px] text-slate-500">목표가 <span className="text-profit font-medium">{s.target_price.toLocaleString()}</span></p>
                )}
                {s.stop_loss != null && (
                  <p className="text-[10px] text-slate-500">손절가 <span className="text-loss font-medium">{s.stop_loss.toLocaleString()}</span></p>
                )}
                {s.rsi_high != null && (
                  <p className="text-[10px] text-slate-500">RSI 과매수 <span className="text-yellow-400 font-medium">&gt;{s.rsi_high}</span></p>
                )}
                {s.rsi_low != null && (
                  <p className="text-[10px] text-slate-500">RSI 과매도 <span className="text-blue-400 font-medium">&lt;{s.rsi_low}</span></p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[9px] text-slate-700 text-center pb-2">매일 20:00 스캔 시 조건 충족 시 홈 화면에 표시됩니다</p>
    </div>
  );
}
