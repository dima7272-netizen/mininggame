import { describe, expect, it } from 'vitest';
import { getMonotoneBezierSegments, getMonotoneTrend, getNiceScale } from '../components/line-chart';

describe('chart scale', () => {
  it('creates readable round ticks around the room progression data', () => {
    expect(getNiceScale([1.3, 8.5, 16, 23, 30.1])).toEqual({
      minimum: 0,
      maximum: 35,
      step: 5,
      ticks: [0, 5, 10, 15, 20, 25, 30, 35],
    });
  });

  it('keeps a non-zero domain for a flat series', () => {
    const scale = getNiceScale([4, 4, 4]);
    expect(scale.maximum).toBeGreaterThan(scale.minimum);
    expect(scale.ticks.length).toBeGreaterThan(1);
  });

  it('provides a fallback scale without data', () => {
    expect(getNiceScale([]).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('smooths a sharp bend without overshooting any real data interval', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 10 },
      { x: 2, y: 11 },
      { x: 3, y: 12 },
    ];
    const segments = getMonotoneBezierSegments(points);

    expect(segments).toHaveLength(points.length - 1);
    segments.forEach((segment, index) => {
      const start = points[index];
      const end = points[index + 1];
      const minimum = Math.min(start.y, end.y);
      const maximum = Math.max(start.y, end.y);
      expect(segment.control1.y).toBeGreaterThanOrEqual(minimum);
      expect(segment.control1.y).toBeLessThanOrEqual(maximum);
      expect(segment.control2.y).toBeGreaterThanOrEqual(minimum);
      expect(segment.control2.y).toBeLessThanOrEqual(maximum);
      expect(segment.end).toEqual(end);
    });
  });

  it('builds a visible monotone trend through sparse progression anchors', () => {
    const raw = [0, 5, 10, 11, 12];
    const trend = getMonotoneTrend(raw, [0, 2, 4]);

    expect(trend[0]).toBe(0);
    expect(trend[2]).toBe(10);
    expect(trend[4]).toBe(12);
    expect(trend[1]).not.toBe(raw[1]);
    expect(trend.every((value, index) => index === 0 || value >= trend[index - 1])).toBe(true);
  });
});
