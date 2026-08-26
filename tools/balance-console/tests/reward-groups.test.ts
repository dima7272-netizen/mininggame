import { describe, expect, it } from 'vitest';
import { parseKnownConfigs } from '../lib/config-model';
import Decimal from 'decimal.js';
import {
  getRewardGroup,
  originalRewardHierarchyItemIds,
  retiredRewardItemIds,
  rewardGroupManifest,
  rewardGroups,
  rewardHierarchyItemIds,
} from '../lib/reward-groups';
import { seedConfigText } from '../lib/generated/seed-configs';
import { spreadsheetPreviewSnapshot } from '../lib/source-snapshots';

describe('real reward groups from Roblox', () => {
  const known = parseKnownConfigs(spreadsheetPreviewSnapshot);

  it('keeps the exact rarity order from RarityConfig', () => {
    expect(rewardGroups.map((group) => group.id)).toEqual([
      'Common',
      'Uncommon',
      'Rare',
      'Epic',
      'Legendary',
      'Mythic',
      'Secret',
      'Divine',
      'Celestial',
    ]);
  });

  it('assigns every active SellItems reward to exactly one group', () => {
    const groupedIds = rewardGroups.flatMap((group) => group.itemIds);
    expect(new Set(groupedIds).size).toBe(groupedIds.length);
    expect(groupedIds.length).toBe(65);
    expect(retiredRewardItemIds.length).toBe(10);
    expect([...originalRewardHierarchyItemIds].sort()).toEqual(known.sellItems.map((item) => item.id).sort());
    expect(rewardGroupManifest.itemCount).toBe(groupedIds.length + retiredRewardItemIds.length);
    expect(rewardGroupManifest.groupCount).toBe(rewardGroups.length + 1);
  });

  it('uses the authoritative game paths and distinguishes Godly from Divine', () => {
    expect(rewardGroupManifest.source.rarityPath).toBe('ReplicatedStorage.Game.Rarities.RarityConfig');
    expect(rewardGroupManifest.source.itemPath).toBe('ReplicatedStorage.Game.Selling.SellItemConfig');
    expect(getRewardGroup('Toilet_G')).toBeUndefined();
    expect(retiredRewardItemIds).toContain('Toilet_G');
    expect(getRewardGroup('Flame_D')?.id).toBe('Divine');
    expect(getRewardGroup('Moon_S')?.id).toBe('Secret');
    expect(getRewardGroup('Vulcan_Ce')?.id).toBe('Celestial');
  });

  it('keeps every rarity as one contiguous ascending price block', () => {
    const current = parseKnownConfigs(seedConfigText).sellItems.filter((item) => !retiredRewardItemIds.includes(item.id));
    expect(current.map((item) => item.id)).toEqual(rewardHierarchyItemIds);
    for (let index = 1; index < current.length; index += 1) {
      expect(new Decimal(current[index].sellPrice).greaterThan(current[index - 1].sellPrice)).toBe(true);
    }
  });
});
