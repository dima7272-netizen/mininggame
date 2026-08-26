import Decimal from 'decimal.js';
import type { ConfigTextMap, KnownConfigs } from './config-model';
import { parseKnownConfigs } from './config-model';
import { itemsForRoom } from './game-formulas';

Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

export type RoomEconomy = {
  index: number;
  blockMaxHP: string;
  expectedItemPrice: string;
  expectedRoomIncome: string;
  hpGrowth: string | null;
  rewardGrowth: string | null;
  difficultyToReward: string | null;
  totalWeight: string;
  itemCount: number;
  spawnedItemCount: number;
  assumption: string;
};

export function buildRoomEconomy(configs: ConfigTextMap | KnownConfigs): RoomEconomy[] {
  const known = isKnownConfigs(configs) ? configs : parseKnownConfigs(configs);
  const prices = new Map(known.sellItems.map((item) => [item.id, new Decimal(item.sellPrice)]));
  const drops = new Map(known.roomDrops.map((room) => [room.index, room]));
  let previousHp: Decimal | null = null;
  let previousReward: Decimal | null = null;

  return known.rooms.map((room) => {
    const roomDrop = drops.get(room.index);
    const totalWeight = (roomDrop?.drops ?? []).reduce(
      (sum, drop) => sum.plus(drop.weight),
      new Decimal(0),
    );
    const expectedItemPrice = (roomDrop?.drops ?? []).reduce((sum, drop) => {
      const price = prices.get(drop.itemId) ?? new Decimal(0);
      return totalWeight.isZero()
        ? sum
        : sum.plus(new Decimal(drop.weight).div(totalWeight).mul(price));
    }, new Decimal(0));
    const hp = new Decimal(room.blockMaxHP);
    const spawnedItemCount = itemsForRoom(room.index, known.sellSettings);
    const hpGrowth = previousHp?.isZero() ? null : hp.div(previousHp ?? 1);
    const rewardGrowth = previousReward?.isZero()
      ? null
      : expectedItemPrice.div(previousReward ?? 1);
    const difficultyToReward = hpGrowth && rewardGrowth && !rewardGrowth.isZero()
      ? hpGrowth.div(rewardGrowth)
      : null;
    const result: RoomEconomy = {
      index: room.index,
      blockMaxHP: room.blockMaxHP,
      expectedItemPrice: expectedItemPrice.toFixed(),
      expectedRoomIncome: expectedItemPrice.mul(spawnedItemCount).toFixed(),
      hpGrowth: hpGrowth?.toFixed(8) ?? null,
      rewardGrowth: rewardGrowth?.toFixed(8) ?? null,
      difficultyToReward: difficultyToReward?.toFixed(8) ?? null,
      totalWeight: totalWeight.toFixed(),
      itemCount: roomDrop?.drops.length ?? 0,
      spawnedItemCount,
      assumption:
        `Игровая формула создаёт ${spawnedItemCount} предметов: min + ((номер комнаты + 13337) mod диапазон).`,
    };
    previousHp = hp;
    previousReward = expectedItemPrice;
    return result;
  });
}

function isKnownConfigs(value: ConfigTextMap | KnownConfigs): value is KnownConfigs {
  return Array.isArray((value as KnownConfigs).rooms);
}

export function buildRebirthPreview(known: KnownConfigs, count = 120): string[] {
  const result = known.rebirth.firstRequirements.slice(0, count);
  let current = new Decimal(result.at(-1) ?? 0);
  for (let rebirth = result.length + 1; rebirth <= count; rebirth += 1) {
    const segment = known.rebirth.growth.find((item) => rebirth <= item.upTo);
    if (!segment) break;
    current = current.mul(segment.multiplier);
    result.push(current.toSignificantDigits(30).toString());
  }
  return result;
}

export function formatExact(raw: string): { short: string; exact: string } {
  const value = new Decimal(raw);
  const absolute = value.abs();
  const groups = [
    { value: '1e30', label: 'нониллн' },
    { value: '1e27', label: 'октиллн' },
    { value: '1e24', label: 'септллн' },
    { value: '1e21', label: 'секстллн' },
    { value: '1e18', label: 'квинтллн' },
    { value: '1e15', label: 'квадрлн' },
    { value: '1e12', label: 'трлн' },
    { value: '1e9', label: 'млрд' },
    { value: '1e6', label: 'млн' },
    { value: '1e3', label: 'тыс.' },
  ];
  const group = groups.find((item) => absolute.greaterThanOrEqualTo(item.value));
  return {
    short: group
      ? `${value.div(group.value).toSignificantDigits(4).toString()} ${group.label}`
      : value.toSignificantDigits(8).toString(),
    exact: raw,
  };
}

export function log10ForChart(raw: string): number {
  const value = new Decimal(raw);
  if (value.lessThanOrEqualTo(0)) return 0;
  return value.logarithm(10).toNumber();
}
