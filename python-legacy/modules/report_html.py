# -*- coding: utf-8 -*-
"""
종목 리포트 HTML 렌더러
────────────────────────────────────────────
generate_report() 결과를 증권사 리서치 리포트 스타일 HTML로 변환
"""


def render_report_html(r: dict) -> str:
    """report dict → 풀 HTML 문서"""

    # ── 기본값 ───────────────────────────────────────────────────
    name    = r.get('name', r.get('code', '-'))
    code    = r.get('code', '-')
    market  = r.get('market', 'KRX')
    date    = r.get('generated_at', '')[:10]
    rating  = r.get('rating', '-')
    score   = r.get('score', 0)
    signal  = r.get('signal', '-')

    price  = r.get('current_price', 0)
    tp     = r.get('target_price', 0)
    sl     = r.get('stop_loss', 0)
    up_pct = r.get('upside_pct', 0)
    dn_pct = r.get('downside_pct', 0)
    rr     = r.get('rr_ratio', 0)

    ma5w   = r.get('ma5w', 0) or 0
    ma40w  = r.get('ma40w', 0) or 0
    ma20   = r.get('ma20', 0) or 0
    ma60   = r.get('ma60', 0) or 0
    rsi    = r.get('rsi', 0) or 0
    atr    = r.get('atr', 0) or 0
    macd_c = r.get('macd_cross') or '-'
    vol_r  = r.get('vol_ratio', 0) or 0
    avg_v  = r.get('avg_vol_20d', 0) or 0
    last_v = r.get('last_vol', 0) or 0

    above5w  = r.get('above5w')
    above40w = r.get('above40w')
    aln      = r.get('alignment', '-')
    trend    = r.get('long_trend', '-')

    h20 = r.get('high_20d', 0) or 0
    l20 = r.get('low_20d', 0) or 0
    h52 = r.get('high_52w', 0) or 0
    l52 = r.get('low_52w', 0) or 0

    disclosures = r.get('recent_disclosures', [])

    # ── 색상 ─────────────────────────────────────────────────────
    rating_color = {'매수': '#0abf53', '적극매수': '#f39c12', '중립': '#7f8c8d'}.get(rating, '#7f8c8d')
    signal_color = {'매수신호': '#0abf53', '안착확인': '#27ae60', '진입대기': '#f39c12', '관망': '#95a5a6'}.get(signal, '#95a5a6')
    rsi_color    = '#e74c3c' if rsi > 70 else ('#f39c12' if rsi > 65 else '#0abf53' if 45 <= rsi <= 65 else '#e67e22')
    macd_color   = '#0abf53' if macd_c == 'golden' else ('#e74c3c' if macd_c == 'dead' else '#7f8c8d')

    def badge(text, color='#0abf53', light=False):
        bg = color + '18' if light else color
        tc = color if light else '#fff'
        return f'<span style="background:{bg};color:{tc};padding:3px 10px;border-radius:20px;font-size:0.8rem;font-weight:700;">{text}</span>'

    def arrow(above):
        if above is True:  return '<span style="color:#0abf53">▲ 상회</span>'
        if above is False: return '<span style="color:#e74c3c">▼ 하회</span>'
        return '<span style="color:#95a5a6">- 미확인</span>'

    def pct_bar(ratio, max_r=5.0, color='#0abf53'):
        w = min(int(ratio / max_r * 100), 100)
        return f'<div style="background:#eee;border-radius:4px;height:8px;width:100%;"><div style="background:{color};width:{w}%;height:8px;border-radius:4px;transition:width .5s;"></div></div>'

    # ── 가격 레벨 시각화 ─────────────────────────────────────────
    def price_level_bar():
        levels = [
            (h52,  '52주 최고가', '#e74c3c'),
            (h20,  '20일 최고가', '#e67e22'),
            (tp,   '목표주가',   '#0abf53'),
            (price,'현재가',     '#2c3e50'),
            (sl,   '손절가',     '#e74c3c'),
            (l20,  '20일 최저가','#7f8c8d'),
            (l52,  '52주 최저가','#95a5a6'),
        ]
        valid = [(v, lbl, c) for v, lbl, c in levels if v > 0]
        if not valid:
            return '<p style="color:#95a5a6;font-size:0.85rem;">가격 데이터 없음</p>'

        high_v = max(v for v, _, _ in valid)
        low_v  = min(v for v, _, _ in valid)
        rng    = high_v - low_v if high_v != low_v else 1

        rows = []
        for v, lbl, c in valid:
            pct_pos = (v - low_v) / rng * 100
            is_cur  = lbl == '현재가'
            bold    = 'font-weight:700;' if is_cur else ''
            border  = f'border:2px solid {c};' if is_cur else ''
            rows.append(f'''
              <div style="display:flex;align-items:center;gap:8px;margin:5px 0;">
                <div style="width:85px;font-size:0.75rem;color:#555;text-align:right;{bold}">{lbl}</div>
                <div style="flex:1;position:relative;height:20px;">
                  <div style="position:absolute;left:{pct_pos:.1f}%;transform:translateX(-50%);
                              background:{c};color:#fff;font-size:0.7rem;font-weight:700;
                              padding:2px 6px;border-radius:3px;{border}white-space:nowrap;">
                    {v:,}원
                  </div>
                </div>
              </div>''')
        return ''.join(rows)

    # ── 투자 포인트 ───────────────────────────────────────────────
    def make_points():
        pts = []
        icons = ['①','②','③','④','⑤','⑥','⑦']
        if above5w:
            pts.append(f'5주선({ma5w:,}원) 상회 — 단기 상승 추세 진입')
        if above40w:
            pts.append(f'40주선({ma40w:,}원) 상회 — 중장기 상승 추세 유효')
        if signal == '매수신호':
            pts.append('주봉 5주선 골든크로스 매수신호 발생')
        elif signal == '안착확인':
            pts.append('5주선 안착 확인 — 추세 안정화 진행 중')
        elif signal == '진입대기':
            pts.append('5주선 진입 대기 — 매수 타이밍 임박')
        if vol_r >= 1.5:
            pts.append(f'거래량 {vol_r:.2f}배 급증 — 강한 수급 유입 신호')
        if 48 <= rsi <= 65:
            pts.append(f'RSI {rsi:.1f} — 과열 없는 적정 모멘텀 구간')
        if macd_c == 'golden':
            pts.append('MACD 골든크로스 — 단기 매수 모멘텀 확인')
        if not pts:
            pts.append('복수 기술 지표 동시 충족')
        rows = []
        for i, pt in enumerate(pts):
            ic = icons[i] if i < len(icons) else '▸'
            rows.append(f'''
              <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;">
                <span style="color:#0abf53;font-size:1.1rem;font-weight:700;min-width:20px;">{ic}</span>
                <span style="font-size:0.9rem;color:#2c3e50;line-height:1.5;">{pt}</span>
              </div>''')
        return ''.join(rows)

    # ── 리스크 요인 ───────────────────────────────────────────────
    def make_risks():
        risks = [
            f'5주선({ma5w:,}원) 하향 이탈 시 추세 약화 → 손절 고려',
            'KOSPI/KOSDAQ 시장 전체 하락 시 동반 하락 위험',
        ]
        if not above40w:
            risks.append('40주선 하회 중 — 중장기 하락 구조 가능성')
        if rsi > 70:
            risks.append(f'RSI {rsi:.1f} — 단기 과열 구간, 조정 출현 가능')
        if vol_r > 5:
            risks.append(f'거래량 {vol_r:.1f}배 — 단기 급등 후 차익실현 물량 주의')
        if aln in ('부분역배열', '역배열'):
            risks.append('이평선 역배열 — 추세 전환 확인 전 분할매수 권고')
        rows = []
        for r_ in risks:
            rows.append(f'''
              <div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid #f0f0f0;">
                <span style="color:#e74c3c;font-size:1rem;">▪</span>
                <span style="font-size:0.875rem;color:#555;">{r_}</span>
              </div>''')
        return ''.join(rows)

    # ── 공시 ─────────────────────────────────────────────────────
    def make_disclosures():
        if not disclosures:
            return '<p style="color:#95a5a6;font-size:0.85rem;padding:10px 0;">최근 90일 내 공시 없음 또는 DART 조회 불가</p>'
        rows = []
        for d in disclosures:
            dt = d.get('date', '')
            dt_fmt = f"{dt[:4]}.{dt[4:6]}.{dt[6:8]}" if len(dt) == 8 else dt
            rows.append(f'''
              <div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f0f0f0;align-items:start;">
                <span style="color:#95a5a6;font-size:0.8rem;min-width:70px;">{dt_fmt}</span>
                <span style="font-size:0.875rem;color:#2c3e50;">{d.get('title','-')}</span>
              </div>''')
        return ''.join(rows)

    # ── RSI 게이지 ───────────────────────────────────────────────
    rsi_pct = min(max(int(rsi), 0), 100)
    score_pct = min(score, 100)

    # ── HTML 본문 ─────────────────────────────────────────────────
    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{name} ({code}) 리서치 리포트</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
  *{{box-sizing:border-box;margin:0;padding:0;}}
  body{{font-family:'Noto Sans KR',sans-serif;background:#f0f2f5;color:#2c3e50;}}
  .wrap{{max-width:960px;margin:0 auto;padding:20px;}}
  /* Header */
  .hdr{{background:linear-gradient(135deg,#0f3460 0%,#16213e 100%);
        border-radius:16px;padding:28px 32px;color:#fff;margin-bottom:20px;
        box-shadow:0 8px 32px rgba(15,52,96,.25);}}
  .hdr-top{{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;}}
  .hdr-corp{{font-size:1.7rem;font-weight:900;letter-spacing:-0.5px;}}
  .hdr-sub{{font-size:0.9rem;opacity:.75;margin-top:4px;}}
  .hdr-rating{{text-align:right;}}
  .rating-badge{{display:inline-block;background:{rating_color};color:#fff;
                 font-size:1.1rem;font-weight:900;padding:6px 20px;
                 border-radius:30px;margin-bottom:6px;}}
  .hdr-date{{font-size:0.8rem;opacity:.7;}}
  /* Key Metrics */
  .metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px;}}
  @media(max-width:640px){{.metrics{{grid-template-columns:repeat(2,1fr);}}}}
  .metric-card{{background:#fff;border-radius:12px;padding:18px 20px;
               box-shadow:0 2px 12px rgba(0,0,0,.06);text-align:center;}}
  .metric-label{{font-size:0.75rem;color:#95a5a6;font-weight:500;margin-bottom:6px;letter-spacing:.5px;}}
  .metric-value{{font-size:1.45rem;font-weight:900;color:#2c3e50;}}
  .metric-sub{{font-size:0.8rem;margin-top:4px;font-weight:700;}}
  /* Cards */
  .grid2{{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;}}
  @media(max-width:640px){{.grid2{{grid-template-columns:1fr;}}}}
  .grid3{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px;}}
  @media(max-width:640px){{.grid3{{grid-template-columns:1fr;}}}}
  .card{{background:#fff;border-radius:12px;padding:20px 22px;
         box-shadow:0 2px 12px rgba(0,0,0,.06);}}
  .card-title{{font-size:0.8rem;font-weight:700;color:#95a5a6;letter-spacing:1px;
               text-transform:uppercase;margin-bottom:14px;padding-bottom:10px;
               border-bottom:2px solid #f0f0f0;}}
  /* Score */
  .score-wrap{{text-align:center;padding:10px 0;}}
  .score-num{{font-size:3.5rem;font-weight:900;color:#0abf53;line-height:1;}}
  .score-max{{font-size:1rem;color:#95a5a6;}}
  .score-bar-wrap{{background:#f0f0f0;border-radius:8px;height:12px;margin:12px 0 6px;overflow:hidden;}}
  .score-bar{{height:12px;border-radius:8px;
              background:linear-gradient(90deg,#0abf53,#00d2d3);
              width:{score_pct}%;transition:width 1s;}}
  /* Gauge */
  .gauge-wrap{{position:relative;width:120px;height:70px;margin:0 auto;overflow:hidden;}}
  .gauge-bg{{fill:none;stroke:#f0f0f0;stroke-width:12;stroke-linecap:round;}}
  .gauge-fill{{fill:none;stroke-width:12;stroke-linecap:round;transition:stroke-dashoffset 1s;}}
  .gauge-val{{position:absolute;bottom:0;left:50%;transform:translateX(-50%);
              font-size:1.1rem;font-weight:900;}}
  /* MA table */
  .ma-table{{width:100%;border-collapse:collapse;font-size:0.875rem;}}
  .ma-table td{{padding:8px 4px;border-bottom:1px solid #f5f5f5;}}
  .ma-table td:last-child{{text-align:right;}}
  .ma-name{{color:#95a5a6;font-size:0.8rem;}}
  .ma-val{{font-weight:700;color:#2c3e50;}}
  /* Price level */
  .price-track{{padding:10px 0 0;min-height:180px;}}
  /* Vol */
  .vol-num{{font-size:1.3rem;font-weight:900;color:#2c3e50;margin-bottom:4px;}}
  .vol-sub{{font-size:0.75rem;color:#95a5a6;margin-bottom:10px;}}
  /* Full-width card */
  .card-full{{margin-bottom:20px;}}
  /* Disclaimer */
  .disc{{background:#fff;border-radius:12px;padding:16px 22px;margin-top:20px;
         border:1px solid #ecf0f1;}}
  .disc p{{font-size:0.78rem;color:#95a5a6;line-height:1.6;}}
  /* Print */
  @media print{{body{{background:#fff;}} .wrap{{padding:0;max-width:100%;}}
                .card,.hdr,.metric-card{{box-shadow:none;border:1px solid #ddd;}}}}
</style>
</head>
<body>
<div class="wrap">

<!-- ── 헤더 ── -->
<div class="hdr">
  <div class="hdr-top">
    <div>
      <div class="hdr-corp">{name}</div>
      <div class="hdr-sub">{code} &nbsp;·&nbsp; {market} &nbsp;·&nbsp; {badge(aln,'#00d2d3',True)} &nbsp;{badge(signal, signal_color, True)}</div>
    </div>
    <div class="hdr-rating">
      <div class="rating-badge">{rating}</div>
      <div class="hdr-date">리포트 기준일 {date}</div>
    </div>
  </div>
</div>

<!-- ── 핵심 지표 ── -->
<div class="metrics">
  <div class="metric-card">
    <div class="metric-label">현재주가</div>
    <div class="metric-value">{price:,}</div>
    <div class="metric-sub" style="color:#95a5a6;">원</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">목표주가</div>
    <div class="metric-value" style="color:#0abf53;">{tp:,}</div>
    <div class="metric-sub" style="color:#0abf53;">+{up_pct:.1f}% 업사이드</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">손절가</div>
    <div class="metric-value" style="color:#e74c3c;">{sl:,}</div>
    <div class="metric-sub" style="color:#e74c3c;">-{dn_pct:.1f}% 리스크</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">리스크/리워드</div>
    <div class="metric-value" style="color:#9b59b6;">1 : {rr}</div>
    <div class="metric-sub" style="color:#95a5a6;">종합점수 {score}점</div>
  </div>
</div>

<!-- ── 투자포인트 + 목표가 시각화 ── -->
<div class="grid2">
  <div class="card">
    <div class="card-title">투자 포인트</div>
    {make_points()}
  </div>
  <div class="card">
    <div class="card-title">가격 레벨</div>
    <div class="price-track">{price_level_bar()}</div>
  </div>
</div>

<!-- ── 종합점수 + RSI + MACD ── -->
<div class="grid3">
  <div class="card">
    <div class="card-title">종합점수</div>
    <div class="score-wrap">
      <div class="score-num">{score}<span class="score-max">점</span></div>
      <div class="score-bar-wrap"><div class="score-bar"></div></div>
      <div style="font-size:0.78rem;color:#95a5a6;">{score_pct} / 100점</div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">RSI (14일)</div>
    <div style="text-align:center;padding:8px 0;">
      <svg viewBox="0 0 120 70" width="120" height="70" style="display:block;margin:0 auto;">
        <path d="M 10 60 A 50 50 0 0 1 110 60" class="gauge-bg"/>
        <path d="M 10 60 A 50 50 0 0 1 110 60"
              class="gauge-fill"
              stroke="{rsi_color}"
              stroke-dasharray="157"
              stroke-dashoffset="{int(157 * (1 - rsi_pct/100))}"/>
        <text x="60" y="58" text-anchor="middle"
              style="font-family:Noto Sans KR,sans-serif;font-size:14px;font-weight:700;fill:{rsi_color};">{rsi:.1f}</text>
      </svg>
      <div style="font-size:0.75rem;color:#95a5a6;margin-top:4px;">
        {'과열 주의' if rsi > 70 else ('과매도' if rsi < 30 else '적정 구간 ✓')}
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">MACD / ATR</div>
    <div style="padding:4px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-size:0.85rem;color:#555;">MACD 크로스</span>
        {badge('골든크로스' if macd_c=='golden' else ('데드크로스' if macd_c=='dead' else '-'),
               '#0abf53' if macd_c=='golden' else ('#e74c3c' if macd_c=='dead' else '#95a5a6'))}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:0.85rem;color:#555;">ATR (일변동폭)</span>
        <span style="font-weight:700;">{atr:,}원</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:0.85rem;color:#555;">장기 추세</span>
        <span style="font-weight:700;color:{'#0abf53' if '상승' in trend else '#e74c3c'};">{trend}</span>
      </div>
    </div>
  </div>
</div>

<!-- ── 이동평균선 ── -->
<div class="grid2">
  <div class="card">
    <div class="card-title">이동평균선</div>
    <table class="ma-table">
      <tr>
        <td><span class="ma-name">5주선</span></td>
        <td class="ma-val">{ma5w:,}원</td>
        <td>{arrow(above5w)}</td>
      </tr>
      <tr>
        <td><span class="ma-name">40주선</span></td>
        <td class="ma-val">{ma40w:,}원</td>
        <td>{arrow(above40w)}</td>
      </tr>
      <tr>
        <td><span class="ma-name">MA 20일</span></td>
        <td class="ma-val">{ma20:,}원</td>
        <td>{arrow(price > ma20 if ma20 else None)}</td>
      </tr>
      <tr>
        <td><span class="ma-name">MA 60일</span></td>
        <td class="ma-val">{ma60:,}원</td>
        <td>{arrow(price > ma60 if ma60 else None)}</td>
      </tr>
    </table>
  </div>
  <div class="card">
    <div class="card-title">수급 분석</div>
    <div class="vol-num">{last_v:,}<span style="font-size:0.9rem;font-weight:400;color:#95a5a6;"> 주</span></div>
    <div class="vol-sub">최근 거래량</div>
    <div style="margin-bottom:10px;">{pct_bar(vol_r, 5.0, '#3498db')}</div>
    <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:#555;margin-bottom:8px;">
      <span>20일 평균 {avg_v:,}주</span>
      <span style="font-weight:700;color:#3498db;">{vol_r:.2f}배</span>
    </div>
    <div style="text-align:right;">
      {badge(_vol_label(vol_r), '#3498db')}
    </div>
  </div>
</div>

<!-- ── DART 공시 ── -->
<div class="card card-full">
  <div class="card-title">최근 공시 (90일 이내)</div>
  {make_disclosures()}
</div>

<!-- ── 리스크 요인 ── -->
<div class="card card-full">
  <div class="card-title">리스크 요인</div>
  {make_risks()}
</div>

<!-- ── 목표가 산정 근거 ── -->
<div class="card card-full">
  <div class="card-title">목표주가 산정 근거</div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:8px 0;">
    <div style="text-align:center;padding:12px;background:#f9f9f9;border-radius:8px;">
      <div style="font-size:0.75rem;color:#95a5a6;margin-bottom:6px;">현재주가</div>
      <div style="font-size:1.3rem;font-weight:900;">{price:,}원</div>
    </div>
    <div style="text-align:center;padding:12px;background:#f0faf5;border-radius:8px;border:2px solid #0abf53;">
      <div style="font-size:0.75rem;color:#0abf53;font-weight:700;margin-bottom:6px;">목표주가 +{up_pct:.1f}%</div>
      <div style="font-size:1.3rem;font-weight:900;color:#0abf53;">{tp:,}원</div>
    </div>
    <div style="text-align:center;padding:12px;background:#fef9f9;border-radius:8px;border:2px solid #e74c3c;">
      <div style="font-size:0.75rem;color:#e74c3c;font-weight:700;margin-bottom:6px;">손절가 -{dn_pct:.1f}%</div>
      <div style="font-size:1.3rem;font-weight:900;color:#e74c3c;">{sl:,}원</div>
    </div>
  </div>
  <div style="margin-top:14px;padding:12px;background:#f9f9f9;border-radius:8px;font-size:0.85rem;color:#555;line-height:1.8;">
    <b>산정 방식:</b> 5주선 상향 추세 + 정배열 구조 기준 기술적 상승 여력 분석<br>
    종합점수 <b>{score}점</b> → 스코어 구간별 기대 업사이드 <b>{up_pct:.0f}%</b> 적용<br>
    손절가: 5주선 하단 3% 기준 + 최근 20일 저가 기준 중 보수적 가격 채택<br>
    <b>리스크/리워드 = {up_pct:.1f}% ÷ {dn_pct:.1f}% = 1 : {rr}</b>
  </div>
</div>

<!-- ── 면책 ── -->
<div class="disc">
  <p>※ 본 리포트는 기술적 분석 기반의 자동 생성 리포트입니다. 공개된 시장 데이터(pykrx, DART)를 활용하며,
  증권사 공식 리서치 리포트와 다릅니다. 투자 손실에 대한 책임은 투자자 본인에게 있습니다.<br>
  생성일시: {r.get('generated_at','')[:19]}</p>
</div>

</div>
</body>
</html>"""
    return html


def _vol_label(ratio: float) -> str:
    if ratio >= 5.0: return '폭발적 수급'
    if ratio >= 3.0: return '강한 수급 유입'
    if ratio >= 2.0: return '수급 증가'
    if ratio >= 1.5: return '거래 양호'
    if ratio >= 1.0: return '평균 수준'
    return '거래 부진'


# ─────────────────────────────────────────────────────────────
#  메인 검색 페이지
# ─────────────────────────────────────────────────────────────
def render_index_html() -> str:
    """메인 종목 검색 + 스캔 결과 + 시황 뉴스 페이지"""
    return """<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KT 피터린치 주식 분석 시스템</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Noto Sans KR',sans-serif;background:#f0f2f5;color:#2c3e50;}
.wrap{max-width:1100px;margin:0 auto;padding:20px;}

/* ── 헤더 ── */
.hdr{background:linear-gradient(135deg,#0f3460,#16213e);border-radius:16px;
     padding:28px 36px;color:#fff;margin-bottom:24px;
     box-shadow:0 8px 32px rgba(15,52,96,.3);}
.hdr h1{font-size:1.6rem;font-weight:900;letter-spacing:-0.5px;}
.hdr p{opacity:.7;font-size:.9rem;margin-top:6px;}

/* ── 검색 박스 ── */
.search-box{background:#fff;border-radius:14px;padding:24px 28px;
            box-shadow:0 2px 16px rgba(0,0,0,.08);margin-bottom:24px;}
.search-row{display:flex;gap:12px;flex-wrap:wrap;}
.search-row input{flex:1;min-width:160px;padding:12px 18px;font-size:1rem;
                  border:2px solid #e0e0e0;border-radius:10px;
                  font-family:'Noto Sans KR',sans-serif;outline:none;
                  transition:border-color .2s;}
.search-row input:focus{border-color:#0abf53;}
.btn{padding:12px 24px;border:none;border-radius:10px;font-size:.95rem;
     font-weight:700;cursor:pointer;font-family:'Noto Sans KR',sans-serif;
     transition:all .2s;}
.btn-primary{background:#0abf53;color:#fff;}
.btn-primary:hover{background:#08a844;}
.btn-scan{background:#0f3460;color:#fff;}
.btn-scan:hover{background:#16213e;}
.btn-stop{background:#e74c3c;color:#fff;}
.search-hint{font-size:.78rem;color:#95a5a6;margin-top:10px;}
.search-hint a{color:#0abf53;cursor:pointer;text-decoration:underline;}

/* ── 탭 ── */
.tabs{display:flex;gap:4px;margin-bottom:16px;}
.tab{padding:8px 20px;border-radius:8px;font-size:.85rem;font-weight:700;
     cursor:pointer;border:none;font-family:'Noto Sans KR',sans-serif;
     background:#fff;color:#95a5a6;transition:all .2s;}
.tab.active{background:#0f3460;color:#fff;}

/* ── 로딩 ── */
.loading{text-align:center;padding:40px;color:#95a5a6;font-size:.9rem;}
.spinner{width:36px;height:36px;border:4px solid #f0f0f0;
         border-top-color:#0abf53;border-radius:50%;
         animation:spin .8s linear infinite;margin:0 auto 12px;}
@keyframes spin{to{transform:rotate(360deg);}}

/* ── 스캔 진행 ── */
.progress-bar{background:#f0f0f0;border-radius:8px;height:10px;margin:10px 0;overflow:hidden;}
.progress-fill{height:10px;border-radius:8px;background:linear-gradient(90deg,#0abf53,#00d2d3);
               transition:width .5s;}
.scan-status{background:#fff;border-radius:12px;padding:18px 22px;
             box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:16px;}

/* ── 결과 테이블 ── */
.result-table{width:100%;border-collapse:collapse;font-size:.85rem;}
.result-table th{background:#f8f9fa;padding:10px 12px;text-align:left;
                 font-weight:700;color:#555;border-bottom:2px solid #e0e0e0;
                 white-space:nowrap;}
.result-table td{padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:middle;}
.result-table tr:hover td{background:#fafffe;}
.score-pill{display:inline-block;padding:3px 10px;border-radius:20px;
            font-weight:700;font-size:.78rem;color:#fff;}
.rating-pill{display:inline-block;padding:2px 8px;border-radius:12px;
             font-size:.75rem;font-weight:700;}
.link-btn{padding:4px 12px;border-radius:6px;background:#0f3460;color:#fff;
          font-size:.75rem;font-weight:700;text-decoration:none;cursor:pointer;
          border:none;font-family:'Noto Sans KR',sans-serif;}
.link-btn:hover{background:#0abf53;}

/* ── 뉴스 ── */
.news-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;}
.news-card{background:#fff;border-radius:12px;padding:16px 18px;
           box-shadow:0 2px 8px rgba(0,0,0,.06);}
.news-tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.72rem;
          font-weight:700;margin-bottom:8px;}
.news-title{font-size:.875rem;font-weight:700;color:#2c3e50;line-height:1.5;
            margin-bottom:6px;}
.news-meta{font-size:.75rem;color:#95a5a6;}
.news-title a{color:inherit;text-decoration:none;}
.news-title a:hover{color:#0abf53;}

/* ── 시황 지수 ── */
.index-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px;}
.index-card{background:#fff;border-radius:10px;padding:14px 16px;
            box-shadow:0 2px 8px rgba(0,0,0,.06);text-align:center;}
.index-name{font-size:.75rem;color:#95a5a6;margin-bottom:4px;}
.index-val{font-size:1.15rem;font-weight:900;}
.index-chg{font-size:.8rem;font-weight:700;margin-top:2px;}
.up{color:#0abf53;} .dn{color:#e74c3c;}

/* ── 카드 ── */
.section-card{background:#fff;border-radius:14px;padding:20px 24px;
              box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:20px;}
.section-title{font-size:.8rem;font-weight:700;color:#95a5a6;letter-spacing:1px;
               text-transform:uppercase;margin-bottom:16px;padding-bottom:10px;
               border-bottom:2px solid #f0f0f0;}
</style>
</head>
<body>
<div class="wrap">

<!-- 헤더 -->
<div class="hdr">
  <h1>KT 피터린치 주식 분석 시스템</h1>
  <p>KOSPI · KOSDAQ 전종목 기술적 분석 + 증권사 리서치 리포트 자동 생성</p>
</div>

<!-- 검색 -->
<div class="search-box">
  <div class="search-row">
    <input id="codeInput" type="text" placeholder="종목코드 또는 종목명 (예: 005930, 삼성전자)" maxlength="20"
           onkeydown="if(event.key==='Enter')searchReport()">
    <button class="btn btn-primary" onclick="searchReport()">리포트 조회</button>
    <button class="btn btn-scan" onclick="startScan()">전종목 스캔</button>
    <button class="btn btn-stop" onclick="stopScan()">스캔 중지</button>
  </div>
  <div class="search-hint">
    빠른 예시:
    <a onclick="quickSearch('005930')">삼성전자</a> ·
    <a onclick="quickSearch('000660')">SK하이닉스</a> ·
    <a onclick="quickSearch('035420')">NAVER</a> ·
    <a onclick="quickSearch('105560')">KB금융</a> ·
    <a onclick="quickSearch('456010')">아이씨티케이</a>
  </div>
</div>

<!-- 탭 -->
<div class="tabs">
  <button class="tab active" id="tab-scan" onclick="showTab('scan')">스캔 결과</button>
  <button class="tab" id="tab-news" onclick="showTab('news')">시황 &amp; 뉴스</button>
</div>

<!-- 스캔 탭 -->
<div id="panel-scan">
  <div id="scanStatus"></div>
  <div class="section-card">
    <div class="section-title">스캔 결과 — Top 50</div>
    <div id="scanResults"><div class="loading"><div class="spinner"></div>결과를 불러오는 중...</div></div>
  </div>
</div>

<!-- 뉴스 탭 -->
<div id="panel-news" style="display:none;">
  <div class="section-card">
    <div class="section-title">글로벌 시장 지수</div>
    <div id="marketIndices"><div class="loading"><div class="spinner"></div>시장 데이터 로드 중...</div></div>
  </div>
  <div class="section-card">
    <div class="section-title">시황 &amp; 뉴스 (국내외)</div>
    <div id="newsContainer"><div class="loading"><div class="spinner"></div>뉴스 수집 중...</div></div>
  </div>
</div>

</div>

<script>
// ── 탭 전환 ─────────────────────────────────────────────────
function showTab(t) {
  ['scan','news'].forEach(id => {
    document.getElementById('panel-'+id).style.display = id===t?'':'none';
    document.getElementById('tab-'+id).classList.toggle('active', id===t);
  });
  if(t==='news') loadNews();
}

// ── 종목 검색 ─────────────────────────────────────────────
function quickSearch(code) {
  document.getElementById('codeInput').value = code;
  searchReport();
}

function searchReport() {
  let q = document.getElementById('codeInput').value.trim();
  if(!q) return;
  // 6자리 코드로 변환
  if(/^\\d+$/.test(q)) q = q.padStart(6,'0');
  window.open('/report/' + q, '_blank');
}

// ── 스캔 제어 ─────────────────────────────────────────────
let scanTimer = null;

function startScan() {
  fetch('/api/scan/start?min_score=50&quick=true')
    .then(r=>r.json())
    .then(d=>{
      document.getElementById('scanStatus').innerHTML =
        '<div class="scan-status"><b>스캔 시작!</b> ' + JSON.stringify(d) + '</div>';
      if(scanTimer) clearInterval(scanTimer);
      scanTimer = setInterval(pollScan, 5000);
      pollScan();
    });
}

function stopScan() {
  fetch('/api/scan/stop',{method:'POST'})
    .then(r=>r.json())
    .then(()=>{ if(scanTimer){clearInterval(scanTimer);scanTimer=null;} pollScan(); });
}

function pollScan() {
  fetch('/api/scan/status').then(r=>r.json()).then(s=>{
    const pct = s.percent || 0;
    const html = `
      <div class="scan-status">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
          <span>${s.running?'🔄 스캔 중...':'✅ 스캔 완료'} &nbsp; <b>${s.current||''}</b></span>
          <span style="font-weight:700;">${pct}% (${s.progress||0}/${s.total||0})</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div style="font-size:.8rem;color:#95a5a6;margin-top:4px;">
          발견 종목: <b>${s.results_count||0}개</b>
          ${s.finished_at ? ' · 완료: '+s.finished_at.slice(0,19) : ''}
        </div>
      </div>`;
    document.getElementById('scanStatus').innerHTML = html;
    if(!s.running && scanTimer){clearInterval(scanTimer);scanTimer=null;}
    loadScanResults();
  });
}

// ── 스캔 결과 로드 ─────────────────────────────────────────
function loadScanResults() {
  fetch('/api/scan/results').then(r=>r.json()).then(data=>{
    const results = data.results || [];
    if(!results.length) {
      document.getElementById('scanResults').innerHTML =
        '<div class="loading">스캔 결과 없음 — 전종목 스캔을 실행하세요</div>';
      return;
    }
    const ratingColor = {매수:'#0abf53',적극매수:'#f39c12',중립:'#7f8c8d'};
    const rows = results.map(r => {
      const sc = r.score;
      const scColor = sc>=90?'#e74c3c':sc>=80?'#f39c12':sc>=70?'#0abf53':'#3498db';
      const rat = r.rating||'중립';
      const tp = r.target_price ? r.target_price.toLocaleString()+'원' : '-';
      const sl = r.stop_loss ? r.stop_loss.toLocaleString()+'원' : '-';
      const up = r.upside_pct != null ? '+'+r.upside_pct+'%' : '';
      return `<tr>
        <td><span class="score-pill" style="background:${scColor}">${sc}</span></td>
        <td><b>${r.name}</b><br><span style="color:#95a5a6;font-size:.75rem;">${r.code} · ${r.market}</span></td>
        <td style="font-weight:700;">${(r.price||0).toLocaleString()}원</td>
        <td style="color:#0abf53;font-weight:700;">${tp} <span style="font-size:.75rem;">${up}</span></td>
        <td style="color:#e74c3c;font-weight:700;">${sl}</td>
        <td><span class="rating-pill" style="background:${ratingColor[rat]||'#7f8c8d'};color:#fff;">${rat}</span></td>
        <td>${r.signal||'-'}</td>
        <td style="color:${(r.vol_ratio||0)>=2?'#e67e22':'inherit'}">${r.vol_ratio||'-'}x</td>
        <td><button class="link-btn" onclick="window.open('/report/${r.code}','_blank')">리포트</button></td>
      </tr>`;
    }).join('');
    document.getElementById('scanResults').innerHTML = `
      <div style="overflow-x:auto;">
        <table class="result-table">
          <thead><tr>
            <th>점수</th><th>종목</th><th>현재가</th>
            <th>목표가</th><th>손절가</th><th>의견</th>
            <th>신호</th><th>거래량</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });
}

// ── 뉴스 & 시황 ────────────────────────────────────────────
function loadNews() {
  loadMarketIndices();
  loadNewsFeeds();
}

function loadMarketIndices() {
  fetch('/api/market/indices').then(r=>r.json()).then(data=>{
    const cards = data.map(d=>{
      const chg = d.change >= 0 ? '+'+d.change.toFixed(2) : d.change.toFixed(2);
      const pct = d.change_pct >= 0 ? '+'+d.change_pct.toFixed(2)+'%' : d.change_pct.toFixed(2)+'%';
      const cls = d.change >= 0 ? 'up' : 'dn';
      return `<div class="index-card">
        <div class="index-name">${d.name}</div>
        <div class="index-val ${cls}">${d.value.toLocaleString()}</div>
        <div class="index-chg ${cls}">${chg} (${pct})</div>
      </div>`;
    }).join('');
    document.getElementById('marketIndices').innerHTML = '<div class="index-grid">'+cards+'</div>';
  }).catch(()=>{
    document.getElementById('marketIndices').innerHTML = '<p style="color:#95a5a6;font-size:.85rem;">시장 데이터 로드 실패</p>';
  });
}

function loadNewsFeeds() {
  fetch('/api/market/news').then(r=>r.json()).then(data=>{
    const tagColor = {국내:'#0abf53',미국:'#3498db',글로벌:'#9b59b6',경제:'#f39c12',군사:'#e74c3c'};
    const cards = data.map(n=>{
      const tc = tagColor[n.tag]||'#95a5a6';
      return `<div class="news-card">
        <span class="news-tag" style="background:${tc}18;color:${tc}">${n.tag}</span>
        <div class="news-title">
          ${n.url ? '<a href="'+n.url+'" target="_blank">'+n.title+'</a>' : n.title}
        </div>
        <div class="news-meta">${n.source||''} · ${n.date||''}</div>
      </div>`;
    }).join('');
    document.getElementById('newsContainer').innerHTML = '<div class="news-grid">'+cards+'</div>';
  }).catch(()=>{
    document.getElementById('newsContainer').innerHTML = '<p style="color:#95a5a6;font-size:.85rem;">뉴스 로드 실패</p>';
  });
}

// ── 초기화 ─────────────────────────────────────────────────
window.addEventListener('load', ()=>{
  pollScan();
  setInterval(pollScan, 15000);
});
</script>
</body>
</html>"""
