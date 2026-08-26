import type { CSSProperties } from 'react';
import { getRewardGroup, rewardGroupGradient, type RewardGroup } from '@/lib/reward-groups';

export function RewardGroupBadge({ itemId, compact = false }: { itemId: string; compact?: boolean }) {
  const group = getRewardGroup(itemId);
  if (!group) return <span className="reward-group-badge missing">Группа не найдена</span>;
  return <RewardGroupLabel group={group} compact={compact} />;
}

export function RewardGroupLabel({ group, compact = false }: { group: RewardGroup; compact?: boolean }) {
  const style = {
    '--rarity-color': group.primaryColor,
    '--rarity-gradient': rewardGroupGradient(group),
  } as CSSProperties;

  return <span
    className={`reward-group-badge ${compact ? 'compact' : ''}`}
    style={style}
    title={`${group.nameRu} · ${group.displayName} · точная группа из Roblox`}
  >
    <i />
    <b>{group.nameRu}</b>
    {!compact && <small>{group.id}</small>}
  </span>;
}
