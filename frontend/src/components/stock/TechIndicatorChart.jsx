import { useState, useEffect, useRef } from 'react';
import { createChart, LineSeries, HistogramSeries } from 'lightweight-charts';

// ── Indicator computation ────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const result = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function ema(arr, period) {
  const k = 2 / (period + 1);
  const result = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  result[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) {
    result[i] = arr[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcMACD(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null
  );
  const macdValid = macdLine.map(v => v ?? 0);
  const signalLine = ema(macdValid, 9);
  const histogram = macdLine.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

function calcBollinger(closes, period = 20, mult = 2) {
  const upper = [], lower = [], mid = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); mid.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    mid.push(mean);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  }
  return { upper, lower, mid };
}

// ── Chart renderers ──────────────────────────────────────────────────
const CHART_OPTS = {
  layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
  grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
  rightPriceScale: { borderColor: '#1e293b' },
  timeScale: { borderColor: '#1e293b', timeVisible: true },
  handleScroll: true,
  handleScale: true,
};

function useChartSetup(containerRef, candles, buildSeries) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !candles?.length) return;

    const chart = createChart(el, { ...CHART_OPTS, width: el.clientWidth, height: 160 });
    buildSeries(chart, candles);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); };
  }, [candles]);
}

function RSIChart({ candles }) {
  const ref = useRef(null);
  useChartSetup(ref, candles, (chart, c) => {
    const times = c.map(d => Math.floor(d.t / 1000));
    const closes = c.map(d => d.c);
    const rsi = calcRSI(closes);

    const series = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1.5, priceLineVisible: false });
    series.setData(rsi.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean));

    series.createPriceLine({ price: 70, color: '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '과매수' });
    series.createPriceLine({ price: 30, color: '#22c55e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '과매도' });
    series.createPriceLine({ price: 50, color: '#475569', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  });
  return <div ref={ref} />;
}

function MACDChart({ candles }) {
  const ref = useRef(null);
  useChartSetup(ref, candles, (chart, c) => {
    const times = c.map(d => Math.floor(d.t / 1000));
    const closes = c.map(d => d.c);
    const { macdLine, signalLine, histogram } = calcMACD(closes);

    const histSeries = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
    });
    histSeries.setData(
      histogram.map((v, i) => v !== null ? { time: times[i], value: v, color: v >= 0 ? '#22c55e80' : '#ef444480' } : null).filter(Boolean)
    );

    const macdSeries = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    macdSeries.setData(macdLine.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean));

    const sigSeries = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    sigSeries.setData(signalLine.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean));
  });
  return <div ref={ref} />;
}

function BollingerChart({ candles }) {
  const ref = useRef(null);
  useChartSetup(ref, candles, (chart, c) => {
    const times = c.map(d => Math.floor(d.t / 1000));
    const closes = c.map(d => d.c);
    const { upper, mid, lower } = calcBollinger(closes);

    const mk = (color) => chart.addSeries(LineSeries, { color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    const upS = mk('#60a5fa80'), midS = mk('#94a3b8'), lowS = mk('#60a5fa80');

    const toData = (arr) => arr.map((v, i) => v !== null ? { time: times[i], value: v } : null).filter(Boolean);
    upS.setData(toData(upper));
    midS.setData(toData(mid));
    lowS.setData(toData(lower));

    const priceLine = chart.addSeries(LineSeries, { color: '#e2e8f0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    priceLine.setData(closes.map((v, i) => ({ time: times[i], value: v })));
  });
  return <div ref={ref} />;
}

// ── Main component ───────────────────────────────────────────────────
const TABS = ['RSI', 'MACD', '볼린저'];

export default function TechIndicatorChart({ candles }) {
  const [tab, setTab] = useState('RSI');
  if (!candles?.length) return null;

  return (
    <section className="px-4 mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-400">기술 지표</h3>
        <div className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
                tab === t ? 'bg-brand-500/20 text-brand-400' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-surface-900 rounded-xl overflow-hidden px-2 pt-2 pb-1">
        {tab === 'RSI' && (
          <>
            <RSIChart candles={candles} />
            <p className="text-[10px] text-slate-600 text-center mt-1">70 과매수 · 30 과매도</p>
          </>
        )}
        {tab === 'MACD' && (
          <>
            <MACDChart candles={candles} />
            <p className="text-[10px] text-slate-600 text-center mt-1">파란선 MACD · 주황선 시그널 · 막대 히스토그램</p>
          </>
        )}
        {tab === '볼린저' && (
          <>
            <BollingerChart candles={candles} />
            <p className="text-[10px] text-slate-600 text-center mt-1">MA20 ± 2σ 볼린저밴드</p>
          </>
        )}
      </div>
    </section>
  );
}
