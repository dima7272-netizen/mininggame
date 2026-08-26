import Decimal from 'decimal.js';
import { buildRoomEconomy, log10ForChart } from './analytics';
import { parseKnownConfigs, type ConfigTextMap, type RoomDrop, type SellItem } from './config-model';
import { buildStretchedPrices } from './reward-expansion';
import { retiredRewardItemIds, rewardHierarchyItemIds } from './reward-groups';
import { serializeReadableSellItems } from './reward-pricing';
import { serializeRoomDrops } from './reward-progression';

const TARGET_ROOM_COUNT = 50;
const ITEMS_PER_WINDOW = 8;
const BASE_WEIGHTS = [30, 22, 16, 12, 8, 6, 4, 2];
const READABLE_MANTISSAS = new Set(['1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '7']);

export type RewardSmoothingReport = {
  roomCount: number;
  itemCount: number;
  averageGrowth: number;
  maximumLogStepDeviation: number;
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
  const roomDrops = buildBlendedRoomDrops(repricedItems);
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
 * Slides the familiar 30/22/16/12/8/6/4/2 distribution through the catalogue.
 * Between two catalogue positions the adjacent distributions are blended, so
 * a room contains eight or nine reward types and never needs a 90% filler.
 */
function buildBlendedRoomDrops(items: SellItem[]): RoomDrop[] {
  const maximumStart = Math.max(0, items.length - ITEMS_PER_WINDOW);
  return Array.from({ length: TARGET_ROOM_COUNT }, (_, roomOffset) => {
    const position = roomOffset * maximumStart / Math.max(TARGET_ROOM_COUNT - 1, 1);
    const start = Math.min(maximumStart, Math.floor(position));
    const fraction = Math.min(1, Math.max(0, position - start));
    if (start === maximumStart || fraction < 1e-9) {
      return {
        index: roomOffset + 1,
        drops: items.slice(start, start + ITEMS_PER_WINDOW)
          .map((item, index) => ({ itemId: item.id, weight: String(BASE_WEIGHTS[index]) })),
      };
    }

    const idealWeights = Array.from({ length: ITEMS_PER_WINDOW + 1 }, (_, index) => {
      const outgoing = index < ITEMS_PER_WINDOW ? BASE_WEIGHTS[index] * (1 - fraction) : 0;
      const incoming = index > 0 ? BASE_WEIGHTS[index - 1] * fraction : 0;
      return outgoing + incoming;
    });
    const weights = apportionWholePercentages(idealWeights);
    return {
      index: roomOffset + 1,
      drops: items.slice(start, start + ITEMS_PER_WINDOW + 1)
        .map((item, index) => ({ itemId: item.id, weight: String(weights[index]) }))
        .filter((drop) => drop.weight !== '0'),
    };
  });
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
