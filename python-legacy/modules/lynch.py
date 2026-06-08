"""
피터 린치 지표 모듈
─────────────────────────────────────────
핵심 철학:
  "주가는 기업의 과거 일기" — 기술적 신호 + 펀더멘털을 함께 볼 것
  로봇이 못하는 것 = 기업의 미래 통찰 (PEG가 낮아도 성장이 없으면 의미 없음)

핵심 지표:
  PEG     = PER / EPS성장률  (1 이하 = 저평가, 린치 최우선 기준)
  EPS성장률 = 전년 대비 EPS 증가율
  PBR     = 청산가치 대비 (1 이하 = 안전마진 확보)
  배당수익률 = 하락 방어막
"""
from datetime import datetime, timedelta


def _date(days=0):
    return (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')


def get_lynch_metrics(code: str) -> dict:
    result = {
        'per': None, 'pbr': None, 'eps': None, 'bps': None,
        'div_yield': None, 'eps_growth': None, 'peg': None,
        'lynch_grade': None, 'lynch_detail': [], 'lynch_score': 0,
    }
    try:
        from pykrx import stock as krx
        today    = _date()
        year_ago = _date(365)

        # ── 오늘 펀더멘털 ──
        fi = krx.get_market_fundamental(today, today, code)
        if fi is None or fi.empty:
            fi = krx.get_market_fundamental(_date(10), today, code)

        if fi is not None and not fi.empty:
            row = fi.iloc[-1]
            result['per']       = round(float(row.get('PER', 0) or 0), 2)
            result['pbr']       = round(float(row.get('PBR', 0) or 0), 2)
            result['eps']       = int(float(row.get('EPS', 0) or 0))
            result['bps']       = int(float(row.get('BPS', 0) or 0))
            result['div_yield'] = round(float(row.get('DIV', 0) or 0), 2)

        # ── 1년 전 EPS (성장률 계산) ──
        fi_prev = krx.get_market_fundamental(year_ago, _date(355), code)
        if fi_prev is not None and not fi_prev.empty:
            eps_prev = float(fi_prev.iloc[-1].get('EPS', 0) or 0)
            eps_now  = result['eps'] or 0
            if eps_prev > 0 and eps_now:
                growth = (eps_now - eps_prev) / eps_prev * 100
                result['eps_growth'] = round(growth, 1)
                per = result['per'] or 0
                if per > 0 and growth > 0:
                    result['peg'] = round(per / growth, 2)

        # ── 피터 린치 채점 ──
        grade_score = 0
        details     = []

        peg       = result['peg']
        per       = result['per']  or 0
        pbr       = result['pbr']  or 0
        eps_g     = result['eps_growth']
        div_yield = result['div_yield'] or 0

        # PEG (핵심 — 35점)
        if peg is not None:
            if peg < 0.5:
                details.append(f'PEG {peg} — 극도 저평가 (린치 강력 매수)')
                grade_score += 35
            elif peg < 1.0:
                details.append(f'PEG {peg} — 저평가 (린치 매수 권장)')
                grade_score += 25
            elif peg < 1.5:
                details.append(f'PEG {peg} — 적정 가치')
                grade_score += 10
            else:
                details.append(f'PEG {peg} — 고평가 주의 (성장 대비 비쌈)')
        else:
            details.append('PEG 계산 불가 (EPS 역성장 또는 데이터 없음)')

        # EPS 성장률 (25점)
        if eps_g is not None:
            if eps_g >= 25:
                details.append(f'EPS 성장 {eps_g}% — Fast Grower (린치 최선호)')
                grade_score += 25
            elif eps_g >= 15:
                details.append(f'EPS 성장 {eps_g}% — 성장주')
                grade_score += 15
            elif eps_g >= 0:
                details.append(f'EPS 성장 {eps_g}% — 완만한 성장 (Stalwart)')
                grade_score += 5
            else:
                details.append(f'EPS 성장 {eps_g}% — EPS 역성장 주의 (린치 경고)')

        # PBR (15점)
        if 0 < pbr < 1.0:
            details.append(f'PBR {pbr} — 청산가치 이하 (안전마진 확보, 린치 선호)')
            grade_score += 15
        elif 0 < pbr < 2.0:
            details.append(f'PBR {pbr} — 적정 수준')
            grade_score += 5

        # 배당 (10점)
        if div_yield >= 4:
            details.append(f'배당수익률 {div_yield}% — 고배당 (하락 방어막)')
            grade_score += 10
        elif div_yield >= 2:
            details.append(f'배당수익률 {div_yield}% — 배당 양호')
            grade_score += 5

        # PER 절대값 보조 (10점)
        if 0 < per <= 10:
            details.append(f'PER {per} — 매우 저평가')
            grade_score += 10
        elif 0 < per <= 15:
            details.append(f'PER {per} — 저평가')
            grade_score += 5

        # ── 등급 ──
        if grade_score >= 60:   lynch_grade = 'Strong Buy'
        elif grade_score >= 40: lynch_grade = 'Buy'
        elif grade_score >= 20: lynch_grade = 'Hold'
        else:                   lynch_grade = 'Avoid'

        result.update({
            'lynch_grade':  lynch_grade,
            'lynch_detail': details,
            'lynch_score':  grade_score,
        })

    except Exception as e:
        result['error'] = str(e)

    return result
