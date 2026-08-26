import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildRoomEconomy, log10ForChart } from '../lib/analytics';
import { parseKnownConfigs } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { removeGodlyRewardsAndExtendTo50 } from '../lib/reward-expansion';
import { buildCleanRewardLifecycles, buildSmoothRewardPrices, smoothRewardPrices } from '../lib/reward-smoothing';
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
});

function readableMantissa(value: string) {
  const price = new Decimal(value);
  const exponent = Decimal.floor(Decimal.log(price, 10));
  return ['1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '7'].includes(
    price.div(new Decimal(10).pow(exponent)).toSignificantDigits(2).toString(),
  );
}
