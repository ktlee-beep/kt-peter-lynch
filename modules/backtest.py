"""
주봉 5주선 전략 백테스트 모듈
─────────────────────────────────────────
철학: 차트는 '과거 일기' → 백테스트는 그 일기로 룰이 통했는지 검증

전략:
  매수: 주봉 종가가 5주선 상향 돌파
  매도: 주봉 종가가 5주선 하향 이탈

출력:
  total_return     복리 총 수익률(%)
  win_rate         승률(%)
  profit_factor    총이익 / 총손실
  avg_holding      평균 보유기간(주)
  mdd              최대 낙폭(%)
  sharpe           샤프 비율(연환산, 무위험수익률 3.5%)
  trades           거래 내역
  open_position    현재 미청산 포지션 (있을 경우)
"""
import math
from datetime import datetime, timedelta
from .indicators import ma


def _date(days=0):
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


def _calc_mdd(equity: list) -> float:
    """최대 낙폭(MDD) 계산"""
    peak = equity[0]
    mdd  = 0.0
    for e in equity:
        if e > peak:
            peak = e
        dd = (peak - e) / peak * 100
        if dd > mdd:
            mdd = dd
    return round(mdd, 2)


def _calc_sharpe(returns_pct: list, rf_annual: float = 3.5) -> float | None:
    """샤프 비율 (연환산, 주봉 기준 52주)"""
    if len(returns_pct) < 2:
        return None
    avg = sum(returns_pct) / len(returns_pct)
    std = math.sqrt(sum((r - avg) ** 2 for r in returns_pct) / len(returns_pct))
    if std == 0:
        return None
    rf_weekly = rf_annual / 52
    sharpe    = (avg - rf_weekly) / std * math.sqrt(52)
    return round(sharpe, 2)


def backtest_5w(code: str, years: int = 5) -> dict:
    """
    주봉 5주선 전략 백테스트

    Args:
        code  : 종목 코드 (예: '005930')
        years : 백테스트 기간 (기본 5년)

    Returns:
        dict  : 성과 지표 + 거래 내역
    """
    try:
        import pandas as pd
        from pykrx import stock as krx

        start = _date(years * 365 + 90)
        # pykrx 1.2.8: freq='d'로 일봉 조회 후 pandas 주봉 리샘플링
        df_daily = krx.get_market_ohlcv(start, _date(), code, freq='d')

        if df_daily is None or df_daily.empty:
            return {'error': '주봉 데이터 없음'}

        # 컬럼 정규화
        col_map = {'종가': 'close', '시가': 'open', '고가': 'high', '저가': 'low', '거래량': 'volume'}
        df_daily = df_daily.rename(columns={k: v for k, v in col_map.items() if k in df_daily.columns})
        df_daily.index = pd.to_datetime(df_daily.index)

        # 주봉 리샘플링 (금요일 기준)
        agg = {k: v for k, v in {'close': 'last', 'open': 'first', 'high': 'max', 'low': 'min', 'volume': 'sum'}.items()
               if k in df_daily.columns}
        df = df_daily.resample('W-FRI').agg(agg).dropna(subset=['close'])

        candles = []
        for date_idx, row in df.iterrows():
            cl = int(row.get('close', 0))
            if cl > 0:
                candles.append({
                    'date': date_idx.strftime('%Y%m%d'),
                    'c':   cl,
                })

        if len(candles) < 10:
            return {'error': '데이터 부족 (최소 10주 필요)'}

        closes = [c['c']    for c in candles]
        dates  = [c['date'] for c in candles]
        ma5    = ma(closes, 5)
        offset = len(closes) - len(ma5)   # 처음 4봉은 MA5 계산 불가

        trades   = []
        position = None   # {'buy_price', 'buy_date', 'buy_idx'}

        for i in range(1, len(ma5)):
            ai = i + offset        # closes[] 실제 인덱스

            price_now  = closes[ai]
            price_prev = closes[ai - 1]
            ma_now     = ma5[i]
            ma_prev    = ma5[i - 1]

            # ── 매수 신호: 5주선 상향 돌파 ──
            if position is None and price_prev <= ma_prev and price_now > ma_now:
                position = {
                    'buy_price': price_now,
                    'buy_date':  dates[ai],
                    'buy_idx':   ai,
                }

            # ── 매도 신호: 5주선 하향 이탈 ──
            elif position is not None and price_prev >= ma_prev and price_now < ma_now:
                ret = (price_now - position['buy_price']) / position['buy_price'] * 100
                trades.append({
                    'buy_date':      position['buy_date'],
                    'sell_date':     dates[ai],
                    'buy_price':     position['buy_price'],
                    'sell_price':    price_now,
                    'return_pct':    round(ret, 2),
                    'holding_weeks': ai - position['buy_idx'],
                    'result':        'win' if ret > 0 else 'loss',
                })
                position = None

        # ── 미청산 포지션 ──
        open_pos = None
        if position is not None:
            ret = (closes[-1] - position['buy_price']) / position['buy_price'] * 100
            open_pos = {
                'buy_date':         position['buy_date'],
                'buy_price':        position['buy_price'],
                'current_price':    closes[-1],
                'unrealized_return': round(ret, 2),
                'holding_weeks':    len(closes) - 1 - position['buy_idx'],
                'current_ma5w':     round(ma5[-1]) if ma5 else None,
                'still_above_ma5w': closes[-1] > ma5[-1] if ma5 else None,
            }

        if not trades:
            return {
                'error':         '해당 기간 거래 없음 (신호 미발생)',
                'open_position': open_pos,
                'total_weeks':   len(candles),
            }

        returns = [t['return_pct'] for t in trades]
        wins    = [r for r in returns if r > 0]
        losses  = [r for r in returns if r <= 0]

        # ── 복리 수익률 + 자본곡선 ──
        compound = 1.0
        equity   = [1.0]
        for r in returns:
            compound *= (1 + r / 100)
            equity.append(equity[-1] * (1 + r / 100))

        total_return = round((compound - 1) * 100, 2)

        # ── Buy & Hold 수익률 (비교용) ──
        first_buy = next((t['buy_price'] for t in trades), closes[offset])
        buy_hold  = round((closes[-1] - first_buy) / first_buy * 100, 2)

        return {
            'code':             code,
            'period_years':     years,
            'total_weeks':      len(candles),
            'total_trades':     len(trades),
            'win_trades':       len(wins),
            'loss_trades':      len(losses),
            'win_rate':         round(len(wins) / len(trades) * 100, 1),
            'total_return':     total_return,
            'buy_hold_return':  buy_hold,
            'alpha':            round(total_return - buy_hold, 2),
            'avg_win':          round(sum(wins)   / len(wins),   2) if wins   else 0,
            'avg_loss':         round(sum(losses) / len(losses), 2) if losses else 0,
            'profit_factor':    round(abs(sum(wins) / sum(losses)), 2)
                                if losses and sum(losses) != 0 else None,
            'avg_holding_weeks': round(sum(t['holding_weeks'] for t in trades) / len(trades), 1),
            'mdd':              _calc_mdd(equity),
            'sharpe':           _calc_sharpe(returns),
            'equity_curve':     [round(e, 4) for e in equity],
            'trades':           trades[-20:],   # 최근 20건
            'open_position':    open_pos,
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {'error': str(e)}
