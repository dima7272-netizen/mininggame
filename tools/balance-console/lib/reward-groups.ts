import rewardGroupManifest from '../data/reward-groups.json';

export type RewardGroup = (typeof rewardGroupManifest.groups)[number];

export const rewardGroups = rewardGroupManifest.groups as readonly RewardGroup[];

export const rewardHierarchyItemIds = rewardGroups.flatMap((group) => group.itemIds);

const rewardGroupByItem = new Map<string, RewardGroup>(
  rewardGroups.flatMap((group) => group.itemIds.map((itemId) => [itemId, group] as const)),
);

const rewardHierarchyRankByItem = new Map(
  rewardHierarchyItemIds.map((itemId, index) => [itemId, index + 1] as const),
);

export function getRewardGroup(itemId: string): RewardGroup | undefined {
  return rewardGroupByItem.get(itemId);
}

export function getRewardHierarchyRank(itemId: string): number | undefined {
  return rewardHierarchyRankByItem.get(itemId);
}

export function rewardGroupGradient(group: RewardGroup): string {
  if (group.colors.length === 1) return group.colors[0];
  return `linear-gradient(110deg, ${group.colors.join(', ')})`;
}

export { rewardGroupManifest };
