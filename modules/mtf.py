"""
멀티타임프레임(MTF) 통합 분석 모듈
─────────────────────────────────────────
철학: 상위 시간대가 방향을 결정하고, 하위 시간대는 타이밍만 잡는다
  월봉 → 대세 방향 확인  (로봇이 못하는 '장기 통찰' 구간)
  주봉 → 5주선 진입 타이밍
  일봉 → 정밀 매수 시점

정배열 우선순위:
  월봉 정배열 + 주봉 5주선 안착 + 일봉 골든크로스 = 최적 진입
"""
from datetime import datetime, timedelta
from .indicators import ma, check_alignment


def _date(days=0):
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


def get_monthly_ohlcv(code: str, months: int = 24) -> list:
    """
    월봉 OHLCV 수집
    pykrx 1.2.8: freq='m' (소문자) = 월봉, 안되면 일봉→pandas 리샘플링
    """
    try:
        import pandas as pd
        from pykrx import stock as krx
        start = _date(months * 31 + 30)

        # 1차: pykrx freq='m'
        try:
            df = krx.get_market_ohlcv(start, _date(), code, freq='m')
        except Exception:
            df = None

        # 2차: 일봉 조회 후 pandas 월봉 리샘플링
        if df is None or df.empty:
            df = krx.get_market_ohlcv(start, _date(), code, freq='d')
            if df is None or df.empty:
                return []
            col_map = {
                '시가': 'open', '고가': 'high', '저가': 'low', '종가': 'close', '거래량': 'volume',
                'Open': 'open', 'High': 'high', 'Low': 'low', 'Close': 'close', 'Volume': 'volume',
            }
            df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})
            df.index = pd.to_datetime(df.index)
            agg = {k: v for k, v in {
                'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum',
            }.items() if k in df.columns}
            df = df.resample('ME').agg(agg).dropna(subset=['close'])

        result = []
        col_map2 = {'종가': 'close', '시가': 'open', '고가': 'high', '저가': 'low', '거래량': 'volume'}
        for date_idx, row in df.iterrows():
            cl_raw = row.get('close', row.get('종가', 0))
            cl = int(cl_raw) if cl_raw else 0
            if cl > 0:
                result.append({
                    'date': date_idx.strftime('%Y%m%d') if hasattr(date_idx, 'strftime') else str(date_idx)[:8],
                    'o': int(row.get('open', row.get('시가', cl)) or cl),
                    'h': int(row.get('high', row.get('고가', cl)) or cl),
                    'l': int(row.get('low',  row.get('저가', cl)) or cl),
                    'c': cl,
                    'v': int(row.get('volume', row.get('거래량', 0)) or 0),
                })
        return result
    except Exception as e:
        print(f'[mtf monthly] {code} 오류: {e}')
        return []


def monthly_trend(candles: list) -> tuple[str, int]:
    """
    월봉 추세 판단 (3개월 기준)
    반환: (추세문자열, 점수)
    """
    if len(candles) < 3:
        return 'unknown', 10
    c = [x['c'] for x in candles[-3:]]
    if c[2] > c[1] > c[0]:
        return 'strong_up', 20
    elif c[2] > c[0]:
        return 'up', 15
    elif c[2] < c[1] < c[0]:
        return 'strong_down', 0
    else:
        return 'down', 5


def _monthly_alignment(candles: list) -> dict:
    """월봉 이평선 정배열 여부 (5개월선, 10개월선, 20개월선)"""
    if len(candles) < 20:
        return {'type': 'unknown', 'score': 0}
    closes = [c['c'] for c in candles]
    ma5m  = ma(closes, 5)
    ma10m = ma(closes, 10)
    ma20m = ma(closes, 20)
    price = closes[-1]
    return check_alignment(price, {
        'ma5w':  ma5m[-1]  if ma5m  else None,
        'ma13w': ma10m[-1] if ma10m else None,
        'ma40w': ma20m[-1] if ma20m else None,
    })


def analyze_mtf(code: str, daily_data: dict = None, weekly_result: dict = None) -> dict:
    """
    3중 시간대 통합 분석

    월봉: 대세 방향 + 정배열 여부
    주봉: 5주선 신호 (매수/익절 허들)
    일봉: RSI, MACD, 20일선 정밀 타이밍
    """
    # ── 월봉 ──
    monthly = get_monthly_ohlcv(code, months=24)
    m_trend, m_score = monthly_trend(monthly)
    m_alignment      = _monthly_alignment(monthly)

    trend_kr = {
        'strong_up':   '강한 상승 (3개월 연속 우상향)',
        'up':          '상승 추세',
        'down':        '하락 추세',
        'strong_down': '강한 하락 (3개월 연속 하락)',
        'unknown':     '데이터 부족',
    }.get(m_trend, m_trend)

    # ── 주봉 ──
    from .weekly import analyze_weekly
    w   = weekly_result or analyze_weekly(code)
    sig = w.get('signal', '관망')
    w_score = {
        '매수신호': 35, '안착확인': 30, '진입대기': 15,
        '익절경고': 5,  '관망':     0,  '데이터부족': 10,
    }.get(sig, 10)

    # ── 일봉 ──
    d_score, d_detail = 0, []
    if daily_data:
        price    = daily_data.get('currentPrice', 0)
        rsi_val  = daily_data.get('rsi')
        macd_d   = daily_data.get('macd') or {}
        ma20     = daily_data.get('ma20', 0)
        ma60     = daily_data.get('ma60', 0)
        ma120    = daily_data.get('ma120', 0)   # 경기선 (신규)
        ma200    = daily_data.get('ma200', 0)   # 연간선 (신규)

        if rsi_val and 45 <= rsi_val <= 65:
            d_score += 10; d_detail.append(f'RSI {rsi_val} — 적정 구간')
        if macd_d.get('lastCross') == 'golden':
            d_score += 10; d_detail.append('MACD 골든크로스')
        if price and ma20 and price > ma20:
            d_score += 5; d_detail.append('20일선(심리선) 위')
        if price and ma60 and price > ma60:
            d_score += 5; d_detail.append('60일선(수급선) 위')

        # 일봉 정배열 체크
        daily_align = check_alignment(price, {
            'ma5': daily_data.get('ma5', 0),
            'ma20': ma20, 'ma60': ma60,
            'ma120': ma120, 'ma200': ma200,
        })
        if daily_align['type'] in ('완전정배열', '정배열'):
            d_score += 5; d_detail.append(f'일봉 {daily_align["type"]}')

    total = m_score + w_score + d_score

    # ── 종합 판단 ──
    if m_trend in ('strong_up', 'up') and sig in ('매수신호', '안착확인'):
        overall = '최적매수'
        reason  = f'월봉 {trend_kr} + 주봉 {sig} — 3중 시간대 일치, 최우선 진입 구간'
    elif m_trend in ('strong_up', 'up') and sig == '진입대기':
        overall = '매수준비'
        reason  = f'월봉 상승 + 주봉 5주선 위 — 다음주 안착 확인 후 진입'
    elif sig == '익절경고':
        overall = '익절검토'
        reason  = '주봉 5주선 이탈 — 보유 시 즉시 비중 축소'
    elif m_trend in ('down', 'strong_down'):
        overall = '진입위험'
        reason  = f'월봉 {trend_kr} — 역추세 진입 금지 (로봇이 판단 못하는 구간도 하락 중)'
    else:
        overall = '관망'
        reason  = '조건 미충족 — 주봉 5주선 돌파 신호 대기'

    return {
        'monthly': {
            'trend':     m_trend,
            'trend_kr':  trend_kr,
            'score':     m_score,
            'alignment': m_alignment,
            'candles':   monthly[-6:],
        },
        'weekly': {
            'signal':   sig,
            'score':    w_score,
            'above5w':  w.get('position', {}).get('above5w'),
            'above40w': w.get('position', {}).get('above40w'),
            'alignment': w.get('alignment', {}),
        },
        'daily': {
            'score':  d_score,
            'detail': d_detail,
        },
        'totalScore': total,
        'overall':    overall,
        'reason':     reason,
    }
