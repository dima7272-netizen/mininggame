'use client';

import { useEffect, useRef } from 'react';

export type ChartSeries = {
  label: string;
  color: string;
  values: number[];
  dash?: number[];
  opacity?: number;
  lineWidth?: number;
  pointRadius?: number;
};

export type ChartBand = {
  color: string;
  before: number[];
  after: number[];
};

type Scale = {
  minimum: number;
  maximum: number;
  step: number;
  ticks: number[];
};

export function LineChart({
  labels,
  series,
  bands = [],
  ariaLabel,
  xAxisLabel = 'Номер комнаты',
  yAxisLabel = 'Значение · log₁₀',
  height = 560,
}: {
  labels: string[];
  series: ChartSeries[];
  bands?: ChartBand[];
  ariaLabel: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scroll = scrollRef.current;
    if (!canvas || !scroll) return;

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const padding = { left: 88, right: 32, top: 32, bottom: 80 };
      const minimumRoomWidth = 26;
      const minimumChartWidth = padding.left + padding.right + Math.max(labels.length - 1, 1) * minimumRoomWidth;
      const width = Math.max(scroll.clientWidth, minimumChartWidth, 420);

      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const allValues = series.flatMap((item) => item.values).filter(Number.isFinite);
      const scale = getNiceScale(allValues);
      const scaleRange = scale.maximum - scale.minimum;
      const textColor = getCssColor('--chart-label', '#596273');
      const gridColor = getCssColor('--grid-line', '#cfd4dd');
      const axisColor = getCssColor('--axis-line', '#aeb5c1');
      const surfaceColor = getCssColor('--surface', '#ffffff');
      const xForIndex = (index: number) => padding.left + (plotWidth * index) / Math.max(labels.length - 1, 1);
      const yForValue = (value: number) => padding.top + plotHeight - ((value - scale.minimum) / scaleRange) * plotHeight;

      context.save();
      context.strokeStyle = gridColor;
      context.lineWidth = 1;
      context.setLineDash([4, 5]);

      scale.ticks.forEach((tick) => {
        const y = yForValue(tick);
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(width - padding.right, y);
        context.stroke();
      });

      labels.forEach((_, index) => {
        const x = xForIndex(index);
        context.save();
        context.globalAlpha = index % 5 === 4 || index === 0 || index === labels.length - 1 ? 1 : 0.58;
        context.beginPath();
        context.moveTo(x, padding.top);
        context.lineTo(x, padding.top + plotHeight);
        context.stroke();
        context.restore();
      });
      context.restore();

      context.save();
      context.beginPath();
      context.rect(padding.left, padding.top, plotWidth, plotHeight);
      context.clip();
      bands.forEach((band) => {
        const pointCount = Math.min(labels.length, band.before.length, band.after.length);
        if (pointCount < 2) return;
        context.beginPath();
        band.after.slice(0, pointCount).forEach((value, index) => {
          const x = xForIndex(index);
          const y = yForValue(value);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        for (let index = pointCount - 1; index >= 0; index -= 1) {
          context.lineTo(xForIndex(index), yForValue(band.before[index]));
        }
        context.closePath();
        context.fillStyle = band.color;
        context.globalAlpha = 0.12;
        context.fill();
      });
      context.restore();

      context.save();
      context.strokeStyle = axisColor;
      context.lineWidth = 1.25;
      context.setLineDash([]);
      context.strokeRect(padding.left, padding.top, plotWidth, plotHeight);
      context.restore();

      context.fillStyle = textColor;
      context.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textAlign = 'right';
      context.textBaseline = 'middle';
      scale.ticks.forEach((tick) => {
        context.fillText(formatAxisValue(tick, scale.step), padding.left - 16, yForValue(tick));
      });

      context.font = '700 14px Inter, Manrope, ui-sans-serif, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      labels.forEach((label, index) => {
        context.fillText(label, xForIndex(index), padding.top + plotHeight + 16);
      });

      context.font = '700 14px Inter, Manrope, ui-sans-serif, sans-serif';
      context.fillText(xAxisLabel, padding.left + plotWidth / 2, height - 20);
      context.save();
      context.translate(20, padding.top + plotHeight / 2);
      context.rotate(-Math.PI / 2);
      context.fillText(yAxisLabel, 0, 0);
      context.restore();

      context.save();
      context.beginPath();
      context.rect(padding.left, padding.top, plotWidth, plotHeight);
      context.clip();
      series.forEach((item) => {
        context.save();
        context.beginPath();
        context.strokeStyle = item.color;
        context.globalAlpha = item.opacity ?? 1;
        context.lineWidth = item.lineWidth ?? 4;
        context.setLineDash(item.dash ?? []);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        item.values.forEach((value, index) => {
          const x = xForIndex(index);
          const y = yForValue(value);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.stroke();

        const pointRadius = item.pointRadius ?? 2.8;
        if (pointRadius > 0) {
          context.setLineDash([]);
          item.values.forEach((value, index) => {
            const x = xForIndex(index);
            const y = yForValue(value);
            context.beginPath();
            context.fillStyle = surfaceColor;
            context.arc(x, y, pointRadius + 1.7, 0, Math.PI * 2);
            context.fill();
            context.beginPath();
            context.fillStyle = item.color;
            context.arc(x, y, pointRadius, 0, Math.PI * 2);
            context.fill();
          });
        }
        context.restore();
      });
      context.restore();
    };

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(scroll);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [bands, height, labels, series, xAxisLabel, yAxisLabel]);

  return (
    <div className="canvas-chart" role="img" aria-label={ariaLabel}>
      <div className="canvas-scroll" ref={scrollRef}>
        <canvas ref={canvasRef} />
      </div>
      <div className="canvas-legend">
        {series.map((item) => <span key={item.label}><i className={item.dash ? 'dashed' : ''} style={item.dash ? { borderTopColor: item.color } : { background: item.color }} />{item.label}</span>)}
      </div>
    </div>
  );
}

export function getNiceScale(values: number[], targetIntervals = 6): Scale {
  if (values.length === 0) {
    return { minimum: 0, maximum: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  }

  const dataMinimum = Math.min(...values);
  const dataMaximum = Math.max(...values);
  const rawRange = Math.max(dataMaximum - dataMinimum, Math.abs(dataMaximum) * 0.1, 1);
  const roughStep = rawRange / targetIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = factor * magnitude;
  const minimum = Math.floor(dataMinimum / step) * step;
  let maximum = Math.ceil(dataMaximum / step) * step;
  if (maximum === minimum) maximum += step;

  const ticks: number[] = [];
  const tickCount = Math.round((maximum - minimum) / step);
  for (let index = 0; index <= tickCount; index += 1) {
    ticks.push(Number((minimum + index * step).toPrecision(12)));
  }
  return { minimum, maximum, step, ticks };
}

function formatAxisValue(value: number, step: number) {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))));
  return value.toFixed(decimals).replace('.', ',');
}

function getCssColor(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
