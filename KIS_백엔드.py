# ═══════════════════════════════════════════════════════════════
#  KT 피터린치 — pykrx 기반 로컬 백엔드 서버 v3.0
#
#  [철학] 차트는 '예측' 도구가 아닌 회사의 '과거 일기'
#         로봇이 못하는 것 = 기업의 미래 통찰 + 장기적 관점
#
#  [MA 체계]
#    5일  / 5주  — 단기 (주중/주간)
#   20일  / 5주  — 심리선  ★ 매수허들/익절기준
#   60일  /13주  — 수급선  (분기)
#  120일  /26주  — 경기선  (반기)
#  200일  /40주  — 연간선  ★ 장기 대세
#
#  [정배열] 단기>중기>장기 이평선 순 = 최선호 진입 구간
#  [역배열] 반대 배열 = 매수 금지
#
#  실행: python KIS_백엔드.py
#  설치: pip install flask flask-cors pykrx
# ═══════════════════════════════════════════════════════════════

from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, timedelta
import math, os

app = Flask(__name__)
CORS(app, origins="*")

# ── pykrx ────────────────────────────────────────────────────
try:
    from pykrx import stock as krx
    PYKRX_OK = True
except ImportError:
    PYKRX_OK = False
    print("[ERROR] pykrx 미설치 — pip install pykrx 실행 후 재시작")

# ── 분석 모듈 ─────────────────────────────────────────────────
try:
    from modules.indicators import ma, rsi, ema, macd, bb, check_alignment
    from modules.weekly     import analyze_weekly
    from modules.mtf        import analyze_mtf, get_monthly_ohlcv, monthly_trend
    from modules.scorer     import calculate_score
    from modules.lynch      import get_lynch_metrics
    from modules.scanner    import start_scan, scan_status, scan_results, stop_scan
    from modules.backtest   import backtest_5w
    MODULES_OK = True
    print("[OK] 분석 모듈 로드 완료")
except ImportError as e:
    MODULES_OK = False
    print(f"[WARN] 모듈 로드 실패 — 기존 인라인 함수 사용: {e}")
    # ── 폴백: 인라인 지표 함수 ──────────────────────────────
    def ma(p, n):
        if len(p) < n: return []
        return [sum(p[i:i+n])/n for i in range(len(p)-n+1)]
    def rsi(p, n=14):
        if len(p) < n+1: return None
        d = [p[i]-p[i-1] for i in range(1, len(p))]
        g = sum(max(x,0) for x in d[-n:])/n
        l = sum(max(-x,0) for x in d[-n:])/n
        return round(100-100/(1+g/l),1) if l else 100.0
    def ema(p, n):
        if len(p) < n: return []
        r=[sum(p[:n])/n]; k=2/(n+1)
        for v in p[n:]: r.append(v*k+r[-1]*(1-k))
        return r
    def macd(p):
        e12,e26=ema(p,12),ema(p,26)
        if not e12 or not e26: return None
        diff=len(e12)-len(e26)
        ml=[e12[diff+i]-e26[i] for i in range(len(e26))]
        sl=ema(ml,9)
        if not sl: return None
        cross=None
        if len(ml)>=2 and len(sl)>=2:
            if ml[-1]>sl[-1] and ml[-2]<=sl[-2]: cross='golden'
            elif ml[-1]<sl[-1] and ml[-2]>=sl[-2]: cross='dead'
        return {"lastCross":cross,"macdLine":ml[-20:],"signalLine":sl[-20:],
                "histogram":[ml[-len(sl)+i]-sl[i] for i in range(len(sl))][-20:]}
    def bb(p,n=20):
        if len(p)<n: return None
        r=p[-n:]; m=sum(r)/n
        std=math.sqrt(sum((v-m)**2 for v in r)/n)
        u,l=m+2*std,m-2*std
        pb=(p[-1]-l)/(u-l)*100 if u!=l else 50
        bw=(u-l)/m*100 if m>0 else 0
        return {"upper":round(u),"mid":round(m),"lower":round(l),"percentB":round(pb,1),"bandwidth":round(bw,1)}
    def check_alignment(price, ma_values): return {'type':'unknown','score':0}
    def analyze_weekly(code): return {'error':'modules 미설치'}
    def analyze_mtf(code, **kw): return {'error':'modules 미설치'}
    def calculate_score(code, **kw): return {'error':'modules 미설치'}
    def get_lynch_metrics(code): return {'error':'modules 미설치'}
    def start_scan(**kw): return {'error':'modules 미설치'}
    def scan_status(): return {'error':'modules 미설치'}
    def scan_results(): return {'error':'modules 미설치'}
    def stop_scan(): return {'error':'modules 미설치'}
    def backtest_5w(code, **kw): return {'error':'modules 미설치'}

# ── 날짜 헬퍼 ────────────────────────────────────────────────
def today_str():
    return datetime.now().strftime('%Y%m%d')

def days_ago_str(n):
    return (datetime.now() - timedelta(days=n)).strftime('%Y%m%d')

# ── KRX 종목 리스트 캐시 ─────────────────────────────────────
_krx_cache  = {}
_krx_loaded = False

def load_krx_list():
    global _krx_cache, _krx_loaded
    if _krx_loaded: return
    try:
        today = today_str()
        for mkt in ['KOSPI', 'KOSDAQ']:
            for code in krx.get_market_ticker_list(today, market=mkt):
                name = krx.get_market_ticker_name(code)
                _krx_cache[code] = {'name': name, 'market': mkt}
        _krx_loaded = True
        print(f"[KRX] 종목 {len(_krx_cache)}개 로드 완료")
    except Exception as e:
        print(f"[KRX] 종목 로드 실패: {e}")


# ═══════════════════════════════════════════════════════════════
#  헬스 체크
# ═══════════════════════════════════════════════════════════════

@app.route('/api/health')
def health():
    try:
        from modules.krx_api import api_status
        krx_status = api_status()
    except Exception:
        krx_status = {}
    return jsonify({
        'status':    'ok',
        'version':   'v3.0',
        'timestamp': datetime.now().isoformat(),
        'pykrx':     PYKRX_OK,
        'modules':   MODULES_OK,
        'krx_api':   krx_status,
        'endpoints': [
            '/api/health', '/api/analysis', '/api/weekly', '/api/mtf',
            '/api/score', '/api/lynch', '/api/full', '/api/backtest',
            '/api/report/<code>',
            '/api/scan/start', '/api/scan/status', '/api/scan/results', '/api/scan/stop',
        ],
    })


# ═══════════════════════════════════════════════════════════════
#  기존 API 엔드포인트
# ═══════════════════════════════════════════════════════════════

@app.route('/api/quotes')
def quotes():
    if not PYKRX_OK:
        return jsonify({'error': 'pykrx 미설치'}), 500
    codes   = [c.strip() for c in request.args.get('codes','').split(',') if c.strip()]
    results = []
    today   = today_str()
    for code in codes:
        try:
            df = krx.get_market_ohlcv(today, today, code)
            if df is None or df.empty:
                df = krx.get_market_ohlcv(days_ago_str(10), today, code)
            if df is None or df.empty:
                results.append({'code': code, 'price': 0, 'changeRate': 0, 'name': ''}); continue
            row  = df.iloc[-1]
            name = krx.get_market_ticker_name(code)
            price= int(row.get('종가', 0))
            prev = int(row.get('시가', price))
            cr   = round((price-prev)/prev*100, 2) if prev else 0
            results.append({'code': code, 'price': price,
                            'changeRate': float(row.get('등락률', cr)), 'name': name})
        except Exception as e:
            results.append({'code': code, 'price': 0, 'changeRate': 0, 'name': '', 'error': str(e)})
    return jsonify({'quotes': results})


@app.route('/api/analysis')
def analysis():
    if not PYKRX_OK:
        return jsonify({'error': 'pykrx 미설치'}), 500
    code = request.args.get('code','').strip()
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    try:
        today = today_str()
        start = days_ago_str(400)   # 200일선 + 여유분

        df = krx.get_market_ohlcv(start, today, code)
        if df is None or df.empty:
            return jsonify({'error': f'{code} 데이터 없음'}), 404

        name = krx.get_market_ticker_name(code)
        load_krx_list()
        market = _krx_cache.get(code, {}).get('market', '')

        candles = []
        for date_idx, row in df.iterrows():
            cl = int(row.get('종가', 0))
            if cl > 0:
                candles.append({
                    'date': date_idx.strftime('%Y%m%d') if hasattr(date_idx,'strftime') else str(date_idx)[:8],
                    'o': int(row.get('시가',0)), 'h': int(row.get('고가',0)),
                    'l': int(row.get('저가',0)), 'c': cl,
                    'v': int(row.get('거래량',0)),
                })
        if not candles:
            return jsonify({'error': f'{code} 캔들 없음'}), 404

        closes = [c['c'] for c in candles]
        vols   = [c['v'] for c in candles]
        price  = candles[-1]['c']

        change_rate = 0
        if len(candles) >= 2:
            prev_c = candles[-2]['c']
            if prev_c: change_rate = round((price-prev_c)/prev_c*100, 2)

        w52    = closes[-252:] if len(closes) >= 252 else closes
        high52 = max(w52); low52 = min(w52)

        ma5_a   = ma(closes, 5)
        ma20_a  = ma(closes, 20)
        ma60_a  = ma(closes, 60)
        ma120_a = ma(closes, 120)
        ma200_a = ma(closes, 200)

        avg_vol = sum(vols[-20:]) / max(len(vols[-20:]),1) if vols else 1

        # 펀더멘털
        fund = {'per':0,'pbr':0,'eps':0,'bps':0}
        try:
            fi = krx.get_market_fundamental(today, today, code)
            if fi is not None and not fi.empty:
                row = fi.iloc[-1]
                fund = {'per': float(row.get('PER',0) or 0),
                        'pbr': float(row.get('PBR',0) or 0),
                        'eps': float(row.get('EPS',0) or 0),
                        'bps': float(row.get('BPS',0) or 0)}
        except: pass

        # 일봉 정배열 체크
        daily_align = check_alignment(price, {
            'ma5': round(ma5_a[-1])   if ma5_a   else 0,
            'ma20': round(ma20_a[-1]) if ma20_a  else 0,
            'ma60': round(ma60_a[-1]) if ma60_a  else 0,
            'ma120': round(ma120_a[-1]) if ma120_a else 0,
            'ma200': round(ma200_a[-1]) if ma200_a else 0,
        })

        return jsonify({
            'code':       code, 'name': name, 'market': market, 'source': 'pykrx/KRX',
            'currentPrice': price, 'changeRate': change_rate,
            'high52w': high52, 'low52w': low52,
            # 이동평균 (일봉 전체 체계)
            'ma5':   round(ma5_a[-1])   if ma5_a   else 0,
            'ma20':  round(ma20_a[-1])  if ma20_a  else 0,   # = 주봉 5주선
            'ma60':  round(ma60_a[-1])  if ma60_a  else 0,   # = 주봉 13주선
            'ma120': round(ma120_a[-1]) if ma120_a else 0,   # = 주봉 26주선
            'ma200': round(ma200_a[-1]) if ma200_a else 0,   # = 주봉 40주선
            'ma5arr':   [round(v) for v in ma5_a[-80:]],
            'ma20arr':  [round(v) for v in ma20_a[-80:]],
            'ma60arr':  [round(v) for v in ma60_a[-80:]],
            'ma120arr': [round(v) for v in ma120_a[-80:]] if ma120_a else [],
            'ma200arr': [round(v) for v in ma200_a[-80:]] if ma200_a else [],
            # 정배열 여부
            'alignment': daily_align,
            # 기타 지표
            'rsi': rsi(closes), 'macd': macd(closes), 'bb': bb(closes),
            'candles': candles[-80:],
            'volRatio': round(vols[-1]/avg_vol, 2) if vols and avg_vol else 1,
            'fundamentals': fund,
            # MA 설명 (프론트 표시용)
            'ma_legend': {
                'ma20':  '20일선 = 주봉 5주선 (심리선) ★',
                'ma60':  '60일선 = 주봉 13주선 (수급선)',
                'ma120': '120일선 = 주봉 26주선 (경기선)',
                'ma200': '200일선 = 주봉 40주선 (연간) ★',
            },
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/search')
def search():
    if not PYKRX_OK:
        return jsonify({'results': []}), 200
    q = request.args.get('q','').strip()
    if not q: return jsonify({'results': []})
    load_krx_list()
    hits = [{'code': c, 'name': i['name'], 'market': i['market']}
            for c, i in _krx_cache.items() if q in i['name'] or q in c]
    return jsonify({'results': hits[:20]})


@app.route('/api/market')
def market():
    if not PYKRX_OK:
        return jsonify({'market': []}), 200
    result = []
    today  = today_str()
    for idx_code, idx_name in [('1028','KOSPI'),('2001','KOSDAQ')]:
        try:
            df = krx.get_index_ohlcv(days_ago_str(5), today, idx_code)
            if df.empty: continue
            row  = df.iloc[-1]; prev = df.iloc[-2] if len(df)>=2 else row
            price= float(row.get('종가',0)); p = float(prev.get('종가',price))
            cr   = round((price-p)/p*100, 2) if p else 0
            result.append({'id':idx_code,'name':idx_name,'price':price,'changeRate':cr})
        except Exception as e:
            print(f"[market] {idx_name}: {e}")
    return jsonify({'market': result})


@app.route('/api/news')
def news():
    """
    종목 뉴스 + 공시 통합 API
    GET /api/news?code=005930&corp=00126380&name=삼성전자&dartKey=KEY

    반환:
      disclosures   DART 공시 목록 (최근 90일)
      stockNews     종목 뉴스 (네이버 금융)
      macroNews     시장/경제 뉴스
      newsSentiment 감성 분석 요약
    """
    code     = request.args.get('code', '').strip()
    corp     = request.args.get('corp', '').strip()
    name     = request.args.get('name', '').strip()
    dart_key = request.args.get('dartKey', '').strip()

    result = {
        'disclosures':   [],
        'stockNews':     [],
        'macroNews':     [],
        'newsSentiment': None,
    }

    # ── 1. DART 공시 ──────────────────────────────────────────
    if corp and dart_key:
        try:
            from datetime import datetime, timedelta
            import requests as req_lib
            end_dt   = datetime.now()
            start_dt = end_dt - timedelta(days=90)
            params = {
                'crtfc_key': dart_key,
                'corp_code': corp,
                'bgn_de':    start_dt.strftime('%Y%m%d'),
                'end_de':    end_dt.strftime('%Y%m%d'),
                'page_no':   '1',
                'page_count':'20',
            }
            r = req_lib.get('https://opendart.fss.or.kr/api/list.json',
                            params=params, timeout=8)
            if r.status_code == 200:
                data = r.json()
                if data.get('status') == '000' and data.get('list'):
                    def classify_disclosure(title):
                        t = title.lower()
                        if any(k in t for k in ['실적','매출','영업이익','순이익','분기','반기','사업보고']): return 'earnings'
                        if any(k in t for k in ['자기주식','자사주']): return 'buyback'
                        if any(k in t for k in ['합병','인수','취득','양도','주식매수']): return 'takeover'
                        if any(k in t for k in ['임원','이사','대표','등기']): return 'insider'
                        if any(k in t for k in ['공급계약','수주','계약','협약','mou','파트너']): return 'major'
                        return 'general'
                    for item in data['list']:
                        rcp_no = item.get('rcept_no','')
                        result['disclosures'].append({
                            'title': item.get('report_nm',''),
                            'date':  item.get('rcept_dt','')[:10] if item.get('rcept_dt') else '',
                            'type':  classify_disclosure(item.get('report_nm','')),
                            'url':   f'https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcp_no}' if rcp_no else 'https://dart.fss.or.kr',
                        })
        except Exception as e:
            print(f'[news] DART 오류: {e}')

    # ── 2. 네이버 종목 뉴스 ───────────────────────────────────
    if code:
        try:
            import requests as req_lib
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://finance.naver.com/',
            }
            url = f'https://m.stock.naver.com/api/news/stock/{code}?pageSize=10&page=1'
            r = req_lib.get(url, headers=headers, timeout=6)
            if r.status_code == 200:
                items = r.json()
                if isinstance(items, list):
                    for item in items[:10]:
                        result['stockNews'].append({
                            'title':     item.get('title', ''),
                            'url':       item.get('url', ''),
                            'publisher': item.get('officeName', ''),
                            'date':      item.get('datetime', '')[:10] if item.get('datetime') else '',
                        })
        except Exception as e:
            print(f'[news] 네이버 뉴스 오류: {e}')

    # ── 3. 뉴스 감성 분석 (키워드 기반 간이) ─────────────────
    pos_kw  = ['급등','상승','호실적','성장','수주','계약','신고가','매수','기대','호재']
    neg_kw  = ['급락','하락','적자','손실','리스크','우려','매도','주의','손절','경고']
    pos_cnt = neg_cnt = neutral_cnt = 0
    all_news = result['stockNews'] + result['macroNews']
    for n in all_news:
        t = n.get('title','')
        if any(k in t for k in pos_kw): pos_cnt += 1
        elif any(k in t for k in neg_kw): neg_cnt += 1
        else: neutral_cnt += 1
    if all_news:
        score = pos_cnt - neg_cnt
        result['newsSentiment'] = {
            'pos': pos_cnt, 'neg': neg_cnt, 'neutral': neutral_cnt,
            'score': score,
            'label': '긍정' if score > 0 else '부정' if score < 0 else '중립',
        }

    return jsonify(result)

@app.route('/api/movers')
def movers():
    return jsonify({'candidates': []})


# ═══════════════════════════════════════════════════════════════
#  신규 API 엔드포인트
# ═══════════════════════════════════════════════════════════════

@app.route('/api/weekly')
def weekly():
    """
    주봉 분석
    GET /api/weekly?code=005930

    반환:
      signal       매수신호/안착확인/진입대기/익절경고/관망
      ma5w~ma40w   주봉 이평선 현재값
      alignment    정배열/역배열 여부
      position     각 이평선 대비 위치
    """
    code = request.args.get('code','').strip()
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(analyze_weekly(code))


@app.route('/api/mtf')
def mtf():
    """
    멀티타임프레임 통합 분석
    GET /api/mtf?code=005930

    월봉 대세 방향 + 주봉 5주선 신호 + 일봉 타이밍 통합 판단
    """
    code = request.args.get('code','').strip()
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(analyze_mtf(code))


@app.route('/api/score')
def score():
    """
    종합 매수 강도 스코어
    GET /api/score?code=005930

    반환:
      score    0~100점
      grade    A/B/C/D
      verdict  매수검토/관망/대기/진입금지
    """
    code = request.args.get('code','').strip()
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(calculate_score(code))


@app.route('/api/lynch')
def lynch():
    """
    피터 린치 지표
    GET /api/lynch?code=005930

    반환:
      peg          PER/EPS성장률 (1 이하 = 저평가)
      eps_growth   전년 대비 EPS 성장률(%)
      div_yield    배당수익률(%)
      lynch_grade  Strong Buy / Buy / Hold / Avoid
    """
    code = request.args.get('code','').strip()
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(get_lynch_metrics(code))


@app.route('/api/report/<code>')
def stock_report(code):
    """종목 리서치 리포트 JSON"""
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    try:
        from modules.report import generate_report
        result = generate_report(code.zfill(6))
        if result.get('error'):
            return jsonify(result), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e), 'code': code}), 500


@app.route('/report/<code>')
def stock_report_html(code):
    """종목 리서치 리포트 HTML (브라우저용)"""
    if not MODULES_OK:
        return '<h2>modules 오류</h2>', 500
    try:
        from modules.report import generate_report
        from modules.report_html import render_report_html
        result = generate_report(code.zfill(6))
        if result.get('error'):
            return f"<h2>오류: {result['error']}</h2>", 404
        return render_report_html(result), 200, {'Content-Type': 'text/html; charset=utf-8'}
    except Exception as e:
        import traceback
        return f'<pre>{traceback.format_exc()}</pre>', 500


@app.route('/')
def index():
    """메인 검색 페이지"""
    from modules.report_html import render_index_html
    return render_index_html(), 200, {'Content-Type': 'text/html; charset=utf-8'}


@app.route('/api/scan/start', methods=['POST', 'GET'])
def scan_start():
    """
    전종목 스캔 시작 (백그라운드)
    POST /api/scan/start
    Body (선택): {"min_score": 65, "markets": ["KOSPI","KOSDAQ"], "quick": true}

    quick=true (기본): 주봉 신호 없는 종목 스킵 → 속도 3~5배
    """
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    # JSON body 우선, 없으면 query param, 없으면 기본값
    body      = request.get_json(silent=True) or {}
    min_score = int(body.get('min_score', request.args.get('min_score', 55)))
    markets_p = request.args.get('markets', '')
    markets   = body.get('markets', markets_p.split(',') if markets_p else ['KOSPI','KOSDAQ'])
    quick_p   = request.args.get('quick', 'true').lower() == 'true'
    quick     = body.get('quick', quick_p)
    return jsonify(start_scan(min_score=min_score, markets=markets, quick=quick))


@app.route('/api/scan/status')
def scan_status_api():
    """
    스캔 진행 상황
    GET /api/scan/status

    반환:
      running   스캔 중 여부
      percent   진행률(%)
      current   현재 분석 중인 종목
    """
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(scan_status())


@app.route('/api/scan/results')
def scan_results_api():
    """
    스캔 결과
    GET /api/scan/results

    반환:
      results      조건 충족 종목 리스트 (스코어 순, Top 50)
      total_found  총 발견 종목 수
    """
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(scan_results())


@app.route('/api/scan/stop', methods=['POST', 'GET'])
def scan_stop():
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(stop_scan())


@app.route('/api/backtest')
def backtest():
    """
    주봉 5주선 전략 백테스트
    GET /api/backtest?code=005930&years=5

    반환:
      total_return     복리 총 수익률(%)
      buy_hold_return  Buy & Hold 수익률 (비교)
      alpha            초과 수익률
      win_rate         승률(%)
      mdd              최대 낙폭(%)
      sharpe           샤프 비율(연환산)
      trades           최근 20건 거래 내역
      open_position    현재 보유 중인 미청산 포지션
    """
    code  = request.args.get('code','').strip()
    years = int(request.args.get('years', 5))
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    if not MODULES_OK:
        return jsonify({'error': 'modules 디렉토리를 확인하세요'}), 500
    return jsonify(backtest_5w(code, years=years))


@app.route('/api/full')
def full_analysis():
    """
    종목 종합 분석 (1회 호출로 모든 정보)
    GET /api/full?code=005930

    일봉 + 주봉 + MTF + 스코어 + 피터린치 통합 반환
    """
    code = request.args.get('code','').strip()
    if not code:
        return jsonify({'error': '종목코드 필요'}), 400
    if not PYKRX_OK:
        return jsonify({'error': 'pykrx 미설치'}), 500

    result = {'code': code}

    # 주봉 (먼저 실행, MTF/scorer에서 재사용)
    w_result = None
    if MODULES_OK:
        w_result = analyze_weekly(code)
        result['weekly'] = w_result

    # 일봉 (analysis 엔드포인트 로직 인라인)
    try:
        today = today_str()
        df    = krx.get_market_ohlcv(days_ago_str(400), today, code)
        if df is not None and not df.empty:
            candles = []
            for di, row in df.iterrows():
                cl = int(row.get('종가', 0))
                if cl > 0:
                    candles.append({
                        'date': di.strftime('%Y%m%d') if hasattr(di,'strftime') else str(di)[:8],
                        'o': int(row.get('시가',0)), 'h': int(row.get('고가',0)),
                        'l': int(row.get('저가',0)), 'c': cl, 'v': int(row.get('거래량',0))
                    })
            if candles:
                closes = [c['c'] for c in candles]
                vols   = [c['v'] for c in candles]
                price  = candles[-1]['c']
                ma5_a  = ma(closes, 5);  ma20_a = ma(closes, 20)
                ma60_a = ma(closes, 60); ma120_a= ma(closes, 120); ma200_a=ma(closes, 200)
                avg_vol= sum(vols[-20:])/max(len(vols[-20:]),1)
                fund   = {'per':0,'pbr':0,'eps':0,'bps':0}
                try:
                    fi = krx.get_market_fundamental(today, today, code)
                    if fi is not None and not fi.empty:
                        r = fi.iloc[-1]
                        fund = {'per':float(r.get('PER',0) or 0),'pbr':float(r.get('PBR',0) or 0),
                                'eps':float(r.get('EPS',0) or 0),'bps':float(r.get('BPS',0) or 0)}
                except: pass

                daily_data = {
                    'currentPrice': price,
                    'ma5':   round(ma5_a[-1])   if ma5_a   else 0,
                    'ma20':  round(ma20_a[-1])  if ma20_a  else 0,
                    'ma60':  round(ma60_a[-1])  if ma60_a  else 0,
                    'ma120': round(ma120_a[-1]) if ma120_a else 0,
                    'ma200': round(ma200_a[-1]) if ma200_a else 0,
                    'rsi':   rsi(closes),
                    'macd':  macd(closes),
                    'bb':    bb(closes),
                    'volRatio': round(vols[-1]/avg_vol,2) if avg_vol else 1,
                    'fundamentals': fund,
                }
                result['daily'] = daily_data

                if MODULES_OK:
                    result['mtf']   = analyze_mtf(code, daily_data=daily_data, weekly_result=w_result)
                    result['score'] = calculate_score(code, daily_data=daily_data, weekly_result=w_result)
                    result['lynch'] = get_lynch_metrics(code)
    except Exception as e:
        result['daily_error'] = str(e)

    return jsonify(result)


# ═══════════════════════════════════════════════════════════════
# 시장 지수 + 뉴스 API
# ═══════════════════════════════════════════════════════════════

@app.route('/api/market/indices')
def market_indices():
    """KOSPI/KOSDAQ + 주요 해외 지수"""
    result = []
    try:
        from pykrx import stock as krx
        from datetime import datetime, timedelta
        today = datetime.now().strftime('%Y%m%d')
        start = (datetime.now() - timedelta(days=5)).strftime('%Y%m%d')
        # 1차: FinanceDataReader로 KOSPI/KOSDAQ 지수
        try:
            import FinanceDataReader as fdr
            start_fdr = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
            for sym, name in [('KS11', 'KOSPI'), ('KQ11', 'KOSDAQ')]:
                try:
                    df = fdr.DataReader(sym, start_fdr)
                    if df is not None and not df.empty:
                        vals = [float(v) for v in df['Close'].dropna() if v > 0]
                        if len(vals) >= 2:
                            cur, prev = vals[-1], vals[-2]
                            chg = cur - prev
                            result.append({
                                'name': name, 'value': round(cur, 2),
                                'change': round(chg, 2),
                                'change_pct': round(chg / prev * 100, 2),
                            })
                except Exception:
                    pass
        except Exception:
            pass

        # 2차: pykrx 폴백 (FDR 미설치 또는 실패 시)
        have = {r['name'] for r in result}
        if 'KOSPI' not in have or 'KOSDAQ' not in have:
            for ticker, name in [('1028', 'KOSPI'), ('2001', 'KOSDAQ')]:
                if name in have:
                    continue
                try:
                    df = krx.get_index_ohlcv_by_date(start, today, ticker)
                    if df is not None and not df.empty:
                        col = '종가' if '종가' in df.columns else df.columns[-1]
                        vals = df[col].dropna().tolist()
                        if len(vals) >= 2:
                            cur, prev = float(vals[-1]), float(vals[-2])
                            chg = cur - prev
                            result.append({
                                'name': name, 'value': round(cur, 2),
                                'change': round(chg, 2),
                                'change_pct': round(chg / prev * 100, 2),
                            })
                except Exception:
                    pass
    except Exception:
        pass

    # 해외 지수 (yfinance)
    overseas = [
        ('^GSPC', 'S&P 500'), ('^IXIC', 'NASDAQ'), ('^DJI', 'DOW'),
        ('^N225', '닛케이225'), ('^HSI', '항셍'), ('000001.SS', '상하이'),
    ]
    try:
        import yfinance as yf
        for sym, name in overseas:
            try:
                tk = yf.Ticker(sym)
                hist = tk.history(period='2d')
                if len(hist) >= 2:
                    cur  = round(hist['Close'].iloc[-1], 2)
                    prev = round(hist['Close'].iloc[-2], 2)
                    chg  = round(cur - prev, 2)
                    result.append({
                        'name': name, 'value': cur,
                        'change': chg, 'change_pct': round(chg / prev * 100, 2),
                    })
            except Exception:
                pass
    except ImportError:
        # yfinance 없으면 환율만
        pass

    return jsonify(result)


@app.route('/api/market/news')
def market_news():
    """국내외 시황·경제·군사 뉴스 RSS 수집"""
    import time
    import xml.etree.ElementTree as ET

    feeds = [
        # 국내
        ('https://www.hankyung.com/feed/all-news',         '국내',  '한국경제'),
        ('https://www.mk.co.kr/rss/30000001/',             '국내',  '매일경제'),
        ('https://feeds.bbci.co.uk/korean/rss.xml',        '글로벌','BBC코리아'),
        # 미국/글로벌
        ('https://feeds.reuters.com/reuters/businessNews', '미국',  'Reuters'),
        ('https://feeds.a.dj.com/rss/RSSMarketsMain.xml',  '미국',  'WSJ Markets'),
        ('https://www.cnbc.com/id/100003114/device/rss/rss.html', '미국', 'CNBC'),
        # 경제/군사
        ('https://feeds.feedburner.com/reuters/worldNews', '글로벌','Reuters World'),
    ]

    articles = []
    try:
        import urllib.request
        for url, tag, source in feeds:
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/rss+xml,application/xml,text/xml'
                })
                with urllib.request.urlopen(req, timeout=5) as resp:
                    xml_data = resp.read()
                root = ET.fromstring(xml_data)
                ns   = {'atom': 'http://www.w3.org/2005/Atom'}
                items = root.findall('.//item') or root.findall('.//atom:entry', ns)
                for item in items[:3]:
                    title = (item.findtext('title') or '').strip()
                    link  = (item.findtext('link') or '').strip()
                    pub   = (item.findtext('pubDate') or item.findtext('published') or '').strip()
                    # pubDate 단순화
                    if pub and len(pub) > 16:
                        try:
                            from email.utils import parsedate_to_datetime
                            dt = parsedate_to_datetime(pub)
                            pub = dt.strftime('%m/%d %H:%M')
                        except Exception:
                            pub = pub[:16]
                    if title:
                        articles.append({
                            'tag':    tag,
                            'source': source,
                            'title':  title,
                            'url':    link,
                            'date':   pub,
                        })
                    if len(articles) >= 30:
                        break
                if len(articles) >= 30:
                    break
            except Exception:
                continue
    except Exception:
        pass

    # 빈 경우 더미
    if not articles:
        articles = [{
            'tag': '국내', 'source': '시스템', 'date': '',
            'title': '뉴스 피드를 불러올 수 없습니다 (네트워크 확인)',
            'url': '',
        }]

    return jsonify(articles[:24])


@app.route('/api/macro')
def api_macro():
    """거시경제 지표 — VIX, USD/KRW, US 10Y, KOSPI"""
    data = {}
    notes = []
    try:
        import yfinance as yf
        # USD/KRW
        try:
            kr = yf.Ticker('USDKRW=X').history(period='5d')
            if not kr.empty:
                cur = float(kr['Close'].iloc[-1])
                prev = float(kr['Close'].iloc[-2]) if len(kr) >= 2 else cur
                data['usdkrw'] = {'current': round(cur, 0), 'changePct': round((cur-prev)/prev*100, 2)}
        except Exception:
            pass
        # VIX
        try:
            vix_df = yf.Ticker('^VIX').history(period='5d')
            if not vix_df.empty:
                data['vix'] = {'current': round(float(vix_df['Close'].iloc[-1]), 2)}
        except Exception:
            pass
        # US 10Y
        try:
            t10 = yf.Ticker('^TNX').history(period='5d')
            if not t10.empty:
                data['us10y'] = {'current': round(float(t10['Close'].iloc[-1]), 2)}
        except Exception:
            pass
    except Exception:
        pass

    # KOSPI (pykrx)
    try:
        from pykrx import stock as krx
        from datetime import datetime as _dt, timedelta as _td
        _today = _dt.now().strftime('%Y%m%d')
        _start = (_dt.now() - _td(days=7)).strftime('%Y%m%d')
        df_k = krx.get_index_ohlcv_by_date(_start, _today, '1028')
        if df_k is not None and not df_k.empty:
            col = '종가' if '종가' in df_k.columns else df_k.columns[-1]
            vals = df_k[col].dropna().tolist()
            if len(vals) >= 2:
                cur, prev = float(vals[-1]), float(vals[-2])
                data['kospi'] = {'current': round(cur, 2), 'changePct': round((cur-prev)/prev*100, 2)}
    except Exception:
        pass

    # 종합 판단
    vix_v = data.get('vix', {}).get('current', 20)
    if vix_v > 25:
        label = '부정'
        notes.append(f'VIX {vix_v} — 시장 공포 고조. 변동성 확대 구간.')
    elif vix_v > 20:
        label = '중립'
        notes.append(f'VIX {vix_v} — 불안감 상승 중. 주의 필요.')
    else:
        label = '긍정'
        notes.append(f'VIX {vix_v} — 시장 안정. 투자 우호 환경.')

    krw_v = data.get('usdkrw', {}).get('current', 1300)
    if krw_v and krw_v > 1400:
        notes.append(f'원/달러 {krw_v:.0f}원 — 고환율. 수출주 유리, 내수주 부담.')
    elif krw_v and krw_v > 1350:
        notes.append(f'원/달러 {krw_v:.0f}원 — 원화 약세.')

    return jsonify({'label': label, 'data': data, 'notes': notes})


# ═══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("=" * 55)
    print("  KT 피터린치 — pykrx 백엔드 서버 v3.0")
    print("  [철학] 차트 = 회사의 과거 일기")
    print("  [핵심] 주봉 5주선 위 안착 시에만 매수")
    print()
    print("  데이터: 한국거래소(KRX) / API키 불필요")
    print("=" * 55)

    if not PYKRX_OK:
        print("\n  pykrx 미설치!")
        print("  pip install pykrx 실행 후 재시작\n")
    else:
        print(f"\n  서버: http://localhost:8000")
        print()
        print("  [기존] /api/analysis  /api/quotes  /api/market")
        print()
        print("  [신규 엔드포인트]")
        print("  /api/weekly?code=005930     주봉 5주선 분석 + 신호")
        print("  /api/mtf?code=005930        월봉/주봉/일봉 통합")
        print("  /api/score?code=005930      0~100점 매수 강도")
        print("  /api/lynch?code=005930      피터린치 PEG/성장률")
        print("  /api/full?code=005930       종합 분석 (1회 호출)")
        print("  /api/scan/start             전종목 스캔 시작")
        print("  /api/scan/status            스캔 진행률")
        print("  /api/scan/results           스캔 결과 Top 50")
        print("  /api/backtest?code=005930   5주선 전략 백테스트")
        print()

    if not MODULES_OK:
        print("  [주의] modules/ 폴더가 없거나 임포트 오류")
        print("  modules/__init__.py 가 있는지 확인하세요\n")

    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port, debug=False)
