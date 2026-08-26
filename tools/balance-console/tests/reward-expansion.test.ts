import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildRoomEconomy } from '../lib/analytics';
import { parseKnownConfigs } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { buildRewardExpansion, removeGodlyRewardsAndExtendTo50 } from '../lib/reward-expansion';
import { retiredRewardItemIds, rewardHierarchyItemIds } from '../lib/reward-groups';
import { validateConfigs } from '../lib/validation';

describe('Godly reward retirement and fifty-room expansion', () => {
  const result = buildRewardExpansion(seedConfigText);
  const known = parseKnownConfigs(result.configs);

  it('removes all ten Godly rewards and keeps the remaining rarity hierarchy', () => {
    expect(result.report.retiredItemIds).toEqual(retiredRewardItemIds);
    expect(known.sellItems).toHaveLength(65);
    expect(known.sellItems.map((item) => item.id)).toEqual(rewardHierarchyItemIds);
    expect(known.sellItems.some((item) => retiredRewardItemIds.includes(item.id))).toBe(false);
    expect(known.roomDrops.some((room) => room.drops.some((drop) => retiredRewardItemIds.includes(drop.itemId)))).toBe(false);
  });

  it('stretches all active rewards through room 50 with whole percentages', () => {
    expect(known.rooms).toHaveLength(50);
    expect(known.roomDrops).toHaveLength(50);
    expect(new Set(known.roomDrops.flatMap((room) => room.drops.map((drop) => drop.itemId)))).toEqual(new Set(rewardHierarchyItemIds));
    known.roomDrops.forEach((room) => {
      expect(room.drops).toHaveLength(8);
      expect(room.drops.every((drop) => /^(?:0|[1-9]\d*)$/.test(drop.weight))).toBe(true);
      expect(room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0)).equals(100)).toBe(true);
    });
  });

  it('keeps existing expected rewards close and continues growth in rooms 47–50', () => {
    const before = buildRoomEconomy(seedConfigText);
    const after = buildRoomEconomy(result.configs);
    const deviations = before.map((room, index) => (
      new Decimal(after[index].expectedItemPrice).minus(room.expectedItemPrice).abs().div(room.expectedItemPrice).mul(100).toNumber()
    ));
    expect(Math.max(...deviations)).toBeLessThan(8);
    expect(after.slice(46).every((room, index) => index === 0 || new Decimal(room.expectedItemPrice).greaterThan(after[45 + index].expectedItemPrice))).toBe(true);
    expect(new Decimal(known.rooms[46].blockMaxHP).greaterThan(known.rooms[45].blockMaxHP)).toBe(true);
    expect(new Decimal(known.rooms[49].blockMaxHP).greaterThan(known.rooms[48].blockMaxHP)).toBe(true);
  });

  it('is publishable and idempotent', () => {
    expect(validateConfigs(result.configs).errorCount).toBe(0);
    expect(removeGodlyRewardsAndExtendTo50(result.configs)).toBe(result.configs);
  });
});
