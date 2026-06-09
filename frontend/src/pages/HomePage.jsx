import MarketIndexBar from '../components/home/MarketIndexBar';
import MarketPhaseBanner from '../components/home/MarketPhaseBanner';
import MarketAIComment from '../components/home/MarketAIComment';
import TodayTodo from '../components/home/TodayTodo';
import NewsFeed from '../components/home/NewsFeed';
import AlertsCard from '../components/home/AlertsCard';
import { useAuth } from '../contexts/AuthContext';

export default function HomePage() {
  const { user } = useAuth();

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? '좋은 아침입니다' : hour < 18 ? '좋은 오후입니다' : '좋은 저녁입니다';

  return (
    <div className="flex-1 overflow-y-auto pb-20 scrollbar-hide">
      {/* 헤더 */}
      <div className="px-4 pt-5 pb-4">
        <p className="text-xs text-slate-500">{greeting}</p>
        <h1 className="text-xl font-bold text-white mt-0.5">KT Trading</h1>
      </div>

      {/* 시장 지수 가로 스크롤 */}
      <MarketIndexBar />

      {/* 시장 국면 배너 */}
      <div className="mt-4">
        <MarketPhaseBanner />
      </div>

      {/* 투자 철학 4문 빠른 링크 */}
      <div className="px-4 mt-4 grid grid-cols-2 gap-2">
        {[
          { q: '이야기가 되는가?',  sub: '사업 이해',  path: '/stock' },
          { q: '숫자가 받쳐주나?',  sub: '재무 검증', path: '/stock' },
          { q: '지금 가격이 싼가?', sub: '밸류에이션', path: '/stock' },
          { q: '언제 팔 건가?',     sub: '매도 기준', path: '/decision' },
        ].map((item, i) => (
          <a
            key={i}
            href={item.path}
            className="bg-surface-900 rounded-xl p-3 block hover:bg-slate-800 transition-colors"
          >
            <p className="text-[11px] text-slate-500 mb-0.5">{item.sub}</p>
            <p className="text-sm font-medium text-slate-200 leading-snug">{item.q}</p>
          </a>
        ))}
      </div>

      {/* 오늘 확인할 종목 (체크리스트) */}
      <TodayTodo />

      {/* 이상 신호 알림 */}
      <AlertsCard />

      {/* 시장 AI 코멘트 */}
      <MarketAIComment />

      {/* 뉴스 피드 */}
      <div className="mt-5">
        <NewsFeed />
      </div>

      <div className="h-4" />
    </div>
  );
}
