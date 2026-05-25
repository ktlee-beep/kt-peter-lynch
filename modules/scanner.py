"""
전종목 자동 스캐너 모듈
─────────────────────────────────────────
백그라운드 스레드로 KOSPI/KOSDAQ 전종목을 순회하며
주봉 5주선 + 정배열 + 종합 스코어 조건을 충족하는 종목을 선별

Quick 모드 (기본):
  주봉 신호 미충족 시 즉시 스킵 → 속도 3~5배 향상
  (매수신호/안착확인/진입대기 종목만 정밀 분석)
"""
import threading
from datetime import datetime, timedelta


_state = {
    'running':     False,
    'progress':    0,
    'total':       0,
    'current':     '',
    'results':     [],
    'started_at':  None,
    'finished_at': None,
    'error':       None,
    # 디버그 카운터
    'dbg_step1_pass': 0,   # 주봉 퀵 필터 통과
    'dbg_step2_ok':   0,   # 일봉 데이터 정상 로드
    'dbg_low_score':  0,   # 점수 부족(min_score 미달)
    'dbg_errors':     0,   # 예외 발생
}
_lock = threading.Lock()


def _date(days=0):
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


def _get_all_codes(markets: list) -> list:
    """
    KOSPI/KOSDAQ 전종목 코드+이름 목록 반환
    1차: FinanceDataReader (가장 안정적)
    2차: pykrx (폴백)
    반환: [(code, name, market), ...]
    """
    # 1차: FinanceDataReader
    try:
        import FinanceDataReader as fdr
        df = fdr.StockListing('KRX')
        if df is not None and not df.empty:
            result = []
            mkt_upper = [m.upper() for m in markets]
            for _, row in df.iterrows():
                mkt = str(row.get('Market', '')).upper()
                if mkt in mkt_upper:
                    code = str(row.get('Code', '')).zfill(6)
                    name = str(row.get('Name', ''))
                    result.append((code, name, mkt))
            if result:
                return result
    except Exception as e:
        print(f'[scanner] FDR 실패: {e}')

    # 2차: pykrx 폴백
    try:
        from pykrx import stock as krx
        result = []
        for mkt in markets:
            for days_back in range(7):
                d = _date(days_back)
                try:
                    codes = krx.get_market_ticker_list(d, market=mkt)
                    if codes:
                        for code in codes:
                            try:
                                name = krx.get_market_ticker_name(code)
                            except Exception:
                                name = code
                            result.append((code, name, mkt))
                        break
                except Exception:
                    continue
        if result:
            return result
    except Exception as e:
        print(f'[scanner] pykrx 폴백 실패: {e}')

    return []


def _scan_worker(min_score: int, markets: list, quick: bool):
    from pykrx import stock as krx
    from .indicators import ma, rsi as rsi_fn
    from .weekly import analyze_weekly

    all_codes = _get_all_codes(markets)

    if not all_codes:
        with _lock:
            _state['error']   = '종목 목록 조회 실패 (FinanceDataReader/pykrx 모두 실패)'
            _state['running'] = False
        return

    today = _date()   # 오늘 날짜 (주말이면 pykrx가 자동으로 직전 거래일 데이터 반환)

    with _lock:
        _state['total'] = len(all_codes)
        _state['dbg_step1_pass'] = 0
        _state['dbg_step2_ok']   = 0
        _state['dbg_low_score']  = 0
        _state['dbg_errors']     = 0

    results = []

    for i, (code, name, mkt) in enumerate(all_codes):
        with _lock:
            if not _state['running']:
                break
            _state['progress'] = i + 1
            _state['current']  = f'{name}({code})'

        try:
            # ── Step 1: 주봉 신호 (핵심 허들) ──
            w   = analyze_weekly(code)
            sig = w.get('signal', '관망')
            pos = w.get('position', {})
            aln = w.get('alignment', {})

            # Quick 모드: 주봉 신호 없으면 스킵
            if quick and sig not in ('매수신호', '안착확인', '진입대기'):
                continue

            with _lock:
                _state['dbg_step1_pass'] += 1

            # ── Step 2: 일봉 데이터로 정밀 스코어 계산 ──
            df = krx.get_market_ohlcv(_date(200), today, code)
            if df is None or df.empty:
                continue

            # pykrx 컬럼 정규화 (한글 또는 영문)
            col_close = '종가' if '종가' in df.columns else 'Close'
            col_vol   = '거래량' if '거래량' in df.columns else 'Volume'

            closes = [int(v) for v in df[col_close].dropna() if float(v) > 0]
            vols   = [int(v) for v in df[col_vol].fillna(0)]
            if len(closes) < 20:
                continue

            with _lock:
                _state['dbg_step2_ok'] += 1

            price = closes[-1]

            # 스코어 계산
            score = 0

            # 주봉 (35점)
            if pos.get('above5w'):  score += 15
            if sig == '매수신호':  score += 10
            if pos.get('above40w'): score += 10

            # 일봉 (30점)
            rsi_val  = rsi_fn(closes)
            ma20_arr = ma(closes, 20)
            if rsi_val and 45 <= rsi_val <= 65:          score += 10
            if ma20_arr and price > ma20_arr[-1]:         score += 10

            from .indicators import macd as macd_fn
            macd_d = macd_fn(closes)
            if macd_d and macd_d.get('lastCross') == 'golden': score += 10

            # 거래량 (15점)
            avg_vol   = sum(vols[-20:]) / 20 if len(vols) >= 20 else 1
            vol_ratio = vols[-1] / avg_vol if avg_vol else 1
            if vol_ratio >= 1.5:   score += 10
            elif vol_ratio >= 1.2: score += 5

            # 월봉 간이 (20점, 일봉 종가로 대체)
            if len(closes) >= 60:
                if closes[-1] > closes[-20] > closes[-60]: score += 20
                elif closes[-1] > closes[-20]:             score += 15

            if score >= min_score:
                # ── 손절가 / 목표가 계산 ──────────────────
                ma5w_val  = w.get('ma5w') or 0
                ma40w_val = w.get('ma40w') or 0
                stop_5w   = int((ma5w_val or price * 0.90) * 0.97)
                stop_8pct = int(price * 0.92)
                low_20d   = min([int(v) for v in df[col_vol].iloc[-20:].fillna(price)]) if len(df) >= 20 else stop_8pct
                # lows 가져오기
                col_low   = '저가' if '저가' in df.columns else 'Low'
                lows_20   = [int(v) for v in df[col_low].dropna().iloc[-20:] if float(v) > 0]
                low_20d   = min(lows_20) if lows_20 else stop_8pct
                stop_loss = max(stop_5w, stop_8pct, int(low_20d * 0.985))

                # 스코어별 목표가 배율
                if score >= 90:   upside = 0.22
                elif score >= 85: upside = 0.18
                elif score >= 80: upside = 0.14
                elif score >= 75: upside = 0.10
                elif score >= 65: upside = 0.08
                else:             upside = 0.06

                target_price  = int(price * (1 + upside))
                downside_p    = (price - stop_loss) / price if price > stop_loss else 0.05
                rr_ratio      = round(upside / downside_p, 1) if downside_p > 0 else 0

                if score >= 90:   rating = '매수'
                elif score >= 80: rating = '매수'
                elif score >= 65: rating = '적극매수'
                else:             rating = '중립'

                results.append({
                    'code':         code,
                    'name':         name,
                    'market':       mkt,
                    'price':        price,
                    'score':        score,
                    'signal':       sig,
                    'alignment':    aln.get('type', 'unknown'),
                    'above5w':      pos.get('above5w'),
                    'above40w':     pos.get('above40w'),
                    'ma5w':         ma5w_val,
                    'ma40w':        ma40w_val or None,
                    'rsi':          rsi_val,
                    'vol_ratio':    round(vol_ratio, 2),
                    'long_trend':   w.get('long_trend'),
                    # 신규 필드
                    'rating':       rating,
                    'target_price': target_price,
                    'stop_loss':    stop_loss,
                    'upside_pct':   round(upside * 100, 1),
                    'downside_pct': round(downside_p * 100, 1),
                    'rr_ratio':     rr_ratio,
                })
                # 실시간으로 _state에 저장 (정렬 후 Top 50 유지)
                with _lock:
                    _state['results'] = sorted(
                        results, key=lambda x: x['score'], reverse=True
                    )[:50]
            else:
                with _lock:
                    _state['dbg_low_score'] += 1

        except Exception:
            with _lock:
                _state['dbg_errors'] += 1
            continue

    results.sort(key=lambda x: x['score'], reverse=True)

    with _lock:
        _state['results']     = results[:50]   # Top 50
        _state['running']     = False
        _state['finished_at'] = datetime.now().isoformat()


# ── 공개 인터페이스 ─────────────────────────────────────────────

def start_scan(min_score: int = 65, markets: list = None, quick: bool = True) -> dict:
    """전종목 스캔 시작 (백그라운드)"""
    with _lock:
        if _state['running']:
            return {
                'status':   'already_running',
                'progress': _state['progress'],
                'total':    _state['total'],
            }

    markets = markets or ['KOSPI', 'KOSDAQ']
    with _lock:
        _state.update({
            'running':     True,
            'progress':    0,
            'total':       0,
            'current':     '',
            'results':     [],
            'started_at':  datetime.now().isoformat(),
            'finished_at': None,
            'error':       None,
        })

    threading.Thread(
        target=_scan_worker,
        args=(min_score, markets, quick),
        daemon=True,
    ).start()

    return {
        'status':    'started',
        'min_score': min_score,
        'markets':   markets,
        'quick_mode': quick,
    }


def scan_status() -> dict:
    with _lock:
        s = dict(_state)
    pct = round(s['progress'] / s['total'] * 100, 1) if s['total'] else 0
    return {
        'running':          s['running'],
        'progress':         s['progress'],
        'total':            s['total'],
        'percent':          pct,
        'current':          s['current'],
        'results_count':    len(s['results']),
        'started_at':       s['started_at'],
        'finished_at':      s['finished_at'],
        'error':            s['error'],
        'dbg_step1_pass':   s.get('dbg_step1_pass', 0),
        'dbg_step2_ok':     s.get('dbg_step2_ok', 0),
        'dbg_low_score':    s.get('dbg_low_score', 0),
        'dbg_errors':       s.get('dbg_errors', 0),
    }


def scan_results() -> dict:
    with _lock:
        return {
            'results':     list(_state['results']),
            'total_found': len(_state['results']),
            'finished_at': _state['finished_at'],
        }


def stop_scan() -> dict:
    with _lock:
        _state['running'] = False
    return {'status': 'stopped'}
