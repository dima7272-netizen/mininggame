import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseKnownConfigs } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { buildReadableRewardPrices, serializeReadableSellItems } from '../lib/reward-pricing';

const known = parseKnownConfigs(seedConfigText);

describe('readable reward prices', () => {
  it('keeps the source price order and assigns clear integer steps', () => {
    const prices = buildReadableRewardPrices([
      { id: 'Cardboard_C', sellPrice: '5.4' },
      { id: 'DinosaurEgg_C', sellPrice: '28.92836825' },
      { id: 'PirateHat_u', sellPrice: '32.5936777' },
      { id: 'Handle_C', sellPrice: '33.8562344' },
      { id: 'barrel_C', sellPrice: '39.01898701' },
      { id: 'crate-bottles_u', sellPrice: '126.9731498' },
      { id: 'pot-stew_u', sellPrice: '144.9169607' },
      { id: 'cannon-mobile_u', sellPrice: '145.3820907' },
      { id: 'Low Poly_r', sellPrice: '196.7310788' },
      { id: 'Burger_C', sellPrice: '212.26752' },
      { id: 'Guitar_u', sellPrice: '237.3776869' },
      { id: 'ship-wreck_r', sellPrice: '737.9881826' },
      { id: 'ship-pirate-small_r', sellPrice: '761.1580135' },
    ]);
    expect(prices.slice(0, 13).map((item) => item.sellPrice)).toEqual([
      '10', '30', '40', '50', '70', '120', '150', '200', '250', '300', '400', '700', '1000',
    ]);
    prices.forEach((item, index) => {
      expect(item.sellPrice).toMatch(/^\d+$/);
      if (index === 0) return;
      const ratio = new Decimal(item.sellPrice).div(prices[index - 1].sellPrice);
      expect(ratio.greaterThanOrEqualTo(1.2)).toBe(true);
    });
  });

  it('serializes every price as an exact integer without decimal fractions', () => {
    const prices = buildReadableRewardPrices(known.sellItems);
    const serialized = serializeReadableSellItems(known.sellSettings, prices);
    const parsed = parseKnownConfigs({ ...seedConfigText, SellItems: serialized });
    expect(parsed.sellItems.map((item) => item.id)).toEqual(prices.map((item) => item.id));
    expect(parsed.sellItems.every((item) => /^\d+$/.test(item.sellPrice))).toBe(true);
  });
});
