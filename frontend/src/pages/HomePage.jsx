import { useNavigate } from 'react-router-dom';
import MarketIndexBar from '../components/home/MarketIndexBar';
import MarketPhaseBanner from '../components/home/MarketPhaseBanner';
import MarketAIComment from '../components/home/MarketAIComment';
import MorningBrief from '../components/home/MorningBrief';
import TopPicks from '../components/home/TopPicks';
import TodayTodo from '../components/home/TodayTodo';
import NewsFeed from '../components/home/NewsFeed';
import AlertsCard from '../components/home/AlertsCard';
import PortfolioSummaryBar from '../components/home/PortfolioSummaryBar';
import { useAuth } from '../contexts/AuthContext';

const PHILOSOPHY = [
  { q: '이야기가 되는가?',  sub: '사업 이해',  path: '/discover' },
  { q: '숫자가 받쳐주나?',  sub: '재무 검증',  path: '/discover' },
  { q: '지금 가격이 싼가?', sub: '밸류에이션', path: '/discover' },
  { q: '언제 팔 건가?',     sub: '매도 기준',  path: '/tools?tool=sell' },
];

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const now  = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? '좋은 아침입니다' : hour < 18 ? '좋은 오후입니다' : '좋은 저녁입니다';
  const dateStr = now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });

  return (
    <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
      {/* 헤더 */}
      <div className="px-4 pt-5 pb-2 flex items-start justify-between">
        <div>
          <p className="text-[11px] text-slate-500">{greeting} · {dateStr}</p>
          <h1 className="text-xl font-bold text-white mt-0.5">KT Trading</h1>
        </div>
        <button
          onClick={() => navigate('/discover')}
          className="mt-1 bg-surface-900 p-2 rounded-xl text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
        </button>
      </div>

      {/* 포트폴리오 요약 */}
      <PortfolioSummaryBar />

      {/* 시장 지수 가로 스크롤 */}
      <div className="mt-3">
        <MarketIndexBar />
      </div>

      {/* 오늘의 추천 — 한국·섹터·미국 (A+B+C) */}
      <TopPicks />

      {/* AI 아침 브리핑 (개장 전, 매 영업일 08:00 생성) */}
      <MorningBrief />

      {/* 시장 국면 배너 */}
      <div className="mt-3">
        <MarketPhaseBanner />
      </div>

      {/* 투자 철학 4문 빠른 링크 */}
      <div className="px-4 mt-3">
        <p className="text-[10px] text-slate-600 font-semibold uppercase tracking-wider mb-2">피터 린치 4문</p>
        <div className="grid grid-cols-2 gap-2">
          {PHILOSOPHY.map((item, i) => (
            <button
              key={i}
              onClick={() => navigate(item.path)}
              className="bg-surface-900 rounded-xl p-3 text-left hover:bg-slate-800 active:scale-[0.98] transition-all"
            >
              <p className="text-[10px] text-slate-500 mb-0.5">{item.sub}</p>
              <p className="text-sm font-medium text-slate-200 leading-snug">{item.q}</p>
            </button>
          ))}
        </div>
      </div>

      {/* 오늘 확인할 종목 (알림 체크리스트) */}
      <TodayTodo />

      {/* 이상 신호 알림 */}
      <AlertsCard />

      {/* 시장 AI 코멘트 */}
      <MarketAIComment />

      {/* 시장 뉴스 */}
      <div className="mt-5">
        <NewsFeed />
      </div>

      <div className="h-4" />
    </div>
  );
}
