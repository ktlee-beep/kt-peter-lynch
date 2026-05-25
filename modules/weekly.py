"""
주봉 분석 모듈
─────────────────────────────────────────
철학: 차트는 '예측' 도구가 아닌 회사의 '과거 일기'
      → 주봉으로 큰 흐름을 읽고, 일봉으로 타이밍만 잡는다

MA 체계 (주봉 기준):
   5주선 = 20일선 (심리선)  ★ 매수허들 / 익절기준
  13주선 = 60일선 (수급선)  분기 추세
  26주선 = 120일선 (경기선) 반기 추세
  40주선 = 200일선           ★ 연간 장기 대세

정배열: 현재가 > 5주선 > 13주선 > 26주선 > 40주선  (최선호)
역배열: 반대 배열                                   (매수 금지)
"""
from datetime import datetime, timedelta
from .indicators import ma, check_alignment


def _date(days=0):
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


def get_weekly_ohlcv(code: str, weeks: int = 60) -> list:
    """
    주봉 OHLCV 데이터 수집
    pykrx 1.2.8은 freq='d'/'m'/'y'만 지원 → 일봉 조회 후 pandas 주봉 리샘플링
    """
    try:
        import pandas as pd
        from pykrx import stock as krx
        # 주봉 weeks개 → 일봉으로 충분한 기간 조회 (+버퍼 30일)
        start = _date(weeks * 7 + 30)
        df    = krx.get_market_ohlcv(start, _date(), code, freq='d')
        if df is None or df.empty:
            return []

        # pykrx 컬럼명 정규화
        col_map = {
            '시가': 'open', '고가': 'high', '저가': 'low', '종가': 'close', '거래량': 'volume',
            'Open': 'open', 'High': 'high', 'Low': 'low', 'Close': 'close', 'Volume': 'volume',
        }
        df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})
        df.index = pd.to_datetime(df.index)

        # 주봉 리샘플링 (W-FRI: 금요일 기준 주봉)
        agg = {
            'open':   'first',
            'high':   'max',
            'low':    'min',
            'close':  'last',
            'volume': 'sum',
        }
        avail = {k: v for k, v in agg.items() if k in df.columns}
        weekly = df.resample('W-FRI').agg(avail).dropna(subset=['close'])

        result = []
        for date_idx, row in weekly.iterrows():
            cl = int(row.get('close', 0))
            if cl > 0:
                result.append({
                    'date': date_idx.strftime('%Y%m%d'),
                    'o': int(row.get('open', cl)),
                    'h': int(row.get('high', cl)),
                    'l': int(row.get('low', cl)),
                    'c': cl,
                    'v': int(row.get('volume', 0)),
                })
        return result
    except Exception as e:
        print(f'[weekly] {code} 오류: {e}')
        return []


def _weeks_above_ma5(closes: list, ma5_arr: list) -> int:
    """현재 5주선 위에 몇 주 연속 안착 중인지 계산"""
    offset = len(closes) - len(ma5_arr)
    count  = 0
    for i in range(len(ma5_arr) - 1, -1, -1):
        if closes[offset + i] > ma5_arr[i]:
            count += 1
        else:
            break
    return count


def analyze_weekly(code: str) -> dict:
    """
    주봉 전체 MA 분석 + 오박사 매매 룰

    신호 종류:
      매수신호  — 5주선 상향 돌파 (이번주)
      안착확인  — 5주선 위 2주+ 연속 유지
      진입대기  — 5주선 위 1주차 (안착 확인 필요)
      익절경고  — 5주선 하향 이탈 (즉시 비중 축소)
      관망      — 5주선 아래 (매수 금지)
    """
    candles = get_weekly_ohlcv(code, weeks=55)  # 최소 40주선 계산을 위해 55주 이상
    if len(candles) < 6:
        return {'error': '주봉 데이터 부족'}

    closes  = [c['c'] for c in candles]
    vols    = [c['v'] for c in candles]
    current = closes[-1]

    # ── MA 계산 ──
    ma5w  = ma(closes, 5)
    ma13w = ma(closes, 13)
    ma26w = ma(closes, 26)
    ma40w = ma(closes, 40)

    def last2(arr):
        now  = round(arr[-1]) if arr else None
        prev = round(arr[-2]) if len(arr) >= 2 else None
        return now, prev

    ma5_now,  ma5_prev  = last2(ma5w)
    ma13_now, _         = last2(ma13w)
    ma26_now, _         = last2(ma26w)
    ma40_now, _         = last2(ma40w)

    # ── 오박사 룰: 5주선 기준 신호 ──
    signal        = '데이터부족'
    signal_detail = ''

    if ma5_now and len(closes) >= 2:
        above_now  = current   > ma5_now
        above_prev = closes[-2] > ma5_prev if ma5_prev else None

        if above_now and above_prev is False:
            signal        = '매수신호'
            signal_detail = '5주선 상향 돌파 — 이번주 진입 검토 (오박사 Rule 1)'
        elif above_now and above_prev is True:
            wk = _weeks_above_ma5(closes, ma5w)
            if wk >= 2:
                signal        = '안착확인'
                signal_detail = f'5주선 위 {wk}주 연속 — 추세 유지 중 (보유 유지)'
            else:
                signal        = '진입대기'
                signal_detail = '5주선 위 1주차 — 다음주 안착 확인 후 진입'
        elif not above_now and above_prev is True:
            signal        = '익절경고'
            signal_detail = '5주선 하향 이탈 — 즉시 비중 축소 또는 차익실현 (오박사 Rule 2)'
        else:
            signal        = '관망'
            signal_detail = '5주선 아래 — 매수 금지 구간 (역배열 가능성 확인 필요)'

    # ── 위치 맵 ──
    position = {
        'above5w':  current > ma5_now  if ma5_now  else None,
        'above13w': current > ma13_now if ma13_now else None,
        'above26w': current > ma26_now if ma26_now else None,
        'above40w': current > ma40_now if ma40_now else None,
    }

    # ── 정배열 / 역배열 ──
    alignment = check_alignment(current, {
        'ma5w':  ma5_now, 'ma13w': ma13_now,
        'ma26w': ma26_now, 'ma40w': ma40_now,
    })

    # ── 장기 추세 (40주선 기준) ──
    long_trend = '장기상승' if (ma40_now and current > ma40_now) else '장기하락'

    # ── 거래량 추이 ──
    v5  = sum(vols[-5:])  / 5  if len(vols) >= 5  else 0
    v10 = sum(vols[-10:-5]) / 5 if len(vols) >= 10 else v5
    vol_trend = ('증가' if v10 and v5 > v10 * 1.1 else
                 '감소' if v10 and v5 < v10 * 0.9 else '보합')

    return {
        'currentPrice':   current,
        'signal':         signal,
        'signal_detail':  signal_detail,
        'position':       position,
        'alignment':      alignment,          # 정배열/역배열
        'long_trend':     long_trend,
        'vol_trend':      vol_trend,
        # MA 현재값
        'ma5w':   ma5_now,
        'ma13w':  ma13_now,
        'ma26w':  ma26_now,
        'ma40w':  ma40_now,
        # MA 배열 (최근 20봉, 차트 렌더링용)
        'ma5w_arr':  [round(v) for v in ma5w[-20:]]  if ma5w  else [],
        'ma13w_arr': [round(v) for v in ma13w[-20:]] if ma13w else [],
        'ma26w_arr': [round(v) for v in ma26w[-20:]] if ma26w else [],
        'ma40w_arr': [round(v) for v in ma40w[-20:]] if ma40w else [],
        'candles':   candles[-20:],
        # 설명 테이블
        'ma_table': {
            '5w':  {'name': '5주선',  'daily': '20일선(심리선)',  'role': '매수허들/익절기준 ★'},
            '13w': {'name': '13주선', 'daily': '60일선(수급선)',  'role': '분기 추세'},
            '26w': {'name': '26주선', 'daily': '120일선(경기선)', 'role': '반기 추세'},
            '40w': {'name': '40주선', 'daily': '200일선',         'role': '연간 장기 대세 ★'},
        },
    }
