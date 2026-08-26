import { describe, expect, it } from 'vitest';
import { getNiceScale } from '../components/line-chart';

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
});
