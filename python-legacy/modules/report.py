# -*- coding: utf-8 -*-
"""
종목 리서치 리포트 생성 모듈
────────────────────────────────────────────────────────
국내 증권사 리서치 리포트 양식을 참고하여 기술적 분석 기반
종목 리포트를 자동 생성한다.

포함 항목:
  - 투자의견 (매수/적극매수/중립)
  - 목표주가 / 손절가 / 리스크-리워드
  - 5주선/40주선/RSI/MACD/거래량 분석
  - 52주 가격 레벨
  - DART 최근 공시 (90일)
  - 리스크 요인
"""
import os
from datetime import datetime, timedelta


# ── 날짜 헬퍼 ──────────────────────────────────────────────
def _date(days: int = 0) -> str:
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


# ── 거래량 코멘트 ──────────────────────────────────────────
def _vol_comment(ratio: float) -> str:
    if ratio >= 5.0:   return '폭발적 수급 유입 (세력/기관 관여 가능성)'
    if ratio >= 3.0:   return '강한 수급 유입'
    if ratio >= 2.0:   return '수급 증가 — 추세 강화 신호'
    if ratio >= 1.5:   return '평균 이상 거래 — 양호'
    if ratio >= 1.0:   return '평균 수준'
    return '거래 부진 — 모멘텀 약화 주의'


# ── DART 공시 조회 ─────────────────────────────────────────
def _get_dart_disclosures(code: str, days: int = 90) -> list:
    api_key = os.environ.get('DART_API_KEY', '')
    if not api_key:
        return []
    try:
        import requests
        r = requests.get(
            'https://opendart.fss.or.kr/api/list.json',
            params={
                'crtfc_key': api_key,
                'stock_code': code,
                'bgn_de':     _date(days),
                'end_de':     _date(),
                'page_count': 5,
            },
            timeout=8,
        )
        data = r.json()
        if data.get('status') == '000':
            return [
                {
                    'date':  item.get('rcept_dt', ''),
                    'title': item.get('report_nm', ''),
                    'corp':  item.get('corp_name', ''),
                }
                for item in data.get('list', [])[:5]
            ]
    except Exception:
        pass
    return []


# ── 스코어 → 투자의견 / 목표가 배율 ──────────────────────────
def _rating_and_upside(score: int, signal: str) -> tuple:
    """
    (투자의견 str, 목표가 업사이드 float)
    증권사 관행: Buy > 15%, Accumulate 5-15%, Hold ±5%, Reduce/Sell
    """
    if score >= 90:
        return ('매수', 0.22)
    elif score >= 85:
        return ('매수', 0.18)
    elif score >= 80:
        return ('매수', 0.14)
    elif score >= 75:
        return ('적극매수', 0.10)
    elif score >= 65:
        return ('중립', 0.08)
    else:
        return ('중립', 0.06)


# ── ATR 계산 (14일) ────────────────────────────────────────
def _calc_atr(highs: list, lows: list, closes: list, n: int = 14) -> float:
    if len(closes) < 2:
        return closes[-1] * 0.02 if closes else 0
    trs = []
    for i in range(1, min(n + 1, len(closes))):
        h, l, pc = highs[-i], lows[-i], closes[-(i + 1)]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else closes[-1] * 0.02


# ── 리포트 텍스트 포맷 ─────────────────────────────────────
def _format_text(r: dict) -> str:
    p      = r['current_price']
    tp     = r['target_price']
    sl     = r['stop_loss']
    up_pct = r['upside_pct']
    dn_pct = r['downside_pct']
    rr     = r['rr_ratio']

    up_str = f"+{up_pct:.1f}%" if up_pct >= 0 else f"{up_pct:.1f}%"
    bar    = '─' * 62

    lines = [
        bar,
        f"  {r['name']} ({r['code']})  /  {r['market']}",
        f"  기술적 분석 리포트  |  {r['generated_at'][:10]}",
        bar,
        '',
        f"  투자의견 : {r['rating']}",
        f"  목표주가 : {tp:>10,} 원   ({up_str})",
        f"  현재주가 : {p:>10,} 원",
        f"  손 절 가 : {sl:>10,} 원   (-{dn_pct:.1f}%)",
        f"  R/R 비율 : 1 : {rr}",
        f"  종합점수 : {r['score']}점 / 100점",
        '',
        bar,
        '',
        '■ 투자 포인트',
        '',
    ]

    pts = []
    if r.get('above5w') and r.get('ma5w'):
        pts.append(f"  1. 5주선({r['ma5w']:,}원) 상회 — 단기 상승 추세 진입 확인")
    if r.get('above40w') and r.get('ma40w'):
        pts.append(f"  2. 40주선({r['ma40w']:,}원) 상회 — 중장기 상승 추세 유효")
    if r['signal'] == '매수신호':
        pts.append("  3. 주봉 5주선 골든크로스 매수신호 — 추세 전환 포착")
    elif r['signal'] == '안착확인':
        pts.append("  3. 5주선 안착 확인 — 추세 안정화 진행 중")
    elif r['signal'] == '진입대기':
        pts.append("  3. 5주선 진입 대기 — 조만간 매수 타이밍 도래 예상")
    if r.get('vol_ratio', 0) >= 1.5:
        pts.append(f"  4. 거래량 {r['vol_ratio']}배 급증 — {_vol_comment(r['vol_ratio'])}")
    if r.get('rsi') and 48 <= r['rsi'] <= 65:
        pts.append(f"  5. RSI {r['rsi']:.1f} — 적정 모멘텀 구간 (과열 없는 건강한 상승)")
    if r.get('macd_cross') == 'golden':
        pts.append("  6. MACD 골든크로스 — 단기 매수 모멘텀 확인")
    if not pts:
        pts.append("  - 다수 기술 지표 동시 충족 (종합점수 기준)")
    lines += pts
    lines.append('')

    # ── 목표주가 산정 근거
    lines += [
        '■ 목표주가 산정 근거',
        '',
        f"  현재가       : {p:,} 원",
        f"  기술적 목표가 : {tp:,} 원  ({up_str})",
        f"  산정 방식    : 5주선 상향 추세 + 정배열 구조 기준",
        f"               스코어 {r['score']}점 → 기대 업사이드 {up_pct:.0f}% 적용",
        f"  손절가       : {sl:,} 원",
        f"  산정 근거    : 5주선 하단 3% + 최근 20일 저가 기준",
        f"  리스크/리워드 : {dn_pct:.1f}% 손실 감수 시 {up_pct:.1f}% 수익 기대 (1:{rr})",
        '',
    ]

    # ── 기술적 분석
    aln_map = {
        '완전정배열': '완전정배열 (단기 > 중기 > 장기)',
        '부분정배열': '부분정배열 (일부 이평선 정렬)',
        '부분역배열': '부분역배열 (주의 필요)',
        '역배열':    '역배열 (하락 구조)',
    }
    aln_desc = aln_map.get(r.get('alignment', ''), r.get('alignment', '-'))

    lines += [
        '■ 기술적 분석',
        '',
        f"  주봉 신호     : {r['signal']}",
        f"  이평선 배열   : {aln_desc}",
        f"  장기 추세     : {r.get('long_trend', '-')}",
        '',
        '  [ 이동평균선 ]',
        f"  5주선   : {r.get('ma5w', 0):,} 원  ({'▲ 상회' if r.get('above5w') else '▼ 하회'})",
    ]
    if r.get('ma40w'):
        lines.append(
            f"  40주선  : {r['ma40w']:,} 원  ({'▲ 상회' if r.get('above40w') else '▼ 하회'})"
        )
    if r.get('ma20'):
        above_ma20 = p > r['ma20']
        lines.append(f"  MA20    : {r['ma20']:,} 원  ({'▲ 상회' if above_ma20 else '▼ 하회'})")
    if r.get('ma60'):
        above_ma60 = p > r['ma60']
        lines.append(f"  MA60    : {r['ma60']:,} 원  ({'▲ 상회' if above_ma60 else '▼ 하회'})")

    lines += [
        '',
        '  [ 모멘텀 지표 ]',
        f"  RSI (14일)   : {r.get('rsi', '-')}",
        f"  MACD 크로스  : {r.get('macd_cross') or '없음'}",
        f"  ATR (14일)   : {r.get('atr', 0):,} 원 (일평균 변동폭)",
        '',
    ]

    # ── 수급 분석
    lines += [
        '■ 수급 분석',
        '',
        f"  최근 거래량   : {r.get('last_vol', 0):,} 주",
        f"  20일 평균     : {r.get('avg_vol_20d', 0):,} 주",
        f"  거래량 비율   : {r.get('vol_ratio', 0):.2f}배",
        f"  수급 평가     : {_vol_comment(r.get('vol_ratio', 0))}",
        '',
    ]

    # ── 가격 레벨
    lines += ['■ 주요 가격 레벨', '']
    if r.get('high_20d') and r.get('low_20d'):
        rng = r['high_20d'] - r['low_20d']
        lines += [
            f"  20일 최고가  : {r['high_20d']:,} 원",
            f"  20일 최저가  : {r['low_20d']:,} 원  (변동폭 {rng:,} 원)",
        ]
    if r.get('high_52w') and r.get('low_52w'):
        dist_52h = round((r['high_52w'] - p) / p * 100, 1)
        dist_52l = round((p - r['low_52w']) / p * 100, 1)
        lines += [
            f"  52주 최고가  : {r['high_52w']:,} 원  (현재가 -{dist_52h:.1f}%)",
            f"  52주 최저가  : {r['low_52w']:,} 원  (현재가 +{dist_52l:.1f}%)",
        ]
    lines.append('')

    # ── DART 공시
    disclosures = r.get('recent_disclosures', [])
    if disclosures:
        lines += ['■ 최근 공시 (90일 이내)', '']
        for d in disclosures:
            dt = d.get('date', '')
            dt_fmt = f"{dt[:4]}.{dt[4:6]}.{dt[6:8]}" if len(dt) == 8 else dt
            lines.append(f"  {dt_fmt}  {d.get('title', '-')}")
        lines.append('')
    else:
        lines += ['■ 최근 공시 (90일 이내)', '', '  - 최근 공시 없음 또는 조회 불가', '']

    # ── 리스크 요인
    lines += ['■ 리스크 요인', '']
    risks = [
        f"  ▪ 5주선({r.get('ma5w', 0):,}원) 하향 이탈 시 추세 약화 → 손절 고려",
        '  ▪ KOSPI/KOSDAQ 시장 전체 하락 시 동반 하락 위험',
    ]
    if not r.get('above40w'):
        risks.append('  ▪ 40주선 하회 중 — 중장기 하락 구조 가능성 존재')
    rsi_v = r.get('rsi', 50)
    if rsi_v and rsi_v > 70:
        risks.append(f"  ▪ RSI {rsi_v:.1f} — 단기 과열 구간, 조정 출현 가능성")
    if r.get('vol_ratio', 0) > 5:
        risks.append(f"  ▪ 거래량 {r['vol_ratio']}배 — 단기 급등 후 차익실현 물량 주의")
    if r.get('alignment') in ('부분역배열', '역배열'):
        risks.append('  ▪ 이평선 역배열 구조 — 추세 전환 확인 전 분할매수 권고')
    lines += risks

    lines += [
        '',
        bar,
        '  ※ 본 리포트는 기술적 분석 기반 자동 생성 리포트입니다.',
        '     투자 판단의 최종 책임은 투자자 본인에게 있습니다.',
        bar,
    ]
    return '\n'.join(lines)


# ── 메인: 리포트 생성 ──────────────────────────────────────
def generate_report(code: str) -> dict:
    """
    종목 리서치 리포트 생성
    Returns: 분석 데이터 dict + report_text (증권사 형식 텍스트)
    """
    from .weekly import analyze_weekly
    from .indicators import ma, rsi as rsi_fn, macd as macd_fn
    from pykrx import stock as krx

    # ── Step 1: 주봉 분석 ─────────────────────────────────
    w = analyze_weekly(code)
    if w.get('error'):
        return {'error': w['error'], 'code': code}

    sig   = w.get('signal', '관망')
    pos   = w.get('position', {})
    aln   = w.get('alignment', {})
    ma5w  = w.get('ma5w', 0) or 0
    ma40w = w.get('ma40w') or 0

    # ── Step 2: 일봉 데이터 ───────────────────────────────
    today = _date()
    df = krx.get_market_ohlcv(_date(260), today, code)
    if df is None or df.empty:
        return {'error': '일봉 데이터 없음', 'code': code}

    col_c = '종가' if '종가' in df.columns else 'Close'
    col_h = '고가' if '고가' in df.columns else 'High'
    col_l = '저가' if '저가' in df.columns else 'Low'
    col_v = '거래량' if '거래량' in df.columns else 'Volume'

    closes = [int(v) for v in df[col_c].dropna() if float(v) > 0]
    highs  = [int(v) for v in df[col_h].dropna() if float(v) > 0]
    lows   = [int(v) for v in df[col_l].dropna() if float(v) > 0]
    vols   = [int(v) for v in df[col_v].fillna(0)]

    if len(closes) < 20:
        return {'error': '데이터 부족 (20일 미만)', 'code': code}

    price = closes[-1]

    # ── Step 3: 기술 지표 ─────────────────────────────────
    rsi_val  = rsi_fn(closes) or 50.0
    ma20_arr = ma(closes, 20) or []
    ma60_arr = ma(closes, 60) or []
    macd_d   = macd_fn(closes) or {}
    atr      = int(_calc_atr(highs, lows, closes))

    avg_vol   = sum(vols[-20:]) / 20 if len(vols) >= 20 else 1
    vol_ratio = round(vols[-1] / avg_vol, 2) if avg_vol else 1.0

    # ── Step 4: 스코어 (scanner와 동일 로직) ─────────────
    score = 0
    if pos.get('above5w'):                              score += 15
    if sig == '매수신호':                               score += 10
    if pos.get('above40w'):                             score += 10
    if rsi_val and 45 <= rsi_val <= 65:                 score += 10
    if ma20_arr and price > ma20_arr[-1]:               score += 10
    if macd_d and macd_d.get('lastCross') == 'golden':  score += 10
    if vol_ratio >= 1.5:                                score += 10
    elif vol_ratio >= 1.2:                              score += 5
    if len(closes) >= 60:
        if closes[-1] > closes[-20] > closes[-60]:     score += 20
        elif closes[-1] > closes[-20]:                  score += 15

    # ── Step 5: 손절가 / 목표가 ───────────────────────────
    # 손절가: 5주선 -3% vs 현재가 -8% 중 더 보수적(높은) 가격
    stop_5w   = int((ma5w or price * 0.90) * 0.97)
    stop_8pct = int(price * 0.92)
    low_20d   = min(lows[-20:]) if len(lows) >= 20 else stop_8pct
    stop_loss = max(stop_5w, stop_8pct, int(low_20d * 0.985))

    rating, upside_pct = _rating_and_upside(score, sig)
    target_price = int(price * (1 + upside_pct))

    downside_pct = (price - stop_loss) / price if price > stop_loss else 0.05
    rr_ratio     = round(upside_pct / downside_pct, 1) if downside_pct > 0 else 0

    # ── Step 6: 종목명 ────────────────────────────────────
    try:
        name = krx.get_market_ticker_name(code)
    except Exception:
        name = code

    # ── Step 7: 시장 구분 ─────────────────────────────────
    try:
        import FinanceDataReader as fdr
        df_lst = fdr.StockListing('KRX')
        rows = df_lst[df_lst['Code'] == code]
        market = str(rows['Market'].iloc[0]) if not rows.empty else 'KRX'
    except Exception:
        market = 'KRX'

    # ── Step 8: DART 공시 ─────────────────────────────────
    disclosures = _get_dart_disclosures(code)

    # ── Step 9: 52주 가격 ─────────────────────────────────
    n52 = min(252, len(highs))
    high_52w = max(highs[-n52:]) if n52 > 0 else None
    low_52w  = min(lows[-n52:])  if n52 > 0 else None

    # ── Step 10: 리포트 조립 ─────────────────────────────
    report = {
        'code':          code,
        'name':          name,
        'market':        market,
        'generated_at':  datetime.now().isoformat(),

        # 투자 의견
        'rating':        rating,
        'target_price':  target_price,
        'stop_loss':     stop_loss,
        'current_price': price,
        'upside_pct':    round(upside_pct * 100, 1),
        'downside_pct':  round(downside_pct * 100, 1),
        'rr_ratio':      rr_ratio,
        'score':         score,

        # 기술적 분석
        'signal':        sig,
        'alignment':     aln.get('type', 'unknown'),
        'long_trend':    w.get('long_trend', ''),
        'above5w':       pos.get('above5w'),
        'above40w':      pos.get('above40w'),
        'ma5w':          ma5w,
        'ma40w':         ma40w or None,
        'ma20':          int(ma20_arr[-1]) if ma20_arr else None,
        'ma60':          int(ma60_arr[-1]) if ma60_arr else None,
        'rsi':           round(rsi_val, 1),
        'macd_cross':    macd_d.get('lastCross'),
        'atr':           atr,

        # 수급
        'vol_ratio':     vol_ratio,
        'avg_vol_20d':   int(avg_vol),
        'last_vol':      vols[-1] if vols else 0,

        # 가격 레벨
        'high_20d':      max(highs[-20:]) if len(highs) >= 20 else None,
        'low_20d':       min(lows[-20:]) if len(lows) >= 20 else None,
        'high_52w':      high_52w,
        'low_52w':       low_52w,

        # DART
        'recent_disclosures': disclosures,
    }

    report['report_text'] = _format_text(report)
    return report
