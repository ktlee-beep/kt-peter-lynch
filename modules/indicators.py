"""
기술 지표 모음
─────────────────────────────────────────
MA 체계 (일봉 ↔ 주봉 환산)
  5일  ↔  1주  : 단기 (주중 흐름)
  20일 ↔  5주  : 심리선 ★ 매수허들/익절기준
  60일 ↔ 13주  : 수급선 (분기)
 120일 ↔ 26주  : 경기선 (반기)
 200일 ↔ 40주  : 연간선 ★ 장기 대세
"""
import math


# ── 단순 이동평균 ──────────────────────────────────────────────
def ma(prices: list, n: int) -> list:
    if len(prices) < n:
        return []
    return [sum(prices[i:i+n]) / n for i in range(len(prices) - n + 1)]


# ── RSI ────────────────────────────────────────────────────────
def rsi(prices: list, n: int = 14) -> float | None:
    if len(prices) < n + 1:
        return None
    d = [prices[i] - prices[i-1] for i in range(1, len(prices))]
    g = sum(max(x, 0) for x in d[-n:]) / n
    l = sum(max(-x, 0) for x in d[-n:]) / n
    return round(100 - 100 / (1 + g / l), 1) if l else 100.0


# ── 지수 이동평균 ──────────────────────────────────────────────
def ema(prices: list, n: int) -> list:
    if len(prices) < n:
        return []
    result = [sum(prices[:n]) / n]
    k = 2 / (n + 1)
    for v in prices[n:]:
        result.append(v * k + result[-1] * (1 - k))
    return result


# ── MACD ───────────────────────────────────────────────────────
def macd(prices: list) -> dict | None:
    e12, e26 = ema(prices, 12), ema(prices, 26)
    if not e12 or not e26:
        return None
    diff = len(e12) - len(e26)
    ml = [e12[diff + i] - e26[i] for i in range(len(e26))]
    sl = ema(ml, 9)
    if not sl:
        return None
    cross = None
    if len(ml) >= 2 and len(sl) >= 2:
        if ml[-1] > sl[-1] and ml[-2] <= sl[-2]:
            cross = 'golden'
        elif ml[-1] < sl[-1] and ml[-2] >= sl[-2]:
            cross = 'dead'
    return {
        "lastCross":  cross,
        "macdLine":   ml[-20:],
        "signalLine": sl[-20:],
        "histogram":  [ml[-len(sl) + i] - sl[i] for i in range(len(sl))][-20:],
    }


# ── 볼린저 밴드 ────────────────────────────────────────────────
def bb(prices: list, n: int = 20) -> dict | None:
    if len(prices) < n:
        return None
    r = prices[-n:]
    m = sum(r) / n
    std = math.sqrt(sum((v - m) ** 2 for v in r) / n)
    u, l = m + 2 * std, m - 2 * std
    pb = (prices[-1] - l) / (u - l) * 100 if u != l else 50
    bw = (u - l) / m * 100 if m > 0 else 0
    return {"upper": round(u), "mid": round(m), "lower": round(l), "percentB": round(pb, 1), "bandwidth": round(bw, 1)}


# ── 정배열 / 역배열 판정 ───────────────────────────────────────
def check_alignment(price: float, ma_values: dict) -> dict:
    """
    정배열: 단기 > 중기 > 장기 이평선 순으로 배열 (상승 추세)
    역배열: 반대 배열 (하락 추세)

    ma_values 예시:
      {'ma5': 100, 'ma20': 95, 'ma60': 90, 'ma120': 85, 'ma200': 80}
      또는
      {'ma5w': 100, 'ma13w': 95, 'ma26w': 90, 'ma40w': 80}
    """
    vals = {k: v for k, v in ma_values.items() if v and v > 0}
    if not vals:
        return {'type': 'unknown', 'score': 0, 'detail': '데이터 없음'}

    # 일봉 기준
    keys_daily  = ['ma5', 'ma20', 'ma60', 'ma120', 'ma200']
    keys_weekly = ['ma5w', 'ma13w', 'ma26w', 'ma40w']

    ordered = []
    for k in keys_daily + keys_weekly:
        if k in vals:
            ordered.append(vals[k])

    if len(ordered) < 2:
        return {'type': 'unknown', 'score': 0, 'detail': 'MA 데이터 부족'}

    # 정배열 점수: 연속 감소(단기→장기) 비율
    bullish_pairs = sum(1 for i in range(len(ordered) - 1) if ordered[i] > ordered[i + 1])
    total_pairs   = len(ordered) - 1
    alignment_pct = bullish_pairs / total_pairs * 100

    # 현재가 위치
    above_all   = price > max(ordered)
    below_all   = price < min(ordered)
    above_short = price > ordered[0] if ordered else False

    if alignment_pct == 100 and above_all:
        atype   = '완전정배열'
        detail  = '모든 이평선 위 — 추세 최강 (피터린치 선호 구간)'
        score   = 100
    elif alignment_pct >= 75:
        atype   = '정배열'
        detail  = '단기→장기 이평선 우하향 배열 — 상승 추세'
        score   = 80
    elif alignment_pct >= 50:
        atype   = '부분정배열'
        detail  = '혼재 배열 — 추세 전환 중'
        score   = 50
    elif alignment_pct <= 25:
        atype   = '역배열'
        detail  = '장기선이 단기선 위 — 하락 추세 (매수 금지)'
        score   = 10
    else:
        atype   = '부분역배열'
        detail  = '장기 하락 추세 혼재 — 관망'
        score   = 25

    return {
        'type':          atype,
        'score':         score,
        'detail':        detail,
        'alignment_pct': round(alignment_pct, 0),
        'above_all_ma':  above_all,
        'below_all_ma':  below_all,
    }
