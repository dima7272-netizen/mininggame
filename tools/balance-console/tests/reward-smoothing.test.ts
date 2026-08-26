import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildRoomEconomy, log10ForChart } from '../lib/analytics';
import { parseKnownConfigs } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { removeGodlyRewardsAndExtendTo50 } from '../lib/reward-expansion';
import { buildSmoothRewardPrices, smoothRewardPrices } from '../lib/reward-smoothing';
import { retiredRewardItemIds } from '../lib/reward-groups';
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
      expect(room.drops.length).toBeGreaterThanOrEqual(8);
      expect(room.drops.length).toBeLessThanOrEqual(9);
      expect(room.drops.every((drop) => /^(?:0|[1-9]\d*)$/.test(drop.weight))).toBe(true);
      expect(room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
    });
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
