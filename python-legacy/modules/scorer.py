"""
종합 매수 강도 스코어 모듈 (0~100점)
─────────────────────────────────────────
주봉 5주선 (35점) ← 핵심 허들
  위 안착        +15
  상향 돌파 추가  +10  (매수신호 발생 시)
  40주선 위       +10  (장기 대세 확인)

일봉 지표 (30점)
  RSI 45~65      +10
  MACD 골든      +10
  20일선(심리선) 위 +10

월봉 추세 (20점)
  강한 상승 +20 / 상승 +15 / 하락 +5 / 강한 하락 +0

거래량/펀더멘털 (15점)
  거래량 1.5배↑  +10 / 1.2배 +5
  PER 15 이하    +5

정배열 보너스 (별도)
  완전정배열  → verdict에 ★ 추가
"""


def calculate_score(code: str,
                    daily_data:    dict = None,
                    weekly_result: dict = None,
                    monthly_data:  list = None) -> dict:

    score     = 0
    breakdown = {}

    # ── 주봉 35점 ──
    try:
        from .weekly import analyze_weekly
        w   = weekly_result or analyze_weekly(code)
        pos = w.get('position', {})
        sig = w.get('signal', '관망')
        aln = w.get('alignment', {})

        w_pts = 0
        if pos.get('above5w'):   w_pts += 15
        if sig == '매수신호':   w_pts += 10
        if pos.get('above40w'):  w_pts += 10
        score += w_pts

        breakdown['weekly'] = {
            'pts': w_pts, 'max': 35,
            'signal':    sig,
            'above5w':   pos.get('above5w'),
            'above40w':  pos.get('above40w'),
            'alignment': aln.get('type', 'unknown'),
        }
    except Exception as e:
        breakdown['weekly'] = {'pts': 0, 'max': 35, 'error': str(e)}

    # ── 일봉 30점 ──
    d_pts = 0
    if daily_data:
        rsi_val = daily_data.get('rsi')
        macd_d  = daily_data.get('macd') or {}
        price   = daily_data.get('currentPrice', 0)
        ma20    = daily_data.get('ma20', 0)

        if rsi_val and 45 <= rsi_val <= 65: d_pts += 10
        if macd_d.get('lastCross') == 'golden': d_pts += 10
        if price and ma20 and price > ma20: d_pts += 10
    score += d_pts
    breakdown['daily'] = {'pts': d_pts, 'max': 30}

    # ── 월봉 20점 ──
    try:
        from .mtf import get_monthly_ohlcv, monthly_trend
        monthly     = monthly_data or get_monthly_ohlcv(code, months=12)
        trend, m_pts = monthly_trend(monthly)
        score += m_pts
        breakdown['monthly'] = {'pts': m_pts, 'max': 20, 'trend': trend}
    except:
        score += 10
        breakdown['monthly'] = {'pts': 10, 'max': 20, 'trend': 'unknown'}

    # ── 거래량/펀더멘털 15점 ──
    v_pts = 0
    if daily_data:
        vol_ratio = daily_data.get('volRatio', 1)
        if vol_ratio >= 1.5:   v_pts += 10
        elif vol_ratio >= 1.2: v_pts += 5
        per = (daily_data.get('fundamentals') or {}).get('per', 0)
        if 0 < per <= 15: v_pts += 5
    score += v_pts
    breakdown['vol_fund'] = {'pts': v_pts, 'max': 15}

    # ── 정배열 체크 (보너스 정보) ──
    align_type = breakdown.get('weekly', {}).get('alignment', 'unknown')

    # ── 등급 ──
    if score >= 70:
        grade, verdict = 'A', '매수 검토'
    elif score >= 55:
        grade, verdict = 'B', '관망 (신호 약함)'
    elif score >= 40:
        grade, verdict = 'C', '대기'
    else:
        grade, verdict = 'D', '진입 금지'

    if align_type == '완전정배열' and grade in ('A', 'B'):
        verdict += ' ★ 완전정배열'

    return {
        'score':      score,
        'grade':      grade,
        'verdict':    verdict,
        'alignment':  align_type,
        'breakdown':  breakdown,
    }
