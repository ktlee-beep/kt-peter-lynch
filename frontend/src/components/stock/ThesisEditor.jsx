import { useState, useEffect, useRef, useCallback } from 'react';
import { authHeaders } from '../../contexts/AuthContext';

const QUESTIONS = [
  {
    key: 'story',
    label: '이 회사는 무엇을 하는가?',
    hint: '사업 모델, 주요 제품/서비스, 매출 구조를 한두 문장으로.',
    placeholder: '예) 반도체 메모리 세계 1위 기업으로, DRAM과 NAND를 전 세계 스마트폰·서버 제조사에 공급한다.',
  },
  {
    key: 'growth',
    label: '왜 앞으로 성장하는가?',
    hint: '성장 드라이버, 시장 트렌드, 회사 경쟁 우위.',
    placeholder: '예) AI 서버 증가로 HBM 수요 폭발. 경쟁사 대비 HBM3E 양산 속도 앞섬.',
  },
  {
    key: 'valuation',
    label: '지금 가격이 이 이야기보다 싼가?',
    hint: 'PER/PBR 대비 성장률 평가, 적정가 근거.',
    placeholder: '예) PBR 1.5x는 ROE 18% 대비 저평가. PEG 기준 적정가 8만원 대비 현재 6.5만원.',
  },
  {
    key: 'exit_plan',
    label: '언제 팔 것인가?',
    hint: '매도 기준을 구체적으로. 목표주가, 펀더멘털 훼손 시나리오.',
    placeholder: '예) HBM 점유율 하락 or PBR 2.5x 도달 시 절반 매도. 메모리 업황 하강 신호(재고 증가) 시 전량 매도.',
  },
];

const AUTO_SAVE_MS = 30000;

export default function ThesisEditor({ code, name }) {
  const [fields, setFields] = useState({ story: '', growth: '', valuation: '', exit_plan: '' });
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef(null);
  const lastSavedRef = useRef('');

  useEffect(() => {
    if (!code) return;
    fetch(`/api/thesis?code=${code}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        const vals = { story: d.story || '', growth: d.growth || '', valuation: d.valuation || '', exit_plan: d.exit_plan || '' };
        setFields(vals);
        lastSavedRef.current = JSON.stringify(vals);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [code]);

  const save = useCallback(async (data) => {
    const payload = JSON.stringify(data);
    if (payload === lastSavedRef.current) return;
    setSaveState('saving');
    try {
      const r = await fetch('/api/thesis', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ code, name, ...data }),
      });
      if (!r.ok) throw new Error(await r.text());
      lastSavedRef.current = payload;
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }, [code, name]);

  const scheduleAutoSave = useCallback((data) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(data), AUTO_SAVE_MS);
  }, [save]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleChange = (key, value) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    scheduleAutoSave(next);
  };

  const handleManualSave = () => {
    clearTimeout(timerRef.current);
    save(fields);
  };

  if (!loaded) return (
    <div className="px-4 pt-4 space-y-3">
      {[1,2,3,4].map(i => <div key={i} className="h-24 bg-surface-800 rounded-xl animate-pulse" />)}
    </div>
  );

  return (
    <div className="px-4 pt-4 pb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">투자 Thesis</h3>
        <div className="flex items-center gap-2">
          {saveState === 'saving' && <span className="text-[10px] text-slate-500">저장 중...</span>}
          {saveState === 'saved' && <span className="text-[10px] text-profit">저장됨</span>}
          {saveState === 'error' && <span className="text-[10px] text-loss">저장 실패</span>}
          <button
            onClick={handleManualSave}
            disabled={saveState === 'saving'}
            className="px-3 py-1 text-[11px] bg-brand-500/20 text-brand-400 rounded-lg disabled:opacity-40"
          >
            저장
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {QUESTIONS.map(({ key, label, hint, placeholder }) => (
          <div key={key} className="bg-surface-900 rounded-xl px-4 py-3">
            <label className="text-xs font-semibold text-slate-300 block mb-0.5">{label}</label>
            <p className="text-[10px] text-slate-600 mb-2">{hint}</p>
            <textarea
              value={fields[key]}
              onChange={e => handleChange(key, e.target.value)}
              placeholder={placeholder}
              rows={3}
              className="w-full bg-transparent text-sm text-slate-200 placeholder-slate-700 outline-none resize-none leading-relaxed"
            />
          </div>
        ))}
      </div>

      <p className="text-[10px] text-slate-700 text-center mt-3">30초마다 자동저장</p>
    </div>
  );
}
