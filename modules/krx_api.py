"""
KRX Open API 연동 모듈
─────────────────────────────────────────
공식 KRX API (https://openapi.krx.co.kr) 우선 사용
→ 실패 시 pykrx 폴백

인증: AUTH_KEY 헤더 방식
환경변수: KRX_API_KEY (.env 파일)
"""
import os
import requests
from datetime import datetime, timedelta
from functools import lru_cache

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

KRX_KEY  = os.getenv('KRX_API_KEY', '')
DART_KEY = os.getenv('DART_API_KEY', '')
BASE_URL = 'https://openapi.krx.co.kr/svc/apis'

_SESSION = requests.Session()
_SESSION.headers.update({
    'AUTH_KEY':     KRX_KEY,
    'Content-Type': 'application/json; charset=utf-8',
    'Accept':       'application/json',
})


def _date(days=0) -> str:
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


def _krx_post(endpoint: str, params: dict) -> dict | None:
    """KRX API POST 요청 공통 함수 (공식 API는 POST+JSON Body 방식)"""
    if not KRX_KEY:
        return None
    try:
        url = f'{BASE_URL}/{endpoint}'
        r   = _SESSION.post(url, json=params, timeout=10)
        if r.status_code == 200:
            data = r.json()
            return data
        return None
    except Exception as e:
        print(f'[KRX API POST] {endpoint} 오류: {e}')
        return None


def _krx_get(endpoint: str, params: dict) -> dict | None:
    """KRX API 요청 공통 함수 (POST 우선, GET 폴백)"""
    if not KRX_KEY:
        return None
    # POST 시도
    result = _krx_post(endpoint, params)
    if result is not None:
        return result
    # GET 폴백
    try:
        url = f'{BASE_URL}/{endpoint}'
        r   = _SESSION.get(url, params=params, timeout=10)
        if r.status_code == 200:
            data = r.json()
            return data
        return None
    except Exception as e:
        print(f'[KRX API GET] {endpoint} 오류: {e}')
        return None


# ── 주식 일별 시세 ───────────────────────────────────────────
def get_daily_ohlcv_krx(code: str, start_date: str, end_date: str) -> list:
    """
    KRX Open API — 주식 일별 OHLCV 조회
    code: 종목코드 (6자리, 예: 005930)
    """
    data = _krx_get('sto/stk_bydd_trd', {
        'isuCd':   code,
        'strtDd':  start_date,
        'endDd':   end_date,
    })
    if not data:
        return []

    # 응답 구조 파싱 (KRX API 버전별 키 이름이 다를 수 있음)
    rows = (data.get('OutBlock_1')
            or data.get('output')
            or data.get('data')
            or [])

    result = []
    for row in rows:
        try:
            result.append({
                'date': str(row.get('TRD_DD', '') or row.get('basDd', '')).replace('-', ''),
                'o':    int(str(row.get('TDD_OPNPRC', 0) or 0).replace(',', '')),
                'h':    int(str(row.get('TDD_HGPRC',  0) or 0).replace(',', '')),
                'l':    int(str(row.get('TDD_LWPRC',  0) or 0).replace(',', '')),
                'c':    int(str(row.get('TDD_CLSPRC', 0) or 0).replace(',', '')),
                'v':    int(str(row.get('ACC_TRDVOL', 0) or 0).replace(',', '')),
            })
        except (ValueError, TypeError):
            continue

    return [r for r in result if r['c'] > 0]


def get_daily_ohlcv(code: str, start_date: str, end_date: str) -> list:
    """
    일별 OHLCV — KRX API 우선, 실패 시 pykrx 폴백
    """
    # 1차: KRX 공식 API
    result = get_daily_ohlcv_krx(code, start_date, end_date)
    if result:
        return result

    # 2차: pykrx 폴백
    try:
        from pykrx import stock as krx
        df = krx.get_market_ohlcv(start_date, end_date, code)
        if df is None or df.empty:
            return []
        out = []
        for di, row in df.iterrows():
            cl = int(row.get('종가', 0))
            if cl > 0:
                out.append({
                    'date': di.strftime('%Y%m%d') if hasattr(di, 'strftime') else str(di)[:8],
                    'o': int(row.get('시가', 0)), 'h': int(row.get('고가', 0)),
                    'l': int(row.get('저가', 0)), 'c': cl, 'v': int(row.get('거래량', 0)),
                })
        return out
    except Exception as e:
        print(f'[pykrx fallback] {code}: {e}')
        return []


# ── 주봉 / 월봉 ─────────────────────────────────────────────
def get_weekly_ohlcv(code: str, weeks: int = 60) -> list:
    """주봉 OHLCV — 일봉 조회 후 pandas 주봉(W-FRI) 리샘플링"""
    try:
        import pandas as pd
        from pykrx import stock as krx
        start = _date(weeks * 7 + 30)
        df    = krx.get_market_ohlcv(start, _date(), code, freq='d')
        if df is None or df.empty:
            return []
        col_map = {
            '시가': 'open', '고가': 'high', '저가': 'low', '종가': 'close', '거래량': 'volume',
        }
        df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})
        df.index = pd.to_datetime(df.index)
        agg = {k: v for k, v in {
            'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum',
        }.items() if k in df.columns}
        weekly = df.resample('W-FRI').agg(agg).dropna(subset=['close'])
        out = []
        for di, row in weekly.iterrows():
            cl = int(row.get('close', 0))
            if cl > 0:
                out.append({
                    'date': di.strftime('%Y%m%d'),
                    'o': int(row.get('open', cl)), 'h': int(row.get('high', cl)),
                    'l': int(row.get('low',  cl)), 'c': cl, 'v': int(row.get('volume', 0)),
                })
        return out
    except Exception as e:
        print(f'[weekly ohlcv] {code}: {e}')
        return []


def get_monthly_ohlcv(code: str, months: int = 24) -> list:
    """월봉 OHLCV — pykrx freq='m' 또는 일봉→pandas 월봉 리샘플링"""
    try:
        import pandas as pd
        from pykrx import stock as krx
        start = _date(months * 31 + 30)
        try:
            df = krx.get_market_ohlcv(start, _date(), code, freq='m')
        except Exception:
            df = None
        if df is None or df.empty:
            df = krx.get_market_ohlcv(start, _date(), code, freq='d')
            if df is None or df.empty:
                return []
            col_map = {
                '시가': 'open', '고가': 'high', '저가': 'low', '종가': 'close', '거래량': 'volume',
            }
            df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})
            df.index = pd.to_datetime(df.index)
            agg = {k: v for k, v in {
                'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum',
            }.items() if k in df.columns}
            df = df.resample('ME').agg(agg).dropna(subset=['close'])
        out = []
        for di, row in df.iterrows():
            cl_raw = row.get('close', row.get('종가', 0))
            cl = int(cl_raw) if cl_raw else 0
            if cl > 0:
                out.append({
                    'date': di.strftime('%Y%m%d') if hasattr(di, 'strftime') else str(di)[:8],
                    'o': int(row.get('open', row.get('시가', cl)) or cl),
                    'h': int(row.get('high', row.get('고가', cl)) or cl),
                    'l': int(row.get('low',  row.get('저가', cl)) or cl),
                    'c': cl,
                    'v': int(row.get('volume', row.get('거래량', 0)) or 0),
                })
        return out
    except Exception as e:
        print(f'[monthly ohlcv] {code}: {e}')
        return []


# ── 종목 기본 정보 ───────────────────────────────────────────
@lru_cache(maxsize=512)
def get_stock_info(code: str) -> dict:
    """종목명, 시장구분, ISIN 등 기본 정보"""
    data = _krx_get('sto/stk_isu_base_info', {'isuCd': code})
    if data:
        rows = data.get('OutBlock_1') or data.get('output') or []
        if rows:
            row = rows[0]
            return {
                'code':   code,
                'name':   row.get('ISU_ABBRV', ''),
                'market': row.get('MKT_TP_NM', ''),
                'isin':   row.get('ISU_CD', ''),
                'sector': row.get('IDX_IND_NM', ''),
            }
    # pykrx 폴백
    try:
        from pykrx import stock as krx
        return {'code': code, 'name': krx.get_market_ticker_name(code), 'market': '', 'isin': '', 'sector': ''}
    except:
        return {'code': code, 'name': '', 'market': '', 'isin': '', 'sector': ''}


# ── 시장 지수 ────────────────────────────────────────────────
def get_index(index_code: str = '1') -> dict:
    """
    KOSPI(1) / KOSDAQ(2) 지수 조회
    KRX API 우선, 폴백 pykrx
    """
    data = _krx_get('idx/idx_bydd_trd', {
        'idxIndMidclssCd': index_code,
        'strtDd': _date(5),
        'endDd':  _date(),
    })
    if data:
        rows = data.get('OutBlock_1') or data.get('output') or []
        if rows:
            row = rows[-1]
            return {
                'index_code': index_code,
                'close':  float(str(row.get('CLSPRC_IDX', 0) or 0).replace(',', '')),
                'change': float(str(row.get('FLUC_RT',    0) or 0).replace(',', '')),
                'date':   str(row.get('TRD_DD', '')).replace('-', ''),
            }
    # pykrx 폴백
    try:
        from pykrx import stock as krx
        idx_map = {'1': '1028', '2': '2001'}
        df = krx.get_index_ohlcv(_date(5), _date(), idx_map.get(index_code, '1028'))
        if df is not None and not df.empty:
            row  = df.iloc[-1]
            prev = df.iloc[-2] if len(df) >= 2 else row
            p    = float(prev.get('종가', 1))
            c    = float(row.get('종가', 0))
            return {'index_code': index_code, 'close': c, 'change': round((c-p)/p*100,2)}
    except:
        pass
    return {}


# ── DART 공시 ────────────────────────────────────────────────
def get_dart_disclosure(corp_code: str = None, stock_code: str = None, days: int = 30) -> list:
    """
    DART 전자공시 최신 공시 조회
    corp_code: DART 법인코드 (8자리) 또는 stock_code: 종목코드
    """
    if not DART_KEY:
        return []

    bgn_de = _date(days)
    params = {
        'crtfc_key': DART_KEY,
        'bgn_de':    bgn_de,
        'end_de':    _date(),
        'last_reprt_at': 'Y',
        'page_no':   '1',
        'page_count': '10',
    }
    if corp_code:
        params['corp_code'] = corp_code
    if stock_code:
        # 종목코드로 corp_code 변환 필요 (DART API는 법인코드 사용)
        params['stock_code'] = stock_code

    try:
        r = requests.get(
            'https://opendart.fss.or.kr/api/list.json',
            params=params,
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            if data.get('status') == '000':
                return data.get('list', [])
    except Exception as e:
        print(f'[DART] 공시 조회 오류: {e}')
    return []


def get_dart_corp_code(stock_code: str) -> str | None:
    """
    종목코드 → DART 법인코드 변환
    (DART API 공시 조회에 법인코드가 필요한 경우)
    """
    if not DART_KEY:
        return None
    try:
        # DART 기업 목록에서 검색 (ZIP 파일 방식이라 간소화)
        r = requests.get(
            'https://opendart.fss.or.kr/api/company.json',
            params={'crtfc_key': DART_KEY, 'stock_code': stock_code},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            if data.get('status') == '000':
                return data.get('corp_code')
    except:
        pass
    return None


# ── 상태 확인 ────────────────────────────────────────────────
def api_status() -> dict:
    """KRX API 연결 상태 확인"""
    krx_ok  = bool(KRX_KEY)
    dart_ok = bool(DART_KEY)

    # KRX API 실제 호출 테스트
    krx_live = False
    if krx_ok:
        test = _krx_get('sto/stk_bydd_trd', {'isuCd': '005930', 'strtDd': _date(5), 'endDd': _date()})
        krx_live = test is not None

    return {
        'krx_key_set':  krx_ok,
        'dart_key_set': dart_ok,
        'krx_api_live': krx_live,
        'krx_key_prefix': KRX_KEY[:8] + '...' if krx_ok else 'NOT SET',
    }
