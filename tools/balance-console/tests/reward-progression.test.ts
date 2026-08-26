import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseKnownConfigs } from '../lib/config-model';
import { parseExactJson, stringifyExactJson } from '../lib/exact-json';
import { seedConfigText } from '../lib/generated/seed-configs';
import {
  analyzeRewardProgression,
  cellKey,
  evaluateHardRemoval,
  generateRewardScheme,
  lifecycleTemplates,
  normalizeRoomDrop,
  probabilityAtLeastOnce,
  rewardStage,
  serializeRoomDrops,
  setRoomRewardWeight,
} from '../lib/reward-progression';

const known = parseKnownConfigs(seedConfigText);

describe('reward lifecycle analysis', () => {
  it('imports all 46 rooms, 75 rewards and 449 valid links without changing totals', () => {
    const itemIds = new Set(known.sellItems.map((item) => item.id));
    expect(known.roomDrops).toHaveLength(46);
    expect(known.sellItems).toHaveLength(75);
    expect(known.roomDrops.reduce((sum, room) => sum + room.drops.length, 0)).toBe(449);
    known.roomDrops.forEach((room) => {
      expect(room.drops.every((drop) => itemIds.has(drop.itemId))).toBe(true);
      expect(room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
    });
  });

  it('finds the first, peak and last rooms without changing the imported 449 rows', () => {
    const analysis = analyzeRewardProgression(known);
    const cardboard = analysis.lifecycleByItem.get('Cardboard_C');
    expect(known.roomDrops.reduce((sum, room) => sum + room.drops.length, 0)).toBe(449);
    expect(cardboard).toMatchObject({ firstRoom: 1, peakRoom: 1, lastRoom: 2, activeRoomCount: 2 });
    expect(rewardStage(cardboard, 1)).toBe('new');
    expect(rewardStage(cardboard, 2)).toBe('last');
    expect(rewardStage(cardboard, 3)).toBe('removed');
  });

  it('defines rising templates with a hard stop instead of a falling tail', () => {
    expect(Object.keys(lifecycleTemplates)).toEqual(['smooth', 'standard', 'fast']);
    Object.values(lifecycleTemplates).forEach((template) => {
      const peak = Math.max(...template.curve);
      expect(template.curve[template.highStage]).toBe(peak);
      expect(template.curve.every((value, index, values) => index === 0 || value >= values[index - 1])).toBe(true);
    });
  });

  it('reproduces the exact recommended nine-room 100% template', () => {
    expect(lifecycleTemplates.standard.curve).toEqual([1, 2, 3, 5, 8, 12, 17, 23, 29]);
    expect(lifecycleTemplates.standard.curve.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(lifecycleTemplates.standard.highRoomCount).toBe(1);
  });

  it('calculates the conditional 7–8 attempt table only from an explicit formula', () => {
    expect(probabilityAtLeastOnce(1, 7)).toBe(6.8);
    expect(probabilityAtLeastOnce(1, 8)).toBe(7.7);
    expect(probabilityAtLeastOnce(29, 7)).toBe(90.9);
    expect(probabilityAtLeastOnce(29, 8)).toBe(93.5);
  });
});

describe('exact deterministic normalization', () => {
  it('preserves locked weights and reaches exactly 100 with stable rounding', () => {
    const room = { index: 1, drops: [
      { itemId: 'A', weight: '33.3' },
      { itemId: 'B', weight: '20' },
      { itemId: 'C', weight: '10' },
    ] };
    const locks = new Set([cellKey(1, 'A')]);
    const first = normalizeRoomDrop(room, locks, '0.1');
    const second = normalizeRoomDrop(room, locks, '0.1');
    expect(first).toEqual(second);
    expect(first.drops.find((drop) => drop.itemId === 'A')?.weight).toBe('33.3');
    expect(first.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
  });

  it('blocks impossible locked sums above 100', () => {
    const room = { index: 9, drops: [{ itemId: 'A', weight: '70' }, { itemId: 'B', weight: '40' }] };
    expect(() => normalizeRoomDrop(room, new Set([cellKey(9, 'A'), cellKey(9, 'B')]))).toThrow('больше 100');
  });

  it('supports an exact manual edit with optional normalization', () => {
    const edited = setRoomRewardWeight(known.roomDrops, 1, 'Cardboard_C', '40', true, new Set());
    const room = edited.find((item) => item.index === 1);
    expect(room?.drops.find((drop) => drop.itemId === 'Cardboard_C')?.weight).not.toBe('25');
    expect(room?.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
  });

  it('keeps two simultaneous new rewards at or above 1%', () => {
    const normalized = normalizeRoomDrop({ index: 5, drops: [
      { itemId: 'new-a', weight: '1' },
      { itemId: 'new-b', weight: '1' },
      { itemId: 'old', weight: '98' },
    ] }, new Set(), '1', new Map([['new-a', '1'], ['new-b', '1']]));
    expect(Number(normalized.drops.find((drop) => drop.itemId === 'new-a')?.weight)).toBeGreaterThanOrEqual(1);
    expect(Number(normalized.drops.find((drop) => drop.itemId === 'new-b')?.weight)).toBeGreaterThanOrEqual(1);
    expect(normalized.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
  });
});

describe('safe hard removal', () => {
  const compactKnown = (afterWeight: string) => ({
    ...known,
    sellItems: [{ id: 'old', sellPrice: '100' }, { id: 'strong', sellPrice: '200' }, { id: 'weak', sellPrice: '50' }],
    roomDrops: [
      { index: 1, drops: [{ itemId: 'old', weight: '29' }, { itemId: 'strong', weight: '71' }] },
      { index: 2, drops: [{ itemId: 'strong', weight: afterWeight }, { itemId: 'weak', weight: new Decimal(100).minus(afterWeight).toString() }] },
    ],
  });

  it('allows 29% to become 0 only when a stronger replacement receives the full share', () => {
    const evaluation = evaluateHardRemoval(compactKnown('100'), 'old', 1, 29);
    expect(evaluation.safe).toBe(true);
    expect(evaluation.replacementWeight).toBe('29');
  });

  it('blocks a high-to-zero removal when the stronger replacement is insufficient', () => {
    const evaluation = evaluateHardRemoval(compactKnown('90'), 'old', 1, 29);
    expect(evaluation.safe).toBe(false);
    expect(evaluation.reasons.join(' ')).toContain('требуется не меньше 29');
  });
});

describe('automatic reward scheme', () => {
  const settings = {
    roomStart: 1,
    roomEnd: 46,
    templateId: 'standard' as const,
    maximumActive: 18,
    newRewardsPerRoom: 2,
    newRewardEvery: 1,
    minimumJackpotPercent: 1,
    minimumReplacementPercent: 29,
    precision: '1',
  };

  it('is deterministic, keeps every room full and respects the active-type limit', () => {
    const first = generateRewardScheme(known, settings);
    const second = generateRewardScheme(known, settings);
    expect(first).toEqual(second);
    first.forEach((room) => {
      expect(room.drops.length).toBeGreaterThan(0);
      expect(room.drops.length).toBeLessThanOrEqual(18);
      expect(room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
    });
  });

  it('refuses an impossible active-type limit instead of silently dropping or reappearing rewards', () => {
    expect(() => generateRewardScheme(known, { ...settings, maximumActive: 10 })).toThrow('полного жизненного цикла');
  });

  it('never rounds a newly introduced reward to zero', () => {
    const generated = generateRewardScheme(known, settings);
    const analysis = analyzeRewardProgression({ ...known, roomDrops: generated });
    analysis.lifecycles.filter((lifecycle) => lifecycle.firstRoom !== null).forEach((lifecycle) => {
      expect(new Decimal(lifecycle.placements[0].weight).greaterThanOrEqualTo(1)).toBe(true);
    });
  });

  it('starts room one with a pre-warmed ladder instead of inflating two rewards', () => {
    const generated = generateRewardScheme(known, settings);
    const firstRoom = generated.find((room) => room.index === 1);
    expect(firstRoom?.drops).toHaveLength(18);
    expect(Math.max(...(firstRoom?.drops.map((drop) => Number(drop.weight)) ?? []))).toBeLessThan(20);
    expect(firstRoom?.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
  });

  it('settles into the exact 1–2–3–5–8–12–17–23–29 ladder', () => {
    const generated = generateRewardScheme(known, settings);
    const room = generated.find((candidate) => candidate.index === 22);
    expect(room?.drops.map((drop) => Number(drop.weight)).sort((left, right) => left - right)).toEqual([1, 2, 3, 5, 8, 12, 17, 23, 29]);
  });

  it('never lowers a visible reward before its hard removal', () => {
    const generated = generateRewardScheme(known, settings);
    const analysis = analyzeRewardProgression({ ...known, roomDrops: generated });
    const complete = analysis.lifecycles.filter((lifecycle) => (
      lifecycle.firstRoom !== null
      && lifecycle.firstRoom > 1
      && lifecycle.lastRoom !== null
      && lifecycle.lastRoom < 46
      && lifecycle.activeRoomCount === lifecycleTemplates.standard.curve.length
    ));
    expect(complete.length).toBeGreaterThan(40);
    complete.forEach((lifecycle) => {
      lifecycle.placements.forEach((placement, index) => {
        if (index === 0) return;
        expect(new Decimal(placement.weight).greaterThanOrEqualTo(lifecycle.placements[index - 1].weight)).toBe(true);
      });
    });
  });

  it('fully removes an early reward after its lifecycle and preserves locked cells', () => {
    const locks = new Set([cellKey(1, 'Cardboard_C')]);
    const generated = generateRewardScheme(known, settings, locks);
    expect(generated.find((room) => room.index === 1)?.drops.find((drop) => drop.itemId === 'Cardboard_C')?.weight).toBe('25');
    expect(generated.find((room) => room.index === lifecycleTemplates.standard.curve.length + 2)?.drops.some((drop) => drop.itemId === 'Cardboard_C')).toBe(false);
  });

  it('round-trips generated RoomDrops through exact JSON without changing IDs or totals', () => {
    const generated = generateRewardScheme(known, settings);
    const serialized = serializeRoomDrops(generated);
    expect(stringifyExactJson(parseExactJson(serialized))).toBe(serialized);
    expect(serialized).toContain('Cardboard_C');
  });
});
