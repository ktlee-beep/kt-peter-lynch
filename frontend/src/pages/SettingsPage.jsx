import { useState, useEffect } from 'react';
import { useAuth, authHeaders } from '../contexts/AuthContext';

function Section({ title, subtitle, children }) {
  return (
    <div className="px-4 mt-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider">{title}</span>
        {subtitle && <span className="text-[10px] text-slate-500">{subtitle}</span>}
      </div>
      <div className="bg-surface-900 rounded-2xl p-4">{children}</div>
    </div>
  );
}

// ── 계정 / 로그인 (전체) ──────────────────────────────────────────
function AccountSection() {
  const { user, logout } = useAuth();
  return (
    <Section title="계정">
      <div className="space-y-2.5">
        <div className="flex justify-between items-center">
          <span className="text-xs text-slate-500">이메일</span>
          <span className="text-sm text-white">{user?.email || '-'}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs text-slate-500">권한</span>
          <span className={`text-xs font-semibold ${user?.role === 'master' ? 'text-brand-400' : 'text-slate-300'}`}>
            {user?.role === 'master' ? '마스터' : '일반'}
          </span>
        </div>
      </div>
      <button
        onClick={logout}
        className="w-full mt-4 bg-red-500/10 text-red-400 hover:bg-red-500/20 font-medium rounded-xl py-2.5 text-sm transition-colors"
      >
        로그아웃
      </button>
    </Section>
  );
}

// ── 가입자 관리 (마스터 전용) ─────────────────────────────────────
function UserManagement() {
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [form, setForm]       = useState({ email: '', password: '', role: 'user', memo: '' });

  const load = () => {
    setLoading(true);
    fetch('/api/admin/users', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setUsers(d.users || []); setErr(d.error || ''); setLoading(false); })
      .catch(e => { setErr(e.message); setLoading(false); });
  };
  useEffect(load, []);

  const addUser = async () => {
    if (!form.email || !form.password) { setErr('이메일과 비밀번호를 입력하세요'); return; }
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '추가 실패');
      setForm({ email: '', password: '', role: 'user', memo: '' });
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const delUser = async (email) => {
    if (!window.confirm(`${email} 계정을 삭제할까요?`)) return;
    setErr('');
    try {
      const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: 'DELETE', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '삭제 실패');
      load();
    } catch (e) { setErr(e.message); }
  };

  const resetPw = async (email) => {
    const pw = window.prompt(`${email}의 새 비밀번호를 입력하세요 (6자 이상 권장)`);
    if (!pw) return;
    setErr('');
    try {
      const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '변경 실패');
      window.alert('비밀번호가 변경되었습니다');
    } catch (e) { setErr(e.message); }
  };

  const inputCls = 'w-full bg-surface-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-500';

  return (
    <Section title="가입자 관리" subtitle="마스터 전용">
      {/* 신규 추가 */}
      <div className="space-y-2">
        <input className={inputCls} type="email" placeholder="이메일" value={form.email}
          onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        <input className={inputCls} type="text" placeholder="초기 비밀번호" value={form.password}
          onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
        <div className="flex gap-2">
          <select className={`${inputCls} flex-shrink-0 w-28`} value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="user">일반</option>
            <option value="master">마스터</option>
          </select>
          <input className={inputCls} type="text" placeholder="메모(선택)" value={form.memo}
            onChange={e => setForm(f => ({ ...f, memo: e.target.value }))} />
        </div>
        <button onClick={addUser} disabled={busy}
          className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white font-medium rounded-lg py-2.5 text-sm transition-colors">
          {busy ? '추가 중...' : '가입자 추가'}
        </button>
      </div>

      {err && <p className="text-xs text-red-400 mt-3 bg-red-400/10 rounded-lg px-3 py-2">{err}</p>}

      {/* 목록 */}
      <div className="mt-4 border-t border-slate-800 pt-3">
        <p className="text-[10px] text-slate-500 mb-2">가입자 {users.length}명</p>
        {loading ? (
          <p className="text-xs text-slate-500 py-2">불러오는 중...</p>
        ) : users.length === 0 ? (
          <p className="text-xs text-slate-500 py-2">가입자가 없습니다</p>
        ) : (
          <ul className="space-y-2">
            {users.map(u => (
              <li key={u.email} className="flex items-center justify-between gap-2 bg-surface-950 rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-white truncate">{u.email}</span>
                    {u.role === 'master' && <span className="text-[9px] bg-brand-500/20 text-brand-400 px-1 rounded flex-shrink-0">마스터</span>}
                  </div>
                  <p className="text-[10px] text-slate-600">
                    {u.last_login ? `최근 ${String(u.last_login).slice(0, 10)}` : '로그인 이력 없음'}
                    {u.memo ? ` · ${u.memo}` : ''}
                  </p>
                </div>
                {u.role !== 'master' && (
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button onClick={() => resetPw(u.email)} className="text-[11px] text-slate-400 hover:text-white px-1.5 py-1">비번</button>
                    <button onClick={() => delUser(u.email)} className="text-[11px] text-red-400 hover:text-red-300 px-1.5 py-1">삭제</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

// ── 관리자 도구 (마스터 전용) ─────────────────────────────────────
function AdminTools() {
  const [busy, setBusy] = useState('');
  const [log, setLog]   = useState('');

  const migrate = async () => {
    setBusy('migrate'); setLog('');
    try {
      const r = await fetch('/api/migrate', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '실패');
      const fails = (d.results || []).filter(x => !x.ok);
      setLog(`DB 마이그레이션 완료: ${d.count}개 문장 실행, 실패 ${fails.length}건`
        + (fails.length ? '\n' + fails.map(f => `- ${f.stmt}: ${f.err}`).join('\n') : ''));
    } catch (e) { setLog(`DB 마이그레이션 오류: ${e.message}`); } finally { setBusy(''); }
  };

  const genBrief = async () => {
    setBusy('brief'); setLog('');
    try {
      const r = await fetch('/api/brief/generate', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '실패');
      setLog(`${d.message || '아침 브리핑 생성 시작됨'}\n(약 10초 후 홈 화면을 새로고침하면 카드가 표시됩니다)`);
    } catch (e) { setLog(`아침 브리핑 생성 오류: ${e.message}`); } finally { setBusy(''); }
  };

  const refreshCorp = async () => {
    setBusy('corp'); setLog('');
    try {
      const r = await fetch('/api/admin/refresh-corpcodes', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw new Error(d.error || '실패');
      setLog(`DART 기업코드 갱신 완료: ${d.count}개 저장 (전체 상장사 ${d.total ?? '?'}개)\n다음 스캔부터 전 종목 DART 재무·피오트로스키가 반영됩니다.`);
    } catch (e) { setLog(`DART 기업코드 갱신 오류: ${e.message}`); } finally { setBusy(''); }
  };

  const runScan = async () => {
    setBusy('scan'); setLog('');
    try {
      const r = await fetch('/api/scan/trigger', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '실패');
      setLog(`${d.message || '스캔 시작됨'}\n(전체 종목 스캔은 수 분 소요. 완료 후 스크리너·오늘의 추천에 반영됩니다.)`);
    } catch (e) { setLog(`스캔 실행 오류: ${e.message}`); } finally { setBusy(''); }
  };

  const btnCls = 'w-full text-left bg-surface-950 hover:bg-slate-800 rounded-xl px-4 py-3 transition-colors disabled:opacity-50';

  return (
    <Section title="관리자 도구" subtitle="마스터 전용">
      <div className="space-y-2.5">
        <button onClick={migrate} disabled={!!busy} className={btnCls}>
          <div className="text-sm font-semibold text-white">{busy === 'migrate' ? '실행 중...' : 'DB 마이그레이션'}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">schema.sql 적용 — 신규 테이블 생성/갱신 (기존 데이터 보존)</div>
        </button>
        <button onClick={genBrief} disabled={!!busy} className={btnCls}>
          <div className="text-sm font-semibold text-white">{busy === 'brief' ? '실행 중...' : '아침 브리핑 즉시 생성'}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">08:00 스케줄을 기다리지 않고 지금 브리핑 생성</div>
        </button>
        <button onClick={refreshCorp} disabled={!!busy} className={btnCls}>
          <div className="text-sm font-semibold text-white">{busy === 'corp' ? '실행 중...' : 'DART 기업코드 갱신'}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">전체 상장사 corp_code 적재 — 스캔 DART 재무·F-Score의 전제</div>
        </button>
        <button onClick={runScan} disabled={!!busy} className={btnCls}>
          <div className="text-sm font-semibold text-white">{busy === 'scan' ? '실행 중...' : '지금 전체 스캔 실행'}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">20:00을 기다리지 않고 즉시 스캔 — DART F-Score 반영 확인용</div>
        </button>
      </div>
      {log && (
        <pre className="mt-3 text-[11px] text-slate-300 bg-surface-950 rounded-lg px-3 py-2 whitespace-pre-wrap break-words">{log}</pre>
      )}
    </Section>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isMaster = user?.role === 'master';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-3 bg-surface-950">
        <h1 className="text-xl font-bold text-white">설정</h1>
        <p className="text-xs text-slate-500 mt-0.5">계정 · 가입자 · 관리자 도구</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
        <AccountSection />
        {isMaster && <UserManagement />}
        {isMaster && <AdminTools />}
        {!isMaster && (
          <p className="px-4 mt-5 text-[11px] text-slate-600">가입자 관리·관리자 도구는 마스터 계정만 사용할 수 있습니다.</p>
        )}
        <div className="h-6" />
      </div>
    </div>
  );
}
