import Decimal from 'decimal.js';
import { buildRoomEconomy } from './analytics';
import type { ExactJson } from './exact-json';
import { exactNumber, stringifyExactJson } from './exact-json';
import type { KnownConfigs, RoomDrop } from './config-model';

export type RewardStage = 'new' | 'rising' | 'high' | 'falling' | 'last' | 'removed' | 'stable' | 'absent';

export type RewardLifecycle = {
  itemId: string;
  sellPrice: string;
  automaticRank: number;
  firstRoom: number | null;
  peakRoom: number | null;
  lastRoom: number | null;
  activeRoomCount: number;
  minimumWeight: string;
  maximumWeight: string;
  averageWeight: string;
  hasGap: boolean;
  placements: Array<{ roomIndex: number; weight: string }>;
};

export type RoomInterestMetric = {
  roomIndex: number;
  activeCount: number;
  newCount: number;
  lastCount: number;
  staleWeight: string;
  expectedItemPrice: string;
  expectedRoomIncome: string;
  noveltyIndex: number;
  clutterIndex: number;
  jackpotIndex: number;
};

export type RewardSuggestionKind =
  | 'sharp_entry'
  | 'unsafe_exit'
  | 'too_many'
  | 'stale_pool'
  | 'no_novelty'
  | 'reappeared'
  | 'reward_wall'
  | 'duplicate_room';

export type RewardSuggestion = {
  id: string;
  kind: RewardSuggestionKind;
  severity: 'warning' | 'observation';
  title: string;
  reason: string;
  proposal: string;
  impact: string;
  rooms: number[];
  itemIds: string[];
};

export type LifecycleTemplateId = 'smooth' | 'standard' | 'fast';

export type LifecycleTemplate = {
  id: LifecycleTemplateId;
  name: string;
  description: string;
  curve: number[];
  highStage: number;
  highRoomCount: number;
  minimumPercent: number;
  minimumReplacementPercent: number;
};

export const lifecycleTemplates: Record<LifecycleTemplateId, LifecycleTemplate> = {
  smooth: {
    id: 'smooth',
    name: 'Плавный',
    description: 'Раннее знакомство, длинный разгон, две комнаты большого шанса и затем 0%.',
    curve: [1, 1, 2, 3, 5, 8, 12, 17, 23, 29, 29],
    highStage: 9,
    highRoomCount: 2,
    minimumPercent: 1,
    minimumReplacementPercent: 29,
  },
  standard: {
    id: 'standard',
    name: 'Стандартный',
    description: 'Основной девятикомнатный рост до 29% и защищённое исчезновение сразу в 0%.',
    curve: [1, 2, 3, 5, 8, 12, 17, 23, 29],
    highStage: 8,
    highRoomCount: 1,
    minimumPercent: 1,
    minimumReplacementPercent: 29,
  },
  fast: {
    id: 'fast',
    name: 'Быстрый',
    description: 'Короткий разгон, одна комната большого шанса и немедленная замена.',
    curve: [1, 3, 8, 17, 29],
    highStage: 4,
    highRoomCount: 1,
    minimumPercent: 1,
    minimumReplacementPercent: 29,
  },
};

export type RewardGeneratorSettings = {
  roomStart: number;
  roomEnd: number;
  templateId: LifecycleTemplateId;
  maximumActive: number;
  newRewardsPerRoom: number;
  newRewardEvery: number;
  minimumJackpotPercent: number;
  highChanceHoldRooms?: number;
  minimumReplacementCount?: number;
  minimumReplacementPercent?: number;
  precision: string;
  excludedRooms?: number[];
  rankOverrides?: Record<string, number>;
};

export function analyzeRewardProgression(known: KnownConfigs) {
  const ranks = automaticRewardRanks(known);
  const dropsByItem = new Map<string, Array<{ roomIndex: number; weight: string }>>(
    known.sellItems.map((item) => [item.id, []]),
  );
  known.roomDrops.forEach((room) => room.drops.forEach((drop) => {
    dropsByItem.get(drop.itemId)?.push({ roomIndex: room.index, weight: drop.weight });
  }));

  const lifecycles: RewardLifecycle[] = known.sellItems.map((item) => {
    const placements = (dropsByItem.get(item.id) ?? []).sort((left, right) => left.roomIndex - right.roomIndex);
    const weights = placements.map((placement) => new Decimal(placement.weight));
    const peak = placements.reduce<{ roomIndex: number; weight: string } | null>((current, placement) => {
      if (!current || new Decimal(placement.weight).greaterThan(current.weight)) return placement;
      return current;
    }, null);
    const hasGap = placements.some((placement, index) => index > 0 && placement.roomIndex > placements[index - 1].roomIndex + 1);
    return {
      itemId: item.id,
      sellPrice: item.sellPrice,
      automaticRank: ranks.get(item.id) ?? 0,
      firstRoom: placements[0]?.roomIndex ?? null,
      peakRoom: peak?.roomIndex ?? null,
      lastRoom: placements.at(-1)?.roomIndex ?? null,
      activeRoomCount: placements.length,
      minimumWeight: weights.length ? Decimal.min(...weights).toString() : '0',
      maximumWeight: weights.length ? Decimal.max(...weights).toString() : '0',
      averageWeight: weights.length
        ? weights.reduce((sum, weight) => sum.plus(weight), new Decimal(0)).div(weights.length).toDecimalPlaces(4).toString()
        : '0',
      hasGap,
      placements,
    };
  }).sort((left, right) => left.automaticRank - right.automaticRank);

  const lifecycleByItem = new Map(lifecycles.map((lifecycle) => [lifecycle.itemId, lifecycle]));
  const economy = buildRoomEconomy(known);
  const prices = new Map(known.sellItems.map((item) => [item.id, new Decimal(item.sellPrice)]));
  const metrics: RoomInterestMetric[] = known.roomDrops.map((room) => {
    const roomEconomy = economy.find((item) => item.index === room.index);
    const expected = new Decimal(roomEconomy?.expectedItemPrice ?? 0);
    const newCount = room.drops.filter((drop) => lifecycleByItem.get(drop.itemId)?.firstRoom === room.index).length;
    const lastCount = room.drops.filter((drop) => lifecycleByItem.get(drop.itemId)?.lastRoom === room.index).length;
    const staleWeight = room.drops.reduce((sum, drop) => {
      const price = prices.get(drop.itemId) ?? new Decimal(0);
      return expected.greaterThan(0) && price.lessThan(expected.mul(0.2)) ? sum.plus(drop.weight) : sum;
    }, new Decimal(0));
    const jackpotWeight = room.drops.reduce((sum, drop) => {
      const lifecycle = lifecycleByItem.get(drop.itemId);
      const isNewTop = lifecycle?.firstRoom === room.index && (prices.get(drop.itemId) ?? new Decimal(0)).greaterThan(expected);
      return isNewTop ? sum.plus(drop.weight) : sum;
    }, new Decimal(0));
    return {
      roomIndex: room.index,
      activeCount: room.drops.length,
      newCount,
      lastCount,
      staleWeight: staleWeight.toString(),
      expectedItemPrice: roomEconomy?.expectedItemPrice ?? '0',
      expectedRoomIncome: roomEconomy?.expectedRoomIncome ?? '0',
      noveltyIndex: Math.min(100, newCount * 34 + Math.min(32, jackpotWeight.toNumber() * 3)),
      clutterIndex: Math.min(100, Math.max(0, room.drops.length - 9) * 12 + staleWeight.toNumber()),
      jackpotIndex: Math.min(100, jackpotWeight.toNumber() * 8),
    };
  });

  return {
    lifecycles,
    lifecycleByItem,
    metrics,
    metricByRoom: new Map(metrics.map((metric) => [metric.roomIndex, metric])),
    ranks,
  };
}

export function rewardStage(lifecycle: RewardLifecycle | undefined, roomIndex: number): RewardStage {
  if (!lifecycle) return 'absent';
  const placementIndex = lifecycle.placements.findIndex((placement) => placement.roomIndex === roomIndex);
  if (placementIndex < 0) {
    if (lifecycle.lastRoom !== null && roomIndex === lifecycle.lastRoom + 1) return 'removed';
    return 'absent';
  }
  if (lifecycle.firstRoom === roomIndex) return 'new';
  if (lifecycle.lastRoom === roomIndex) return 'last';
  const current = new Decimal(lifecycle.placements[placementIndex].weight);
  const maximum = new Decimal(lifecycle.maximumWeight);
  if (maximum.greaterThan(0) && current.greaterThanOrEqualTo(maximum.mul(0.8))) return 'high';
  const previous = lifecycle.placements[placementIndex - 1];
  if (!previous || previous.roomIndex !== roomIndex - 1) return 'new';
  const previousWeight = new Decimal(previous.weight);
  if (current.greaterThan(previousWeight)) return 'rising';
  if (current.lessThan(previousWeight)) return 'falling';
  return 'stable';
}

export function probabilityAtLeastOnce(weightPercent: string | number, attempts: number) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Количество появлений должно быть положительным целым числом.');
  const probability = new Decimal(weightPercent).div(100);
  if (probability.isNegative() || probability.greaterThan(1)) throw new Error('Процент должен быть от 0 до 100.');
  return new Decimal(1).minus(new Decimal(1).minus(probability).pow(attempts)).mul(100).toDecimalPlaces(1).toNumber();
}

export type HardRemovalEvaluation = {
  safe: boolean;
  itemId: string;
  fromRoom: number;
  toRoom: number;
  removedWeight: string;
  replacementWeight: string;
  replacementItemIds: string[];
  expectedBefore: string;
  expectedAfter: string;
  goodChanceBefore: string;
  goodChanceAfter: string;
  reasons: string[];
};

export function evaluateHardRemoval(
  known: KnownConfigs,
  itemId: string,
  fromRoom: number,
  minimumReplacementPercent = 29,
  minimumReplacementCount = 1,
): HardRemovalEvaluation {
  const before = known.roomDrops.find((room) => room.index === fromRoom);
  const after = known.roomDrops.find((room) => room.index === fromRoom + 1);
  const removed = before?.drops.find((drop) => drop.itemId === itemId);
  const prices = new Map(known.sellItems.map((item) => [item.id, new Decimal(item.sellPrice)]));
  const removedPrice = prices.get(itemId) ?? new Decimal(0);
  const beforeWeights = new Map(before?.drops.map((drop) => [drop.itemId, new Decimal(drop.weight)]) ?? []);
  const replacements = (after?.drops ?? []).filter((drop) => {
    const price = prices.get(drop.itemId) ?? new Decimal(0);
    const gained = new Decimal(drop.weight).minus(beforeWeights.get(drop.itemId) ?? 0);
    return price.greaterThan(removedPrice) && gained.greaterThan(0);
  });
  const replacementWeight = replacements.reduce((sum, drop) => {
    const gained = Decimal.max(0, new Decimal(drop.weight).minus(beforeWeights.get(drop.itemId) ?? 0));
    return sum.plus(gained);
  }, new Decimal(0));
  const expectedBefore = expectedValue(before, prices);
  const expectedAfter = expectedValue(after, prices);
  const goodChanceBefore = (before?.drops ?? []).reduce((sum, drop) => (
    (prices.get(drop.itemId) ?? new Decimal(0)).greaterThanOrEqualTo(removedPrice) ? sum.plus(drop.weight) : sum
  ), new Decimal(0));
  const goodChanceAfter = (after?.drops ?? []).reduce((sum, drop) => (
    (prices.get(drop.itemId) ?? new Decimal(0)).greaterThan(removedPrice) ? sum.plus(drop.weight) : sum
  ), new Decimal(0));
  const reasons: string[] = [];
  if (!before || !after || !removed) reasons.push('Нет соседней комнаты или удаляемого предмета для проверки.');
  if (replacements.length < minimumReplacementCount) reasons.push(`Более сильных замен с выросшим шансом: ${replacements.length}; требуется не меньше ${minimumReplacementCount}.`);
  if (replacementWeight.lessThan(minimumReplacementPercent)) reasons.push(`Более сильные замены получают только +${replacementWeight.toString()} п.п.; требуется не меньше ${minimumReplacementPercent} п.п.`);
  if (expectedAfter.lessThan(expectedBefore)) reasons.push('Ожидаемая цена предмета в следующей комнате уменьшается.');
  if (goodChanceAfter.lessThan(goodChanceBefore)) reasons.push('Суммарный шанс получить предмет не слабее удаляемого уменьшается.');
  return {
    safe: reasons.length === 0,
    itemId,
    fromRoom,
    toRoom: fromRoom + 1,
    removedWeight: removed?.weight ?? '0',
    replacementWeight: replacementWeight.toString(),
    replacementItemIds: replacements.map((drop) => drop.itemId),
    expectedBefore: expectedBefore.toString(),
    expectedAfter: expectedAfter.toString(),
    goodChanceBefore: goodChanceBefore.toString(),
    goodChanceAfter: goodChanceAfter.toString(),
    reasons,
  };
}

export function buildRewardSuggestions(known: KnownConfigs): RewardSuggestion[] {
  const analysis = analyzeRewardProgression(known);
  const suggestions: RewardSuggestion[] = [];
  const economy = buildRoomEconomy(known);
  const priceByItem = new Map(known.sellItems.map((item) => [item.id, new Decimal(item.sellPrice)]));

  analysis.lifecycles.forEach((lifecycle) => {
    const first = lifecycle.placements[0];
    const last = lifecycle.placements.at(-1);
    if (first && new Decimal(first.weight).greaterThan(3)) {
      suggestions.push({
        id: `sharp-${lifecycle.itemId}-${first.roomIndex}`,
        kind: 'sharp_entry',
        severity: 'warning',
        title: `${lifecycle.itemId} появляется сразу с ${first.weight}%`,
        reason: 'Пропущен этап редкого знакомства: новая награда сразу занимает заметную часть пула.',
        proposal: 'Снизить первое появление до базового 1% и пропорционально нормализовать остальные награды.',
        impact: 'Новая награда сначала будет ощущаться как джекпот, не ломая среднюю ценность комнаты.',
        rooms: [first.roomIndex],
        itemIds: [lifecycle.itemId],
      });
    }
    if (last && lifecycle.lastRoom !== known.roomDrops.at(-1)?.index && new Decimal(last.weight).greaterThanOrEqualTo(17)) {
      const removal = evaluateHardRemoval(known, lifecycle.itemId, last.roomIndex);
      if (!removal.safe) {
        suggestions.push({
          id: `unsafe-exit-${lifecycle.itemId}-${last.roomIndex}`,
          kind: 'unsafe_exit',
          severity: 'warning',
          title: `${lifecycle.itemId}: удаление после ${last.weight}% пока небезопасно`,
          reason: removal.reasons.join(' '),
          proposal: `Сохранить большой шанс ещё в комнате ${last.roomIndex + 1} или сначала дать более сильным заменам не меньше 29% прироста.`,
          impact: 'Игрок не почувствует ухудшение награды после резкого удаления старого предмета.',
          rooms: [last.roomIndex, last.roomIndex + 1],
          itemIds: [lifecycle.itemId, ...removal.replacementItemIds],
        });
      }
    }
    if (lifecycle.hasGap) {
      suggestions.push({
        id: `gap-${lifecycle.itemId}`,
        kind: 'reappeared',
        severity: 'warning',
        title: `${lifecycle.itemId} исчезает и появляется снова`,
        reason: `В активном жизненном цикле есть разрыв между комнатами ${lifecycle.firstRoom}–${lifecycle.lastRoom}.`,
        proposal: 'Проверить событийное назначение; без событийной метки удалить повторное появление.',
        impact: 'Игроку будет проще считывать последовательную прогрессию наград.',
        rooms: lifecycle.placements.map((placement) => placement.roomIndex),
        itemIds: [lifecycle.itemId],
      });
    }
  });

  analysis.metrics.forEach((metric, index) => {
    const room = known.roomDrops[index];
    if (metric.activeCount > 11) {
      const cheapest = [...room.drops].sort((left, right) => (priceByItem.get(left.itemId) ?? new Decimal(0)).comparedTo(priceByItem.get(right.itemId) ?? 0))[0];
      suggestions.push({
        id: `many-${room.index}`,
        kind: 'too_many',
        severity: 'warning',
        title: `Комната ${room.index}: ${metric.activeCount} активных наград`,
        reason: 'Большой пул усложняет чтение прогрессии и дольше удерживает слабые предметы.',
        proposal: cheapest ? `Убрать самый дешёвый предмет ${cheapest.itemId} и нормализовать пул.` : 'Сократить число активных типов.',
        impact: 'Пул станет компактнее, а различия между комнатами заметнее.',
        rooms: [room.index],
        itemIds: cheapest ? [cheapest.itemId] : [],
      });
    }
    if (new Decimal(metric.staleWeight).greaterThan(20)) {
      const stale = room.drops.filter((drop) => (priceByItem.get(drop.itemId) ?? new Decimal(0)).lessThan(new Decimal(metric.expectedItemPrice).mul(0.2)));
      suggestions.push({
        id: `stale-${room.index}`,
        kind: 'stale_pool',
        severity: 'warning',
        title: `Комната ${room.index}: ${metric.staleWeight}% явно слабых наград`,
        reason: 'Цена этих предметов ниже 20% ожидаемой цены одного предмета в комнате.',
        proposal: 'Удалить прошедшие большой шанс предметы сразу после подготовки более сильной замены; остальные пока только сократить.',
        impact: 'Ожидаемая ценность вырастет, а слабые предметы не будут захламлять поздние комнаты.',
        rooms: [room.index],
        itemIds: stale.map((drop) => drop.itemId),
      });
    }
    const recent = analysis.metrics.slice(Math.max(0, index - 2), index + 1);
    if (index >= 2 && recent.every((item) => item.newCount === 0)) {
      suggestions.push({
        id: `novelty-${room.index}`,
        kind: 'no_novelty',
        severity: 'observation',
        title: `К комнате ${room.index} новизны нет уже три комнаты`,
        reason: `В комнатах ${recent.map((item) => item.roomIndex).join(', ')} не появляется ни одной новой награды.`,
        proposal: 'Добавить следующую по цене награду с базовым джекпотным шансом 1%.',
        impact: 'Игрок снова увидит новый возможный предмет без резкого скачка экономики.',
        rooms: [room.index],
        itemIds: [],
      });
    }
    const roomEconomy = economy[index];
    if (index > 0 && new Decimal(roomEconomy.hpGrowth ?? 1).greaterThan(2) && new Decimal(roomEconomy.rewardGrowth ?? 1).lessThan(1.08)) {
      suggestions.push({
        id: `wall-${room.index}`,
        kind: 'reward_wall',
        severity: 'warning',
        title: `Комната ${room.index}: награда отстаёт от HP`,
        reason: `HP выросло ×${roomEconomy.hpGrowth}, а средняя цена награды — только ×${roomEconomy.rewardGrowth}.`,
        proposal: 'Поднять долю сильных наград или пересмотреть их цену.',
        impact: 'Соотношение сложности и награды станет ровнее.',
        rooms: [room.index - 1, room.index],
        itemIds: room.drops.map((drop) => drop.itemId),
      });
    }
  });

  return suggestions.slice(0, 80);
}

export function normalizeRoomDrop(
  room: RoomDrop,
  lockedCells: ReadonlySet<string>,
  precision = '1',
  minimumByItem: ReadonlyMap<string, string> = new Map(),
): RoomDrop {
  const step = new Decimal(precision);
  if (!step.equals(1)) throw new Error('Проценты выпадения могут быть только целыми числами.');
  const locked = room.drops.filter((drop) => lockedCells.has(cellKey(room.index, drop.itemId)));
  const unlocked = room.drops.filter((drop) => !lockedCells.has(cellKey(room.index, drop.itemId)));
  const invalidLocked = locked.find((drop) => !isIntegerPercentLiteral(drop.weight));
  if (invalidLocked) {
    throw new Error(`Комната ${room.index}: заблокированный процент ${invalidLocked.itemId} должен быть целым числом.`);
  }
  const lockedTotal = locked.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0));
  if (lockedTotal.greaterThan(100)) throw new Error(`Комната ${room.index}: заблокировано ${lockedTotal.toString()}%, больше 100%.`);
  const remaining = new Decimal(100).minus(lockedTotal);
  if (unlocked.length === 0) {
    if (!remaining.isZero()) throw new Error(`Комната ${room.index}: все значения заблокированы, сумма не равна 100%.`);
    return cloneRoomDrops([room])[0];
  }

  const minimums = unlocked.map((drop) => Decimal.max(0, minimumByItem.get(drop.itemId) ?? 0).div(step).ceil().mul(step));
  const minimumTotal = minimums.reduce((sum, value) => sum.plus(value), new Decimal(0));
  if (minimumTotal.greaterThan(remaining)) {
    throw new Error(`Комната ${room.index}: минимальные шансы новых наград и блокировки превышают 100%. Разнесите первые появления по соседним комнатам.`);
  }
  const distributable = remaining.minus(minimumTotal);
  const excesses = unlocked.map((drop, index) => Decimal.max(0, new Decimal(drop.weight).minus(minimums[index])));
  const excessTotal = excesses.reduce((sum, value) => sum.plus(value), new Decimal(0));
  const ideals = unlocked.map((_, index) => minimums[index].plus(
    excessTotal.isZero() ? distributable.div(unlocked.length) : excesses[index].div(excessTotal).mul(distributable),
  ));
  const allocations = ideals.map((ideal) => ideal.div(step).floor().mul(step));
  let residue = remaining.minus(allocations.reduce((sum, value) => sum.plus(value), new Decimal(0)));
  const order = ideals.map((ideal, index) => ({ index, remainder: ideal.minus(allocations[index]) }))
    .sort((left, right) => right.remainder.comparedTo(left.remainder) || left.index - right.index);
  let cursor = 0;
  while (residue.greaterThanOrEqualTo(step) && order.length > 0) {
    allocations[order[cursor % order.length].index] = allocations[order[cursor % order.length].index].plus(step);
    residue = residue.minus(step);
    cursor += 1;
  }
  if (!residue.isZero()) allocations[order[0]?.index ?? 0] = allocations[order[0]?.index ?? 0].plus(residue);

  const allocationById = new Map(unlocked.map((drop, index) => [drop.itemId, allocations[index]]));
  return {
    index: room.index,
    drops: room.drops.map((drop) => ({
      itemId: drop.itemId,
      weight: lockedCells.has(cellKey(room.index, drop.itemId))
        ? drop.weight
        : decimalText(allocationById.get(drop.itemId) ?? new Decimal(0)),
    })).filter((drop) => new Decimal(drop.weight).greaterThan(0) || lockedCells.has(cellKey(room.index, drop.itemId))),
  };
}

export function generateRewardScheme(
  known: KnownConfigs,
  settings: RewardGeneratorSettings,
  lockedCells: ReadonlySet<string> = new Set(),
): RoomDrop[] {
  const roomStart = Math.max(settings.roomStart, known.roomDrops[0]?.index ?? 1);
  const roomEnd = Math.min(settings.roomEnd, known.roomDrops.at(-1)?.index ?? settings.roomEnd);
  if (roomEnd < roomStart) throw new Error('Конечная комната должна быть не меньше начальной.');
  if (settings.maximumActive < 1) throw new Error('В комнате должна оставаться хотя бы одна награда.');
  const template = lifecycleTemplates[settings.templateId];
  const highChanceHoldRooms = Math.max(1, Math.floor(settings.highChanceHoldRooms ?? template.highRoomCount));
  const risingCurve = template.curve.slice(0, template.highStage + 1);
  const curve = [...risingCurve, ...Array.from({ length: highChanceHoldRooms - 1 }, () => risingCurve.at(-1) ?? 29)];
  const excluded = new Set(settings.excludedRooms ?? []);
  const availableRooms = known.roomDrops
    .map((room) => room.index)
    .filter((roomIndex) => roomIndex >= roomStart && roomIndex <= roomEnd && !excluded.has(roomIndex));
  if (availableRooms.length === 0) throw new Error('В выбранном диапазоне не осталось комнат для генерации.');
  const rankedByPrice = [...known.sellItems].sort((left, right) => {
    const price = new Decimal(left.sellPrice).comparedTo(right.sellPrice);
    return price || left.id.localeCompare(right.id);
  });
  const automaticRanks = new Map(rankedByPrice.map((item, index) => [item.id, index + 1]));
  const ranked = [...rankedByPrice].sort((left, right) => {
    const leftRank = settings.rankOverrides?.[left.id] ?? automaticRanks.get(left.id) ?? 0;
    const rightRank = settings.rankOverrides?.[right.id] ?? automaticRanks.get(right.id) ?? 0;
    return leftRank - rightRank || (automaticRanks.get(left.id) ?? 0) - (automaticRanks.get(right.id) ?? 0);
  });
  const rewardsPerIntroduction = Math.max(1, Math.floor(settings.newRewardsPerRoom));
  const introductionStart = roomStart - curve.length + 1;
  const introductionEnd = availableRooms.at(-1) ?? roomEnd;
  const introductionInterval = Math.max(1, Math.floor(settings.newRewardEvery));
  let introductionRooms = Array.from(
    { length: Math.floor((introductionEnd - introductionStart) / introductionInterval) + 1 },
    (_, index) => introductionStart + index * introductionInterval,
  ).filter((roomIndex) => roomIndex < roomStart || !excluded.has(roomIndex));
  if (introductionRooms.length > ranked.length) {
    introductionRooms = introductionRooms.slice(introductionRooms.length - ranked.length);
  }
  if (introductionRooms.length * rewardsPerIntroduction < ranked.length) {
    throw new Error(`В диапазоне доступно ${introductionRooms.length} первых появлений по ${rewardsPerIntroduction} наград, а расставить нужно ${ranked.length}. Увеличьте число новых наград за появление или уменьшите интервал.`);
  }
  const baseRewardsPerRoom = Math.floor(ranked.length / introductionRooms.length);
  const roomsWithExtraReward = ranked.length % introductionRooms.length;
  if (baseRewardsPerRoom > rewardsPerIntroduction || (roomsWithExtraReward > 0 && baseRewardsPerRoom + 1 > rewardsPerIntroduction)) {
    throw new Error('Заданный лимит новых наград не вмещает полный каталог в выбранный диапазон.');
  }
  const firstRoomByItem = new Map<string, number>();
  let rewardCursor = 0;
  introductionRooms.forEach((introductionRoom, index) => {
    const groupSize = baseRewardsPerRoom + (index < roomsWithExtraReward ? 1 : 0);
    ranked.slice(rewardCursor, rewardCursor + groupSize).forEach((item) => firstRoomByItem.set(item.id, introductionRoom));
    rewardCursor += groupSize;
  });
  const availableSpan = Math.max(0, availableRooms.length - 1);
  const originalByRoom = new Map(known.roomDrops.map((room) => [room.index, room]));
  const minimumNewPercent = Math.max(1, template.minimumPercent, settings.minimumJackpotPercent);

  const generated = known.roomDrops.map((originalRoom) => {
    if (originalRoom.index < roomStart || originalRoom.index > roomEnd || excluded.has(originalRoom.index)) {
      return cloneRoomDrops([originalRoom])[0];
    }
    const candidates = ranked.flatMap((item) => {
      const firstRoom = firstRoomByItem.get(item.id) ?? roomEnd;
      const stage = originalRoom.index - firstRoom;
      if (stage < 0 || stage >= curve.length) return [];
      const rawWeight = stage === 0 ? Math.max(curve[stage], minimumNewPercent) : curve[stage];
      return [{ itemId: item.id, weight: String(rawWeight), rawWeight, rank: ranked.indexOf(item), stage, isNew: stage === 0 }];
    });
    const original = originalByRoom.get(originalRoom.index) ?? originalRoom;
    original.drops.forEach((drop) => {
      if (!lockedCells.has(cellKey(originalRoom.index, drop.itemId))) return;
      const existing = candidates.find((candidate) => candidate.itemId === drop.itemId);
      if (existing) {
        existing.weight = drop.weight;
        existing.rawWeight = Number(drop.weight);
      } else {
        candidates.push({ itemId: drop.itemId, weight: drop.weight, rawWeight: Number(drop.weight), rank: ranked.findIndex((item) => item.id === drop.itemId), stage: -1, isNew: false });
      }
    });
    const selected = Array.from(new Map(candidates.map((candidate) => [candidate.itemId, candidate])).values())
      .sort((left, right) => left.rank - right.rank || left.itemId.localeCompare(right.itemId));
    if (selected.length > settings.maximumActive) {
      const newCount = selected.filter((candidate) => candidate.isNew).length;
      throw new Error(`Комната ${originalRoom.index}: для полного жизненного цикла нужно ${selected.length} активных типов при лимите ${settings.maximumActive}. Увеличьте лимит или уменьшите число новых наград (${newCount}) и разнесите их появления по соседним комнатам.`);
    }
    if (selected.length === 0) {
      const position = availableRooms.indexOf(originalRoom.index);
      const fallback = ranked[Math.min(ranked.length - 1, Math.round((position / Math.max(availableSpan, 1)) * (ranked.length - 1)))];
      if (fallback) selected.push({ itemId: fallback.id, weight: '100', rawWeight: 100, rank: ranked.indexOf(fallback), stage: 0, isNew: true });
    }
    const minimums = new Map(selected.filter((candidate) => candidate.isNew).map((candidate) => [candidate.itemId, String(minimumNewPercent)]));
    return normalizeRoomDrop({
      index: originalRoom.index,
      drops: selected.map((candidate) => ({ itemId: candidate.itemId, weight: candidate.weight })),
    }, lockedCells, settings.precision, minimums);
  });

  for (let roomIndex = roomStart + 1; roomIndex <= roomEnd; roomIndex += 1) {
    if (excluded.has(roomIndex) || excluded.has(roomIndex - 1)) continue;
    const previous = generated.find((room) => room.index === roomIndex - 1);
    const current = generated.find((room) => room.index === roomIndex);
    if (!previous || !current) continue;
    const previousWeights = new Map(previous.drops.map((drop) => [drop.itemId, drop.weight]));
    const minimums = new Map<string, string>();
    current.drops.forEach((drop) => {
      const firstRoom = firstRoomByItem.get(drop.itemId);
      if (firstRoom === roomIndex) minimums.set(drop.itemId, String(minimumNewPercent));
      const previousWeight = previousWeights.get(drop.itemId);
      if (previousWeight !== undefined) {
        minimums.set(drop.itemId, Decimal.max(previousWeight, minimums.get(drop.itemId) ?? 0).toString());
      }
    });
    const normalized = normalizeRoomDrop(current, lockedCells, settings.precision, minimums);
    current.drops = normalized.drops;
  }

  const replacementMinimum = settings.minimumReplacementPercent ?? template.minimumReplacementPercent;
  for (let roomIndex = roomStart + 1; roomIndex <= roomEnd; roomIndex += 1) {
    if (excluded.has(roomIndex)) continue;
    const previous = generated.find((room) => room.index === roomIndex - 1);
    const current = generated.find((room) => room.index === roomIndex);
    if (!previous || !current) continue;
    const ended = previous.drops.filter((drop) => {
      if (current.drops.some((candidate) => candidate.itemId === drop.itemId)) return false;
      const firstRoom = firstRoomByItem.get(drop.itemId);
      return firstRoom !== undefined && roomIndex >= firstRoom + curve.length;
    });
    for (const drop of ended) {
      const generatedKnown = { ...known, roomDrops: generated };
      const requiredReplacement = Decimal.min(replacementMinimum, drop.weight).toNumber();
      const evaluation = evaluateHardRemoval(generatedKnown, drop.itemId, roomIndex - 1, requiredReplacement, settings.minimumReplacementCount ?? 1);
      if (evaluation.safe) continue;
      if (current.drops.length >= settings.maximumActive) {
        throw new Error(`Комната ${roomIndex}: ${drop.itemId} нельзя безопасно удалить, а лимит ${settings.maximumActive} уже заполнен. ${evaluation.reasons.join(' ')}`);
      }
      current.drops.push({ itemId: drop.itemId, weight: drop.weight });
      const normalized = normalizeRoomDrop(current, lockedCells, settings.precision);
      current.drops = normalized.drops;
    }
  }

  return generated;
}

export function applyRewardSuggestion(
  known: KnownConfigs,
  suggestion: RewardSuggestion,
  lockedCells: ReadonlySet<string>,
  precision = '1',
): RoomDrop[] {
  const rooms = cloneRoomDrops(known.roomDrops);
  const roomByIndex = new Map(rooms.map((room) => [room.index, room]));
  const prices = new Map(known.sellItems.map((item) => [item.id, new Decimal(item.sellPrice)]));
  const analysis = analyzeRewardProgression(known);

  if (suggestion.kind === 'sharp_entry') {
    const room = roomByIndex.get(suggestion.rooms[0]);
    const drop = room?.drops.find((item) => item.itemId === suggestion.itemIds[0]);
    if (room && drop && !lockedCells.has(cellKey(room.index, drop.itemId))) drop.weight = '3';
  }
  if (suggestion.kind === 'unsafe_exit') {
    const nextRoom = roomByIndex.get(suggestion.rooms.at(-1) ?? 0);
    const previousRoom = roomByIndex.get(suggestion.rooms[0]);
    const itemId = suggestion.itemIds[0];
    const previousWeight = previousRoom?.drops.find((drop) => drop.itemId === itemId)?.weight ?? '29';
    if (nextRoom && itemId && !nextRoom.drops.some((drop) => drop.itemId === itemId)) nextRoom.drops.push({ itemId, weight: previousWeight });
  }
  if (suggestion.kind === 'too_many') {
    const room = roomByIndex.get(suggestion.rooms[0]);
    const removeId = suggestion.itemIds[0];
    if (room && removeId && !lockedCells.has(cellKey(room.index, removeId))) room.drops = room.drops.filter((drop) => drop.itemId !== removeId);
  }
  if (suggestion.kind === 'stale_pool') {
    const room = roomByIndex.get(suggestion.rooms[0]);
    room?.drops.forEach((drop) => {
      if (suggestion.itemIds.includes(drop.itemId) && !lockedCells.has(cellKey(room.index, drop.itemId))) {
        drop.weight = new Decimal(drop.weight).div(2).toString();
      }
    });
  }
  if (suggestion.kind === 'no_novelty') {
    const room = roomByIndex.get(suggestion.rooms[0]);
    if (room) {
      const highestRank = Math.max(...room.drops.map((drop) => analysis.ranks.get(drop.itemId) ?? 0));
      const next = analysis.lifecycles.find((lifecycle) => lifecycle.automaticRank > highestRank && !room.drops.some((drop) => drop.itemId === lifecycle.itemId));
      if (next) room.drops.push({ itemId: next.itemId, weight: '1' });
    }
  }
  if (suggestion.kind === 'reward_wall') {
    const room = roomByIndex.get(suggestion.rooms.at(-1) ?? 0);
    if (room) {
      const strongest = [...room.drops].sort((left, right) => (prices.get(right.itemId) ?? new Decimal(0)).comparedTo(prices.get(left.itemId) ?? 0))[0];
      if (strongest && !lockedCells.has(cellKey(room.index, strongest.itemId))) strongest.weight = new Decimal(strongest.weight).mul(1.5).toString();
    }
  }

  const affected = new Set(suggestion.rooms);
  return rooms.map((room) => affected.has(room.index) ? normalizeRoomDrop(room, lockedCells, precision) : room);
}

export function setRoomRewardWeight(
  roomDrops: RoomDrop[],
  roomIndex: number,
  itemId: string,
  weight: string | null,
  normalize: boolean,
  lockedCells: ReadonlySet<string>,
  precision = '1',
) {
  const next = cloneRoomDrops(roomDrops);
  const room = next.find((item) => item.index === roomIndex);
  if (!room) throw new Error(`Комната ${roomIndex} не найдена.`);
  if (lockedCells.has(cellKey(roomIndex, itemId))) throw new Error('Эта ячейка заблокирована.');
  const existing = room.drops.find((drop) => drop.itemId === itemId);
  const parsedWeight = weight === null ? null : parseIntegerPercent(weight);
  if (parsedWeight === null || parsedWeight.isZero()) {
    room.drops = room.drops.filter((drop) => drop.itemId !== itemId);
  } else if (existing) {
    existing.weight = parsedWeight.toFixed(0);
  } else {
    room.drops.push({ itemId, weight: parsedWeight.toFixed(0) });
  }
  if (room.drops.length === 0) throw new Error('В комнате должна оставаться хотя бы одна награда.');
  if (normalize) {
    const normalized = normalizeRoomDrop(room, lockedCells, precision);
    room.drops = normalized.drops;
  }
  return next;
}

export function copyRoomRewards(roomDrops: RoomDrop[], fromRoom: number, toRoom: number, lockedCells: ReadonlySet<string>) {
  const next = cloneRoomDrops(roomDrops);
  const source = next.find((room) => room.index === fromRoom);
  const target = next.find((room) => room.index === toRoom);
  if (!source || !target) throw new Error('Исходная или целевая комната не найдена.');
  const locked = target.drops.filter((drop) => lockedCells.has(cellKey(target.index, drop.itemId)));
  const copied = source.drops.filter((drop) => !lockedCells.has(cellKey(target.index, drop.itemId)));
  target.drops = [...locked, ...copied.map((drop) => ({ ...drop }))];
  const normalized = normalizeRoomDrop(target, lockedCells);
  return next.map((room) => room.index === target.index ? normalized : room);
}

export function shiftRewardScheme(roomDrops: RoomDrop[], direction: -1 | 1, lockedCells: ReadonlySet<string>) {
  const next = cloneRoomDrops(roomDrops);
  const source = cloneRoomDrops(roomDrops);
  next.forEach((target) => {
    const from = source.find((room) => room.index === target.index - direction);
    if (!from) return;
    const locked = target.drops.filter((drop) => lockedCells.has(cellKey(target.index, drop.itemId)));
    const copied = from.drops.filter((drop) => !lockedCells.has(cellKey(target.index, drop.itemId)));
    target.drops = normalizeRoomDrop({ index: target.index, drops: [...locked, ...copied.map((drop) => ({ ...drop }))] }, lockedCells).drops;
  });
  return next;
}

export function serializeRoomDrops(roomDrops: RoomDrop[]) {
  const invalid = roomDrops.flatMap((room) => room.drops.map((drop) => ({ room: room.index, ...drop })))
    .find((drop) => !isIntegerPercentLiteral(drop.weight));
  if (invalid) {
    throw new Error(`Комната ${invalid.room}: процент ${invalid.itemId} должен быть целым числом от 0 до 100.`);
  }
  const json: ExactJson = roomDrops.map((room) => ({
    index: exactNumber(String(room.index)),
    drops: room.drops.map((drop) => ({ itemId: drop.itemId, weight: exactNumber(drop.weight) })),
  }));
  return stringifyExactJson(json);
}

export function cloneRoomDrops(roomDrops: RoomDrop[]) {
  return roomDrops.map((room) => ({ index: room.index, drops: room.drops.map((drop) => ({ ...drop })) }));
}

export function countRewardChanges(before: RoomDrop[], after: RoomDrop[]) {
  const beforeMap = new Map(before.flatMap((room) => room.drops.map((drop) => [cellKey(room.index, drop.itemId), drop.weight] as const)));
  const afterMap = new Map(after.flatMap((room) => room.drops.map((drop) => [cellKey(room.index, drop.itemId), drop.weight] as const)));
  return Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).filter((key) => beforeMap.get(key) !== afterMap.get(key)).length;
}

export function cellKey(roomIndex: number, itemId: string) {
  return `${roomIndex}:${itemId}`;
}

function automaticRewardRanks(known: KnownConfigs) {
  const sorted = known.sellItems.map((item, index) => ({ ...item, index })).sort((left, right) => {
    const byPrice = new Decimal(left.sellPrice).comparedTo(right.sellPrice);
    return byPrice || left.index - right.index;
  });
  return new Map(sorted.map((item, index) => [item.id, index + 1]));
}

function expectedValue(room: RoomDrop | undefined, prices: ReadonlyMap<string, Decimal>) {
  return (room?.drops ?? []).reduce((sum, drop) => (
    sum.plus((prices.get(drop.itemId) ?? new Decimal(0)).mul(drop.weight).div(100))
  ), new Decimal(0));
}

function decimalText(value: Decimal) {
  return value.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function isIntegerPercentLiteral(value: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(value.trim())) return false;
  const parsed = new Decimal(value);
  return parsed.lessThanOrEqualTo(100);
}

function parseIntegerPercent(value: string) {
  const normalized = value.trim();
  if (!isIntegerPercentLiteral(normalized)) {
    throw new Error('Процент должен быть целым числом от 0 до 100, без точки и запятой.');
  }
  return new Decimal(normalized);
}
