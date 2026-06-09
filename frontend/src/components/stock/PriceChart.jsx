import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts';

export default function PriceChart({ candles, ma5arr, ma20arr, ma60arr }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !candles?.length) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: {
        vertLine: { color: '#64748b', labelBackgroundColor: '#1e293b' },
        horzLine: { color: '#64748b', labelBackgroundColor: '#1e293b' },
      },
      timeScale: {
        borderColor: '#334155',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#334155',
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    candleSeries.setData(
      candles.map(c => ({
        time: Math.floor(c.t / 1000),
        open: c.o, high: c.h, low: c.l, close: c.c,
      }))
    );

    const times = candles.map(c => Math.floor(c.t / 1000));

    if (ma5arr?.length) {
      const ma5 = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      ma5.setData(times.slice(-ma5arr.length).map((t, i) => ({ time: t, value: ma5arr[i] })).filter(p => p.value != null));
    }
    if (ma20arr?.length) {
      const ma20 = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      ma20.setData(times.slice(-ma20arr.length).map((t, i) => ({ time: t, value: ma20arr[i] })).filter(p => p.value != null));
    }
    if (ma60arr?.length) {
      const ma60 = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      ma60.setData(times.slice(-ma60arr.length).map((t, i) => ({ time: t, value: ma60arr[i] })).filter(p => p.value != null));
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, ma5arr, ma20arr, ma60arr]);

  if (!candles?.length) {
    return <div className="h-52 bg-surface-900 rounded-xl animate-pulse mx-4" />;
  }

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between px-4 mb-2">
        <h3 className="text-sm font-semibold text-slate-300">가격 차트</h3>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="flex items-center gap-1"><span className="w-3 h-px bg-yellow-400 inline-block" />5일</span>
          <span className="flex items-center gap-1"><span className="w-3 h-px bg-blue-400 inline-block" />20일</span>
          <span className="flex items-center gap-1"><span className="w-3 h-px bg-purple-400 inline-block" />60일</span>
        </div>
      </div>
      <div ref={containerRef} className="w-full h-52" />
    </section>
  );
}
