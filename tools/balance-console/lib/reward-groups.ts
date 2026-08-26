import rewardGroupManifest from '../data/reward-groups.json';

export type RewardGroup = (typeof rewardGroupManifest.groups)[number];

export const rewardGroups = rewardGroupManifest.groups as readonly RewardGroup[];

const rewardGroupByItem = new Map<string, RewardGroup>(
  rewardGroups.flatMap((group) => group.itemIds.map((itemId) => [itemId, group] as const)),
);

export function getRewardGroup(itemId: string): RewardGroup | undefined {
  return rewardGroupByItem.get(itemId);
}

export function rewardGroupGradient(group: RewardGroup): string {
  if (group.colors.length === 1) return group.colors[0];
  return `linear-gradient(110deg, ${group.colors.join(', ')})`;
}

export { rewardGroupManifest };
