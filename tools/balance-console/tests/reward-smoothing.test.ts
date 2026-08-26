import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildRoomEconomy, log10ForChart } from '../lib/analytics';
import { parseKnownConfigs } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { buildRewardExpansion, removeGodlyRewardsAndExtendTo50 } from '../lib/reward-expansion';
import {
  buildCleanRewardLifecycles,
  buildRisingRewardLifecycles,
  buildSmoothRewardPrices,
  buildStraightRewardTrajectory,
  smoothRewardPrices,
} from '../lib/reward-smoothing';
import { retiredRewardItemIds } from '../lib/reward-groups';
import { serializeRoomDrops } from '../lib/reward-progression';
import { validateConfigs } from '../lib/validation';

describe('smooth round reward prices', () => {
  const expanded = removeGodlyRewardsAndExtendTo50(seedConfigText);
  const result = buildSmoothRewardPrices(expanded);
  const known = parseKnownConfigs(result.configs);
  const economy = buildRoomEconomy(result.configs);

  it('keeps one steadily growing reward trajectory without cliffs', () => {
    const steps = economy.slice(1).map((room, index) => (
      log10ForChart(room.expectedItemPrice) - log10ForChart(economy[index].expectedItemPrice)
    ));
    expect(steps.every((step) => step > 0)).toBe(true);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.17);
    expect(result.report.maximumLogStepDeviation).toBeLessThan(0.12);
  });

  it('uses readable whole prices and keeps normalized integer drop weights', () => {
    expect(known.sellItems.every((item) => /^\d+$/.test(item.sellPrice))).toBe(true);
    expect(known.sellItems.every((item) => readableMantissa(item.sellPrice))).toBe(true);
    known.roomDrops.forEach((room) => {
      expect(room.drops).toHaveLength(8);
      expect(room.drops.every((drop) => /^(?:0|[1-9]\d*)$/.test(drop.weight))).toBe(true);
      expect(room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
    });
  });

  it('removes low-percentage tails from cheaper rewards', () => {
    const dirtyKnown = parseKnownConfigs(result.configs);
    dirtyKnown.roomDrops[0].drops = dirtyKnown.roomDrops[0].drops.map((drop, index) => ({
      ...drop,
      weight: String([2, 28, 22, 16, 12, 8, 6, 6][index]),
    }));
    const dirty = { ...result.configs, RoomDrops: serializeRoomDrops(dirtyKnown.roomDrops) };
    const cleaned = buildCleanRewardLifecycles(dirty);
    const cleanedKnown = parseKnownConfigs(cleaned.configs);
    expect(cleaned.configs).not.toBe(dirty);
    cleanedKnown.roomDrops.forEach((room) => {
      const weights = room.drops.map((drop) => Number(drop.weight));
      expect(weights.every((weight, index) => index === 0 || weights[index - 1] >= weight)).toBe(true);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBe(100);
    });
    expect(cleaned.report.maximumTypesPerRoom).toBe(8);
    expect(cleaned.report.maximumLogStepDeviation).toBeLessThan(0.16);
    expect(validateConfigs(cleaned.configs).errorCount).toBe(0);
    expect(buildCleanRewardLifecycles(cleaned.configs).configs).toBe(cleaned.configs);
  });

  it('keeps Godly rewards retired, validates and is idempotent', () => {
    expect(known.sellItems.some((item) => retiredRewardItemIds.includes(item.id))).toBe(false);
    expect(validateConfigs(result.configs).errorCount).toBe(0);
    expect(smoothRewardPrices(result.configs)).toBe(result.configs);
  });

  it('gives every visible reward a rising whole-number lifecycle ending at 50%', () => {
    const clean = buildCleanRewardLifecycles(result.configs);
    const rebuilt = buildRisingRewardLifecycles(clean.configs);
    const rebuiltKnown = parseKnownConfigs(rebuilt.configs);
    const expectedRoomWeights = [50, 13, 9, 7, 6, 5, 4, 3, 2, 1];
    const expectedLifecycle = [1, 2, 3, 4, 5, 6, 7, 9, 13, 50];

    expect(rebuiltKnown.rooms).toHaveLength(56);
    expect(rebuiltKnown.roomDrops).toHaveLength(56);
    expect(rebuiltKnown.sellItems).toHaveLength(65);
    rebuiltKnown.roomDrops.forEach((room, roomOffset) => {
      expect(room.index).toBe(roomOffset + 1);
      expect(room.drops).toHaveLength(10);
      expect(room.drops.map((drop) => Number(drop.weight))).toEqual(expectedRoomWeights);
      expect(room.drops.reduce((sum, drop) => sum + Number(drop.weight), 0)).toBe(100);
      expect(room.drops.map((drop) => drop.itemId)).toEqual(
        rebuiltKnown.sellItems.slice(roomOffset, roomOffset + 10).map((item) => item.id),
      );
    });

    const weightsByItem = new Map<string, number[]>();
    rebuiltKnown.roomDrops.forEach((room) => room.drops.forEach((drop) => {
      weightsByItem.set(drop.itemId, [...(weightsByItem.get(drop.itemId) ?? []), Number(drop.weight)]);
    }));
    rebuiltKnown.sellItems.slice(9, -9).forEach((item) => {
      expect(weightsByItem.get(item.id)).toEqual(expectedLifecycle);
    });
    weightsByItem.forEach((weights) => {
      expect(weights.every((weight, index) => index === 0 || weights[index - 1] < weight)).toBe(true);
    });

    const economy = buildRoomEconomy(rebuilt.configs);
    const steps = economy.slice(1).map((room, index) => (
      log10ForChart(room.expectedItemPrice) - log10ForChart(economy[index].expectedItemPrice)
    ));
    expect(steps.every((step) => step > 0)).toBe(true);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.2);
    expect(rebuilt.report.maximumTypesPerRoom).toBe(10);
    expect(validateConfigs(rebuilt.configs).errorCount).toBe(0);
    expect(buildRisingRewardLifecycles(rebuilt.configs).configs).toBe(rebuilt.configs);
  });

  it('follows the drawn straight reward trajectory with readable round prices', () => {
    const rising = buildRisingRewardLifecycles(buildCleanRewardLifecycles(result.configs).configs);
    const straight = buildStraightRewardTrajectory(rising.configs);
    const straightKnown = parseKnownConfigs(straight.configs);
    const economy = buildRoomEconomy(straight.configs);
    const rewardLogs = economy.map((room) => log10ForChart(room.expectedItemPrice));
    const steps = rewardLogs.slice(1).map((value, index) => value - rewardLogs[index]);

    expect(rewardLogs[0]).toBeGreaterThan(1.5);
    expect(rewardLogs[0]).toBeLessThan(1.7);
    expect(rewardLogs.at(-1)).toBeGreaterThan(23.3);
    expect(rewardLogs.at(-1)).toBeLessThan(23.7);
    expect(steps.every((step) => step > 0)).toBe(true);
    expect(straight.report.averageGrowth).toBeCloseTo(2.5, 1);
    expect(straight.report.maximumLogStepDeviation).toBeLessThan(0.05);
    expect(straightKnown.sellItems.every((item) => /^\d+$/.test(item.sellPrice))).toBe(true);
    expect(straightKnown.sellItems.every((item) => readableMantissa(item.sellPrice))).toBe(true);
    expect(straightKnown.roomDrops).toEqual(parseKnownConfigs(rising.configs).roomDrops);
    expect(validateConfigs(straight.configs).errorCount).toBe(0);
    expect(buildRewardExpansion(straight.configs).configs).toBe(straight.configs);
    expect(buildStraightRewardTrajectory(straight.configs).configs).toBe(straight.configs);
  });
});

function readableMantissa(value: string) {
  const price = new Decimal(value);
  const exponent = Decimal.floor(Decimal.log(price, 10));
  return ['1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '7'].includes(
    price.div(new Decimal(10).pow(exponent)).toSignificantDigits(2).toString(),
  );
}
