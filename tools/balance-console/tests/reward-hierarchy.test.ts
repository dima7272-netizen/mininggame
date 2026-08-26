import { describe, expect, it } from 'vitest';
import { parseKnownConfigs } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { arrangeRewardsByGameHierarchy } from '../lib/reward-hierarchy';
import { rewardHierarchyItemIds } from '../lib/reward-groups';
import { serializeReadableSellItems } from '../lib/reward-pricing';

describe('reward hierarchy arrangement', () => {
  it('reassigns the existing price ladder to the exact game hierarchy', () => {
    const known = parseKnownConfigs(seedConfigText);
    const interleaved = [...known.sellItems.slice(0, 8)].reverse().concat(known.sellItems.slice(8));
    const source = {
      ...seedConfigText,
      SellItems: serializeReadableSellItems(known.sellSettings, interleaved),
    };
    const beforePrices = parseKnownConfigs(source).sellItems.map((item) => item.sellPrice).sort();
    const arranged = arrangeRewardsByGameHierarchy(source);
    const after = parseKnownConfigs(arranged).sellItems;

    expect(after.map((item) => item.id)).toEqual(rewardHierarchyItemIds);
    expect(after.map((item) => item.sellPrice).sort()).toEqual(beforePrices);
  });

  it('does not create another change when the hierarchy is already correct', () => {
    expect(arrangeRewardsByGameHierarchy(seedConfigText)).toBe(seedConfigText);
  });
});
