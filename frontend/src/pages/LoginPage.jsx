import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const inputCls =
  'w-full bg-surface-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors';
const btnCls =
  'w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors mt-2';

export default function LoginPage() {
  // mode: 'login' | 'signup' | 'verify'
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, registerRequestCode, registerVerify } = useAuth();
  const navigate = useNavigate();

  function switchMode(next) {
    setMode(next);
    setError('');
    setNotice('');
    if (next === 'login' || next === 'signup') setCode('');
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestCode(e) {
    e.preventDefault();
    setError(''); setNotice('');
    if (password.length < 8) { setError('비밀번호는 8자 이상이어야 합니다'); return; }
    setLoading(true);
    try {
      const data = await registerRequestCode(email.trim().toLowerCase(), password);
      setMode('verify');
      setNotice(
        data.mailConfigured === false
          ? '메일 발송이 설정되지 않아 서버 콘솔에 코드가 출력되었습니다. (개발 모드)'
          : `${email.trim().toLowerCase()} 로 인증코드를 발송했습니다. (10분 이내 입력)`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    setError('');
    if (!code.trim()) { setError('인증코드를 입력하세요'); return; }
    setLoading(true);
    try {
      await registerVerify(email.trim().toLowerCase(), code.trim());
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setError(''); setNotice('');
    if (!email || password.length < 8) { switchMode('signup'); return; }
    setLoading(true);
    try {
      await registerRequestCode(email.trim().toLowerCase(), password);
      setNotice('인증코드를 다시 발송했습니다.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const title =
    mode === 'login' ? '로그인' : mode === 'signup' ? '회원가입' : '이메일 인증';

  return (
    <div className="min-h-dvh bg-surface-950 flex flex-col items-center justify-center px-6 pt-safe">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="text-2xl font-bold text-white tracking-tight">KT Trading</h1>
          <p className="mt-1 text-sm text-slate-400">나만의 장기 가치투자 분석툴</p>
        </div>

        {notice && (
          <p className="text-sm text-emerald-400 bg-emerald-400/10 rounded-lg px-3 py-2 mb-4">{notice}</p>
        )}
        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2 mb-4">{error}</p>
        )}

        {/* ── 로그인 ── */}
        {mode === 'login' && (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">이메일</label>
              <input type="email" required autoComplete="email" value={email}
                onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="이메일 입력" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">비밀번호</label>
              <input type="password" required autoComplete="current-password" value={password}
                onChange={e => setPassword(e.target.value)} className={inputCls} placeholder="비밀번호 입력" />
            </div>
            <button type="submit" disabled={loading} className={btnCls}>
              {loading ? '로그인 중...' : '로그인'}
            </button>
            <p className="text-center text-sm text-slate-400 pt-2">
              계정이 없으신가요?{' '}
              <button type="button" onClick={() => switchMode('signup')}
                className="text-brand-500 font-semibold hover:underline">회원가입</button>
            </p>
          </form>
        )}

        {/* ── 회원가입 1단계 ── */}
        {mode === 'signup' && (
          <form onSubmit={handleRequestCode} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">이메일</label>
              <input type="email" required autoComplete="email" value={email}
                onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="이메일 입력" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">비밀번호</label>
              <input type="password" required autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)} className={inputCls} placeholder="8자 이상 입력" />
            </div>
            <p className="text-xs text-slate-500">가입을 위해 이메일로 인증코드가 발송됩니다.</p>
            <button type="submit" disabled={loading} className={btnCls}>
              {loading ? '발송 중...' : '인증코드 받기'}
            </button>
            <p className="text-center text-sm text-slate-400 pt-2">
              이미 계정이 있으신가요?{' '}
              <button type="button" onClick={() => switchMode('login')}
                className="text-brand-500 font-semibold hover:underline">로그인</button>
            </p>
          </form>
        )}

        {/* ── 회원가입 2단계: 인증코드 확인 ── */}
        {mode === 'verify' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">인증코드</label>
              <input type="text" required inputMode="numeric" maxLength={6} autoComplete="one-time-code"
                value={code} onChange={e => setCode(e.target.value)} className={inputCls}
                placeholder="이메일로 받은 6자리 코드" />
            </div>
            <button type="submit" disabled={loading} className={btnCls}>
              {loading ? '확인 중...' : '가입 완료'}
            </button>
            <div className="flex items-center justify-between pt-1">
              <button type="button" onClick={handleResend} disabled={loading}
                className="text-sm text-slate-400 hover:text-white">인증코드 재발송</button>
              <button type="button" onClick={() => switchMode('login')}
                className="text-sm text-slate-400 hover:text-white">처음으로</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
