import Decimal from 'decimal.js';
import { buildRoomEconomy } from './analytics';
import { parseKnownConfigs, type ConfigTextMap, type RoomDrop, type SellItem } from './config-model';
import { exactNumber, stringifyExactJson } from './exact-json';
import { retiredRewardItemIds, rewardHierarchyItemIds } from './reward-groups';
import { serializeReadableSellItems } from './reward-pricing';
import { serializeRoomDrops } from './reward-progression';

const TARGET_ROOM_COUNT = 50;
const ITEMS_PER_ROOM = 8;
const MINIMUM_WEIGHT = 1;
const BASE_WEIGHTS = [30, 22, 16, 12, 8, 6, 4, 2];
const READABLE_MANTISSAS = ['1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '7'];

export type RewardExpansionReport = {
  retiredItemIds: string[];
  existingRoomCount: number;
  roomCount: number;
  maximumExistingRewardDeviationPercent: number;
};

/**
 * Removes Godly sell rewards, redistributes every remaining rarity over fifty
 * rooms and keeps the expected item value of every existing room as close as
 * whole-number percentages allow. Rooms 47–50 continue the recent reward and
 * wall-HP growth instead of creating a new jump.
 */
export function removeGodlyRewardsAndExtendTo50(configs: ConfigTextMap): ConfigTextMap {
  return buildRewardExpansion(configs).configs;
}

export function buildRewardExpansion(configs: ConfigTextMap): {
  configs: ConfigTextMap;
  report: RewardExpansionReport;
} {
  const known = parseKnownConfigs(configs);
  const retired = new Set(retiredRewardItemIds);
  const activeIds = known.sellItems.map((item) => item.id).filter((itemId) => !retired.has(itemId));
  const hasEveryActiveItem = rewardHierarchyItemIds.every((itemId) => activeIds.includes(itemId));
  const alreadyExpanded = known.sellItems.length === rewardHierarchyItemIds.length
    && known.sellItems.every((item, index) => item.id === rewardHierarchyItemIds[index])
    && known.rooms.length >= TARGET_ROOM_COUNT
    && known.roomDrops.length >= TARGET_ROOM_COUNT
    && known.roomDrops.every((room) => room.drops.every((drop) => !retired.has(drop.itemId)));

  if (alreadyExpanded || !hasEveryActiveItem || known.rooms.length < 2 || known.roomDrops.length < 2) {
    return {
      configs,
      report: {
        retiredItemIds: alreadyExpanded ? [...retiredRewardItemIds] : [],
        existingRoomCount: known.rooms.length,
        roomCount: known.rooms.length,
        maximumExistingRewardDeviationPercent: 0,
      },
    };
  }

  const existingRoomCount = Math.min(known.rooms.length, known.roomDrops.length, TARGET_ROOM_COUNT);
  const originalEconomy = buildRoomEconomy(known).slice(0, existingRoomCount);
  const existingTargets = originalEconomy.map((room) => new Decimal(room.expectedItemPrice));
  if (existingTargets.some((target) => !target.isFinite() || target.lessThanOrEqualTo(0))) {
    return {
      configs,
      report: {
        retiredItemIds: [],
        existingRoomCount,
        roomCount: known.rooms.length,
        maximumExistingRewardDeviationPercent: 0,
      },
    };
  }

  const rewardTargets = extendRewardTargets(existingTargets, TARGET_ROOM_COUNT);
  const activeItemsById = new Map(
    known.sellItems.filter((item) => !retired.has(item.id)).map((item) => [item.id, item]),
  );
  const orderedItems = rewardHierarchyItemIds.map((itemId) => activeItemsById.get(itemId)!);
  const repricedItems = buildStretchedPrices(orderedItems, rewardTargets);
  const prices = new Map(repricedItems.map((item) => [item.id, new Decimal(item.sellPrice)]));
  const roomDrops = buildStretchedRoomDrops(repricedItems, prices, rewardTargets);
  const roomsText = extendRoomsTo50(configs, TARGET_ROOM_COUNT);

  const nextConfigs: ConfigTextMap = {
    ...configs,
    Rooms: roomsText,
    SellItems: serializeReadableSellItems(known.sellSettings, repricedItems),
    RoomDrops: serializeRoomDrops(roomDrops),
  };
  const nextEconomy = buildRoomEconomy(nextConfigs);
  const maximumExistingRewardDeviationPercent = nextEconomy.slice(0, existingRoomCount)
    .reduce((maximum, room, index) => {
      const target = existingTargets[index];
      const deviation = new Decimal(room.expectedItemPrice).minus(target).abs().div(target).mul(100).toNumber();
      return Math.max(maximum, deviation);
    }, 0);

  return {
    configs: nextConfigs,
    report: {
      retiredItemIds: [...retiredRewardItemIds],
      existingRoomCount,
      roomCount: TARGET_ROOM_COUNT,
      maximumExistingRewardDeviationPercent,
    },
  };
}

function extendRewardTargets(existing: Decimal[], count: number) {
  const targets = existing.slice(0, count);
  const recentRatios = targets.slice(Math.max(1, targets.length - 5)).map((target, index) => {
    const previousIndex = targets.length - Math.min(5, targets.length - 1) + index - 1;
    const previous = targets[Math.max(0, previousIndex)];
    return previous?.greaterThan(0) ? target.div(previous) : new Decimal(1);
  }).filter((ratio) => ratio.isFinite() && ratio.greaterThan(1));
  const continuation = recentRatios.length > 0
    ? Decimal.min(4.5, Decimal.max(1.2, geometricMean(recentRatios)))
    : new Decimal(2);
  while (targets.length < count) targets.push(targets.at(-1)!.mul(continuation));
  return targets;
}

function geometricMean(values: Decimal[]) {
  return Decimal.exp(values.reduce((sum, value) => sum.plus(Decimal.ln(value)), new Decimal(0)).div(values.length));
}

export function buildStretchedPrices(items: SellItem[], targets: Decimal[]): SellItem[] {
  const monotonicLogs: Decimal[] = [];
  targets.forEach((target, index) => {
    const log = Decimal.log(target, 10);
    monotonicLogs.push(index === 0 ? log : Decimal.max(log, monotonicLogs[index - 1].plus('0.000001')));
  });

  let previous = new Decimal(0);
  return items.map((item, index) => {
    const activeSpan = Math.max(items.length - ITEMS_PER_ROOM, 1);
    const roomPosition = new Decimal(index - (ITEMS_PER_ROOM - 1) / 2)
      .mul(TARGET_ROOM_COUNT - 1)
      .div(activeSpan);
    const ideal = new Decimal(10).pow(interpolateLog(monotonicLogs, roomPosition));
    const readable = nearestReadableInteger(ideal, previous);
    previous = readable;
    return { id: item.id, sellPrice: readable.toFixed(0) };
  });
}

function interpolateLog(logs: Decimal[], position: Decimal) {
  const lower = position.floor().toNumber();
  if (lower < 0) {
    const slope = logs[1].minus(logs[0]);
    return logs[0].plus(slope.mul(position));
  }
  if (lower >= logs.length - 1) {
    const slope = logs.at(-1)!.minus(logs.at(-2)!);
    return logs.at(-1)!.plus(slope.mul(position.minus(logs.length - 1)));
  }
  const fraction = position.minus(lower);
  return logs[lower].plus(logs[lower + 1].minus(logs[lower]).mul(fraction));
}

function nearestReadableInteger(ideal: Decimal, previous: Decimal) {
  const safeIdeal = Decimal.max(10, ideal);
  const exponent = Decimal.floor(Decimal.log(safeIdeal, 10)).toNumber();
  const candidates: Decimal[] = [];
  for (let candidateExponent = Math.max(0, exponent - 2); candidateExponent <= exponent + 3; candidateExponent += 1) {
    READABLE_MANTISSAS.forEach((mantissa) => {
      const candidate = new Decimal(mantissa).mul(new Decimal(10).pow(candidateExponent));
      if (candidate.isInteger() && candidate.greaterThan(previous)) candidates.push(candidate);
    });
  }
  if (candidates.length === 0) return previous.mul(1.2).ceil();
  return candidates.reduce((best, candidate) => {
    const bestDistance = ratioDistance(best, safeIdeal);
    const candidateDistance = ratioDistance(candidate, safeIdeal);
    return candidateDistance.lessThan(bestDistance) ? candidate : best;
  }, candidates[0]);
}

function ratioDistance(left: Decimal, right: Decimal) {
  return left.greaterThanOrEqualTo(right) ? left.div(right) : right.div(left);
}

export function buildStretchedRoomDrops(items: SellItem[], prices: Map<string, Decimal>, targets: Decimal[]): RoomDrop[] {
  const maximumStart = items.length - ITEMS_PER_ROOM;
  let previousStart = 0;
  return targets.map((target, roomOffset) => {
    const expectedStart = (roomOffset * maximumStart) / Math.max(targets.length - 1, 1);
    const starts = roomOffset === 0
      ? [0]
      : roomOffset === targets.length - 1
      ? [maximumStart]
      : Array.from({ length: maximumStart - previousStart + 1 }, (_, index) => previousStart + index);
    const best = starts.map((start) => {
      const pool = items.slice(start, start + ITEMS_PER_ROOM);
      const weights = fitIntegerWeights(pool, prices, target);
      const value = expectedValue(pool, weights, prices);
      const relativeError = value.minus(target).abs().div(target).toNumber();
      return { start, pool, weights, score: relativeError + Math.abs(start - expectedStart) * 1e-10 };
    }).sort((left, right) => left.score - right.score || left.start - right.start)[0];
    previousStart = best.start;
    return {
      index: roomOffset + 1,
      drops: best.pool.map((item, index) => ({ itemId: item.id, weight: String(best.weights[index]) })),
    };
  });
}

function expectedValue(items: SellItem[], weights: number[], prices: Map<string, Decimal>) {
  return items.reduce((sum, item, index) => (
    sum.plus((prices.get(item.id) ?? new Decimal(0)).mul(weights[index]).div(100))
  ), new Decimal(0));
}

function fitIntegerWeights(items: SellItem[], prices: Map<string, Decimal>, target: Decimal) {
  const itemPrices = items.map((item) => prices.get(item.id) ?? new Decimal(0));
  const remainingWeight = 100 - MINIMUM_WEIGHT * items.length;
  const baseline = itemPrices.reduce((sum, price) => sum.plus(price.mul(MINIMUM_WEIGHT)), new Decimal(0));
  const targetForRemainder = target.mul(100).minus(baseline).div(remainingWeight);
  const baseLogs = BASE_WEIGHTS.map((weight) => Math.log(weight));

  const distribution = (tilt: number) => {
    const low = itemPrices[0];
    const span = Decimal.max(1, itemPrices.at(-1)!.minus(low));
    const logits = itemPrices.map((price, index) => baseLogs[index] + tilt * price.minus(low).div(span).toNumber());
    const maxLogit = Math.max(...logits);
    const raw = logits.map((logit) => Math.exp(logit - maxLogit));
    const total = raw.reduce((sum, value) => sum + value, 0);
    const shares = raw.map((value) => value / total);
    const mean = shares.reduce((sum, share, index) => sum.plus(itemPrices[index].mul(share)), new Decimal(0));
    return { shares, mean };
  };

  let lower = -1;
  let upper = 1;
  while (distribution(lower).mean.greaterThan(targetForRemainder) && lower > -1e8) lower *= 2;
  while (distribution(upper).mean.lessThan(targetForRemainder) && upper < 1e8) upper *= 2;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (distribution(middle).mean.lessThan(targetForRemainder)) lower = middle;
    else upper = middle;
  }
  const shares = distribution((lower + upper) / 2).shares;
  const ideals = shares.map((share) => MINIMUM_WEIGHT + remainingWeight * share);
  return apportionWholePercentages(ideals);
}

function apportionWholePercentages(ideals: number[]) {
  const allocated = ideals.map((value) => Math.max(MINIMUM_WEIGHT, Math.floor(value)));
  let residue = 100 - allocated.reduce((sum, value) => sum + value, 0);
  const order = ideals.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  let cursor = 0;
  while (residue > 0) {
    allocated[order[cursor % order.length].index] += 1;
    residue -= 1;
    cursor += 1;
  }
  while (residue < 0) {
    const candidate = [...allocated.keys()].sort((left, right) => allocated[right] - allocated[left])[0];
    if (allocated[candidate] <= MINIMUM_WEIGHT) break;
    allocated[candidate] -= 1;
    residue += 1;
  }
  return allocated;
}

function extendRoomsTo50(configs: ConfigTextMap, count: number) {
  const known = parseKnownConfigs(configs);
  const rooms = known.rooms.slice(0, count).map((room) => ({ ...room }));
  const last = rooms.at(-1)!;
  const previous = rooms.at(-2)!;
  const hpRatio = new Decimal(last.blockMaxHP).div(previous.blockMaxHP);
  while (rooms.length < count) {
    const prior = rooms.at(-1)!;
    rooms.push({
      index: rooms.length + 1,
      blockMaxHP: new Decimal(prior.blockMaxHP).mul(hpRatio).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
      roomLengthCells: prior.roomLengthCells,
      barrierLayers: prior.barrierLayers,
    });
  }
  const finalRoom = rooms.at(-1)!;
  return stringifyExactJson({
    rooms: rooms.map((room) => ({
      index: exactNumber(String(room.index)),
      blockMaxHP: exactNumber(room.blockMaxHP),
      roomLengthCells: exactNumber(room.roomLengthCells),
      barrierLayers: exactNumber(room.barrierLayers),
    })),
    beyondLastRoom: {
      ...Object.fromEntries(Object.entries(known.beyondLastRoom).map(([key, value]) => [key, exactNumber(value)])),
      blockMaxHP: exactNumber(finalRoom.blockMaxHP),
      roomLengthCells: exactNumber(finalRoom.roomLengthCells),
      barrierLayers: exactNumber(finalRoom.barrierLayers),
      maxBlockHP: exactNumber(finalRoom.blockMaxHP),
    },
  });
}
