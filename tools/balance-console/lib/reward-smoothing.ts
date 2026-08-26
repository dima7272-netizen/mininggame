import Decimal from 'decimal.js';
import { buildRoomEconomy, log10ForChart } from './analytics';
import { parseKnownConfigs, type ConfigTextMap, type RoomDrop, type SellItem } from './config-model';
import { exactNumber, stringifyExactJson } from './exact-json';
import { buildStretchedPrices } from './reward-expansion';
import { retiredRewardItemIds, rewardHierarchyItemIds } from './reward-groups';
import { serializeReadableSellItems } from './reward-pricing';
import { serializeRoomDrops } from './reward-progression';

const TARGET_ROOM_COUNT = 50;
const ITEMS_PER_WINDOW = 8;
const BASE_WEIGHTS = [30, 22, 16, 12, 8, 6, 4, 2];
const LOWEST_VALUE_WEIGHTS = [93, 1, 1, 1, 1, 1, 1, 1];
const HIGHEST_VALUE_WEIGHTS = [13, 13, 13, 13, 12, 12, 12, 12];
const READABLE_MANTISSAS = new Set(['1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '7']);
const RISING_LIFECYCLE_ROOM_COUNT = 56;
const RISING_LIFECYCLE_ITEMS_PER_ROOM = 10;
const RISING_LIFECYCLE_ROOM_WEIGHTS = [50, 13, 9, 7, 6, 5, 4, 3, 2, 1];
const STRAIGHT_TRAJECTORY_GROWTH = new Decimal('2.5');
const STRAIGHT_TRAJECTORY_STARTER_PRICES = ['20', '25', '30', '40', '50', '70', '100', '120', '150', '200'];

export type RewardSmoothingReport = {
  roomCount: number;
  itemCount: number;
  averageGrowth: number;
  maximumLogStepDeviation: number;
};

export type RewardLifecycleReport = RewardSmoothingReport & {
  maximumTypesPerRoom: number;
};

/**
 * Rebuilds the reward economy on one straight logarithmic trajectory while
 * keeping every sell price a readable whole number. The first and last room
 * values are anchors, so smoothing removes the internal cliffs without moving
 * either end of the progression.
 */
export function smoothRewardPrices(configs: ConfigTextMap): ConfigTextMap {
  return buildSmoothRewardPrices(configs).configs;
}

export function buildSmoothRewardPrices(configs: ConfigTextMap): {
  configs: ConfigTextMap;
  report: RewardSmoothingReport;
} {
  const known = parseKnownConfigs(configs);
  const retired = new Set(retiredRewardItemIds);
  const isExpandedRewardSet = known.sellItems.length === rewardHierarchyItemIds.length
    && known.sellItems.every((item, index) => item.id === rewardHierarchyItemIds[index])
    && known.sellItems.every((item) => !retired.has(item.id));
  if (!isExpandedRewardSet || known.rooms.length !== TARGET_ROOM_COUNT || known.roomDrops.length !== TARGET_ROOM_COUNT) {
    return { configs, report: emptyReport(known.rooms.length, known.sellItems.length) };
  }

  const economy = buildRoomEconomy(known);
  const firstReward = new Decimal(economy[0]?.expectedItemPrice ?? 0);
  const lastReward = new Decimal(economy.at(-1)?.expectedItemPrice ?? 0);
  if (!firstReward.isFinite() || !lastReward.isFinite() || firstReward.lessThanOrEqualTo(0) || lastReward.lessThanOrEqualTo(firstReward)) {
    return { configs, report: emptyReport(known.rooms.length, known.sellItems.length) };
  }

  const currentSteps = rewardSteps(economy);
  const currentAverageStep = average(currentSteps);
  const currentMaximumDeviation = maximumDeviation(currentSteps, currentAverageStep);
  if (currentSteps.every((step) => step > 0)
    && currentMaximumDeviation < 0.12
    && known.sellItems.every((item) => isReadableWholePrice(item.sellPrice))) {
    return {
      configs,
      report: {
        roomCount: TARGET_ROOM_COUNT,
        itemCount: known.sellItems.length,
        averageGrowth: 10 ** currentAverageStep,
        maximumLogStepDeviation: currentMaximumDeviation,
      },
    };
  }

  const targets = geometricTargets(firstReward, lastReward, TARGET_ROOM_COUNT);
  const repricedItems = buildStretchedPrices(known.sellItems, targets);
  const prices = new Map(repricedItems.map((item) => [item.id, Number(item.sellPrice)]));
  const roomDrops = buildMonotoneRoomDrops(repricedItems, prices, targets);
  const nextConfigs: ConfigTextMap = {
    ...configs,
    SellItems: serializeReadableSellItems(known.sellSettings, repricedItems),
    RoomDrops: serializeRoomDrops(roomDrops),
  };
  const nextEconomy = buildRoomEconomy(nextConfigs);
  const steps = rewardSteps(nextEconomy);
  const averageStep = average(steps);
  const maximumLogStepDeviation = maximumDeviation(steps, averageStep);

  return {
    configs: nextConfigs,
    report: {
      roomCount: TARGET_ROOM_COUNT,
      itemCount: repricedItems.length,
      averageGrowth: 10 ** averageStep,
      maximumLogStepDeviation,
    },
  };
}

/**
 * Removes low-percentage tails from cheaper rewards without changing the
 * already-smoothed price ladder. Every active room is ordered from the older,
 * cheaper reward to the newer, more expensive reward and its percentages may
 * only stay equal or decrease in that direction.
 */
export function buildCleanRewardLifecycles(configs: ConfigTextMap): {
  configs: ConfigTextMap;
  report: RewardLifecycleReport;
} {
  const known = parseKnownConfigs(configs);
  if (known.sellItems.length !== rewardHierarchyItemIds.length
    || known.rooms.length !== TARGET_ROOM_COUNT
    || known.roomDrops.length !== TARGET_ROOM_COUNT) {
    return { configs, report: { ...emptyReport(known.rooms.length, known.sellItems.length), maximumTypesPerRoom: 0 } };
  }
  if (hasCleanLifecycles(known.roomDrops)) {
    const economy = buildRoomEconomy(known);
    const steps = rewardSteps(economy);
    const mean = average(steps);
    return {
      configs,
      report: {
        roomCount: known.rooms.length,
        itemCount: known.sellItems.length,
        averageGrowth: 10 ** mean,
        maximumLogStepDeviation: maximumDeviation(steps, mean),
        maximumTypesPerRoom: Math.max(...known.roomDrops.map((room) => room.drops.length)),
      },
    };
  }

  const economy = buildRoomEconomy(known);
  const firstReward = new Decimal(economy[0].expectedItemPrice);
  const lastReward = new Decimal(economy.at(-1)!.expectedItemPrice);
  const targets = geometricTargets(firstReward, lastReward, TARGET_ROOM_COUNT);
  const prices = new Map(known.sellItems.map((item) => [item.id, Number(item.sellPrice)]));
  const roomDrops = buildMonotoneRoomDrops(known.sellItems, prices, targets);
  const nextConfigs = { ...configs, RoomDrops: serializeRoomDrops(roomDrops) };
  const nextEconomy = buildRoomEconomy(nextConfigs);
  const steps = rewardSteps(nextEconomy);
  const mean = average(steps);
  return {
    configs: nextConfigs,
    report: {
      roomCount: TARGET_ROOM_COUNT,
      itemCount: known.sellItems.length,
      averageGrowth: 10 ** mean,
      maximumLogStepDeviation: maximumDeviation(steps, mean),
      maximumTypesPerRoom: Math.max(...roomDrops.map((room) => room.drops.length)),
    },
  };
}

/**
 * Gives each reward one predictable lifecycle. A newly introduced reward
 * starts at 1%, gains probability in every following room and reaches 50%
 * immediately before it leaves the visible ten-item window. Sliding the
 * window once per room lets all 65 active rewards fit into 56 rooms without
 * fractional percentages or a low-value tail after an item's peak.
 */
export function buildRisingRewardLifecycles(configs: ConfigTextMap): {
  configs: ConfigTextMap;
  report: RewardLifecycleReport;
} {
  const known = parseKnownConfigs(configs);
  const hasExpectedItems = known.sellItems.length === rewardHierarchyItemIds.length
    && known.sellItems.every((item, index) => item.id === rewardHierarchyItemIds[index]);
  const canExtend = known.rooms.length >= 2 && known.roomDrops.length >= 2;
  if (!hasExpectedItems || !canExtend) {
    return { configs, report: { ...emptyReport(known.rooms.length, known.sellItems.length), maximumTypesPerRoom: 0 } };
  }

  if (hasRisingLifecycle(known.roomDrops, known.sellItems)) {
    const economy = buildRoomEconomy(known);
    const steps = rewardSteps(economy);
    const mean = average(steps);
    return {
      configs,
      report: {
        roomCount: known.rooms.length,
        itemCount: known.sellItems.length,
        averageGrowth: 10 ** mean,
        maximumLogStepDeviation: maximumDeviation(steps, mean),
        maximumTypesPerRoom: RISING_LIFECYCLE_ITEMS_PER_ROOM,
      },
    };
  }

  const roomDrops = buildRisingLifecycleDrops(known.sellItems);
  const rooms = extendRooms(configs, RISING_LIFECYCLE_ROOM_COUNT);
  const nextConfigs = {
    ...configs,
    Rooms: rooms,
    RoomDrops: serializeRoomDrops(roomDrops),
  };
  const nextEconomy = buildRoomEconomy(nextConfigs);
  const steps = rewardSteps(nextEconomy);
  const mean = average(steps);
  return {
    configs: nextConfigs,
    report: {
      roomCount: RISING_LIFECYCLE_ROOM_COUNT,
      itemCount: known.sellItems.length,
      averageGrowth: 10 ** mean,
      maximumLogStepDeviation: maximumDeviation(steps, mean),
      maximumTypesPerRoom: RISING_LIFECYCLE_ITEMS_PER_ROOM,
    },
  };
}

/**
 * Reprices the fixed 1→50% lifecycle so expected room rewards follow the
 * straight red reference trajectory: roughly ×2.5 per room from log10 1.58
 * to log10 23.47. Every stored price remains a readable whole number.
 */
export function buildStraightRewardTrajectory(configs: ConfigTextMap): {
  configs: ConfigTextMap;
  report: RewardSmoothingReport;
} {
  const known = parseKnownConfigs(configs);
  const validLifecycle = known.rooms.length === RISING_LIFECYCLE_ROOM_COUNT
    && hasRisingLifecycle(known.roomDrops, known.sellItems);
  if (!validLifecycle || known.sellItems.length !== rewardHierarchyItemIds.length) {
    return { configs, report: emptyReport(known.rooms.length, known.sellItems.length) };
  }

  const repricedItems = buildStraightTrajectoryPrices(known.sellItems);
  const alreadyRepriced = known.sellItems.every((item, index) => item.sellPrice === repricedItems[index].sellPrice);
  const nextConfigs = alreadyRepriced
    ? configs
    : { ...configs, SellItems: serializeReadableSellItems(known.sellSettings, repricedItems) };
  const economy = buildRoomEconomy(nextConfigs);
  const steps = rewardSteps(economy);
  const mean = average(steps);
  return {
    configs: nextConfigs,
    report: {
      roomCount: known.rooms.length,
      itemCount: repricedItems.length,
      averageGrowth: 10 ** mean,
      maximumLogStepDeviation: maximumDeviation(steps, mean),
    },
  };
}

function buildStraightTrajectoryPrices(items: SellItem[]): SellItem[] {
  const prices = STRAIGHT_TRAJECTORY_STARTER_PRICES.map((price) => new Decimal(price));
  const firstExpectedReward = expectedLifecycleReward(prices, 0);
  for (let roomOffset = 1; roomOffset < RISING_LIFECYCLE_ROOM_COUNT; roomOffset += 1) {
    const target = firstExpectedReward.mul(STRAIGHT_TRAJECTORY_GROWTH.pow(roomOffset));
    const knownContribution = RISING_LIFECYCLE_ROOM_WEIGHTS.slice(0, -1).reduce((sum, weight, index) => (
      sum.plus(prices[roomOffset + index].mul(weight).div(100))
    ), new Decimal(0));
    const idealNewPrice = target.minus(knownContribution).mul(100);
    prices.push(nearestReadablePrice(idealNewPrice, prices.at(-1)!));
  }
  return items.map((item, index) => ({ id: item.id, sellPrice: prices[index].toFixed(0) }));
}

function expectedLifecycleReward(prices: Decimal[], offset: number) {
  return RISING_LIFECYCLE_ROOM_WEIGHTS.reduce((sum, weight, index) => (
    sum.plus(prices[offset + index].mul(weight).div(100))
  ), new Decimal(0));
}

function nearestReadablePrice(ideal: Decimal, previous: Decimal) {
  const safeIdeal = Decimal.max(previous.plus(1), ideal);
  const exponent = Decimal.floor(Decimal.log(safeIdeal, 10)).toNumber();
  const candidates: Decimal[] = [];
  for (let candidateExponent = Math.max(0, exponent - 2); candidateExponent <= exponent + 3; candidateExponent += 1) {
    READABLE_MANTISSAS.forEach((mantissa) => {
      const candidate = new Decimal(mantissa).mul(new Decimal(10).pow(candidateExponent));
      if (candidate.isInteger() && candidate.greaterThan(previous)) candidates.push(candidate);
    });
  }
  return candidates.reduce((best, candidate) => (
    ratioDistance(candidate, safeIdeal).lessThan(ratioDistance(best, safeIdeal)) ? candidate : best
  ));
}

function ratioDistance(left: Decimal, right: Decimal) {
  return left.greaterThanOrEqualTo(right) ? left.div(right) : right.div(left);
}

function buildRisingLifecycleDrops(items: SellItem[]): RoomDrop[] {
  return Array.from({ length: RISING_LIFECYCLE_ROOM_COUNT }, (_, roomOffset) => ({
    index: roomOffset + 1,
    drops: items.slice(roomOffset, roomOffset + RISING_LIFECYCLE_ITEMS_PER_ROOM).map((item, index) => ({
      itemId: item.id,
      weight: String(RISING_LIFECYCLE_ROOM_WEIGHTS[index]),
    })),
  }));
}

function hasRisingLifecycle(rooms: RoomDrop[], items: SellItem[]) {
  if (rooms.length !== RISING_LIFECYCLE_ROOM_COUNT) return false;
  return rooms.every((room, roomOffset) => {
    const expectedItems = items.slice(roomOffset, roomOffset + RISING_LIFECYCLE_ITEMS_PER_ROOM);
    return room.index === roomOffset + 1
      && room.drops.length === RISING_LIFECYCLE_ITEMS_PER_ROOM
      && room.drops.every((drop, index) => (
        drop.itemId === expectedItems[index]?.id
        && Number(drop.weight) === RISING_LIFECYCLE_ROOM_WEIGHTS[index]
      ));
  });
}

function extendRooms(configs: ConfigTextMap, count: number) {
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

function buildMonotoneRoomDrops(items: SellItem[], prices: Map<string, number>, targets: Decimal[]): RoomDrop[] {
  const maximumStart = items.length - ITEMS_PER_WINDOW;
  let previousStart = 0;
  return targets.map((target, roomOffset) => {
    const expectedStart = roomOffset * maximumStart / Math.max(targets.length - 1, 1);
    const expectedFloor = Math.floor(expectedStart);
    const searchStart = Math.max(previousStart, expectedFloor - 5);
    const searchEnd = Math.min(maximumStart, Math.ceil(expectedStart) + 5);
    const starts = roomOffset === 0
      ? [0]
      : roomOffset === targets.length - 1
        ? [maximumStart]
        : Array.from({ length: Math.max(1, searchEnd - searchStart + 1) }, (_, index) => searchStart + index);
    const targetNumber = target.toNumber();
    const best = starts.flatMap((start) => {
      const pool = items.slice(start, start + ITEMS_PER_WINDOW);
      return monotoneWeightCandidates().map((weights) => {
        const value = pool.reduce((sum, item, index) => (
          sum + (prices.get(item.id) ?? 0) * weights[index] / 100
        ), 0);
        const targetDistance = Math.abs(Math.log10(value / targetNumber));
        const positionPenalty = Math.abs(start - expectedStart) * 1e-8;
        return { start, pool, weights, score: targetDistance + positionPenalty };
      });
    }).sort((left, right) => left.score - right.score || left.start - right.start)[0];
    previousStart = best.start;
    return {
      index: roomOffset + 1,
      drops: best.pool.map((item, index) => ({ itemId: item.id, weight: String(best.weights[index]) })),
    };
  });
}

let cachedWeightCandidates: number[][] | null = null;
function monotoneWeightCandidates() {
  if (cachedWeightCandidates) return cachedWeightCandidates;
  const candidates: number[][] = [];
  for (let step = 0; step <= 100; step += 2) {
    const fraction = step / 100;
    candidates.push(apportionWholePercentages(LOWEST_VALUE_WEIGHTS.map((weight, index) => (
      weight + (BASE_WEIGHTS[index] - weight) * fraction
    ))));
    candidates.push(apportionWholePercentages(BASE_WEIGHTS.map((weight, index) => (
      weight + (HIGHEST_VALUE_WEIGHTS[index] - weight) * fraction
    ))));
  }
  cachedWeightCandidates = [...new Map(candidates.map((weights) => [weights.join(','), weights])).values()]
    .filter((weights) => weights.every((weight, index) => index === 0 || weights[index - 1] >= weight));
  return cachedWeightCandidates;
}

function hasCleanLifecycles(rooms: RoomDrop[]) {
  return rooms.every((room) => room.drops.length === ITEMS_PER_WINDOW
    && room.drops.every((drop, index) => {
      const weight = Number(drop.weight);
      return Number.isInteger(weight) && weight >= 1
        && (index === 0 || Number(room.drops[index - 1].weight) >= weight);
    })
    && room.drops.reduce((sum, drop) => sum + Number(drop.weight), 0) === 100);
}

function apportionWholePercentages(ideals: number[]) {
  const allocated = ideals.map((value) => Math.floor(Math.max(0, value)));
  let residue = 100 - allocated.reduce((sum, value) => sum + value, 0);
  const order = ideals.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let cursor = 0; residue > 0; cursor += 1, residue -= 1) {
    allocated[order[cursor % order.length].index] += 1;
  }
  return allocated;
}

function geometricTargets(first: Decimal, last: Decimal, count: number) {
  const ratio = last.div(first).pow(new Decimal(1).div(Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => first.mul(ratio.pow(index)));
}

function rewardSteps(economy: ReturnType<typeof buildRoomEconomy>) {
  return economy.slice(1).map((room, index) => (
    log10ForChart(room.expectedItemPrice) - log10ForChart(economy[index].expectedItemPrice)
  ));
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function maximumDeviation(values: number[], mean: number) {
  return Math.max(0, ...values.map((value) => Math.abs(value - mean)));
}

function isReadableWholePrice(value: string) {
  const price = new Decimal(value);
  if (!price.isInteger() || price.lessThan(10)) return false;
  const exponent = Decimal.floor(Decimal.log(price, 10));
  const mantissa = price.div(new Decimal(10).pow(exponent)).toSignificantDigits(2).toString();
  return READABLE_MANTISSAS.has(mantissa);
}

function emptyReport(roomCount: number, itemCount: number): RewardSmoothingReport {
  return { roomCount, itemCount, averageGrowth: 1, maximumLogStepDeviation: 0 };
}
