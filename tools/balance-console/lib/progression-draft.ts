import Decimal from 'decimal.js';
import { buildRoomEconomy, log10ForChart } from './analytics';
import { parseKnownConfigs, type ConfigTextMap, type RoomDrop } from './config-model';
import { exactNumber, parseExactJson, stringifyExactJson, updateAtPointer, type ExactJson } from './exact-json';
import { roomHpUsesIntegerLiterals } from './room-hp';

type Update = { pointer: string; value: ExactJson };

export const REWARD_GROWTH_MULTIPLIER = 2.4568;
const INTEGER_REWARD_STEP_SPREAD = 0.3;

export function createSmoothProgressionDraft(configs: ConfigTextMap): ConfigTextMap {
  if (isSmoothProgression(configs)) return configs;

  const known = parseKnownConfigs(configs);
  const economy = buildRoomEconomy(known);
  if (known.rooms.length < 2 || economy.length !== known.rooms.length) return configs;

  const roomCount = known.rooms.length;
  const firstHp = new Decimal(known.rooms[0].blockMaxHP);
  const lastHp = new Decimal(known.rooms.at(-1)?.blockMaxHP ?? firstHp);
  const hpRatio = lastHp.div(firstHp);
  const hpUpdates: Update[] = known.rooms.map((room, index) => {
    const value = index === 0
      ? firstHp
      : index === roomCount - 1
        ? lastHp
        : firstHp.mul(hpRatio.pow(new Decimal(index).div(roomCount - 1)));
    return {
      pointer: `$/rooms/${index}/blockMaxHP`,
      value: exactNumber(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)),
    };
  });

  const firstReward = Number(economy[0].expectedItemPrice);
  const logRewardStart = Math.log10(firstReward);
  const logRewardEnd = logRewardStart + Math.log10(REWARD_GROWTH_MULTIPLIER) * (roomCount - 1);
  const targetRewards = economy.map((_, index) => targetAt(index, roomCount, logRewardStart, logRewardEnd));

  const uses = new Map<string, Array<{ index: number; weight: number }>>(
    known.sellItems.map((item) => [item.id, []]),
  );
  known.roomDrops.forEach((room, index) => {
    room.drops.forEach((drop) => uses.get(drop.itemId)?.push({ index, weight: Number(drop.weight) }));
  });

  const draftPrices = new Map<string, number>();
  known.sellItems.forEach((item) => {
    const itemUses = uses.get(item.id) ?? [];
    if (itemUses.length === 0) {
      draftPrices.set(item.id, Number(item.sellPrice));
      return;
    }
    const weightTotal = itemUses.reduce((sum, use) => sum + use.weight, 0);
    const averageRoom = itemUses.reduce((sum, use) => sum + use.index * use.weight, 0) / weightTotal;
    draftPrices.set(item.id, targetAt(averageRoom, roomCount, logRewardStart, logRewardEnd));
  });

  const lowWitnesses = new Set<string>();
  known.roomDrops.forEach((room, index) => {
    const witness = [...room.drops].sort((left, right) => {
      const useDifference = (uses.get(left.itemId)?.length ?? 0) - (uses.get(right.itemId)?.length ?? 0);
      return useDifference || priceOf(draftPrices, left.itemId) - priceOf(draftPrices, right.itemId);
    })[0];
    if (!witness) return;
    lowWitnesses.add(witness.itemId);
    draftPrices.set(witness.itemId, Math.min(priceOf(draftPrices, witness.itemId), targetRewards[index] * 0.25));
  });

  for (let index = known.roomDrops.length - 1; index >= 0; index -= 1) {
    const room = known.roomDrops[index];
    const unusedByLowPass = room.drops.filter((drop) => !lowWitnesses.has(drop.itemId));
    const candidates = unusedByLowPass.length > 0 ? unusedByLowPass : room.drops;
    const witness = [...candidates].sort((left, right) => {
      const useDifference = (uses.get(left.itemId)?.length ?? 0) - (uses.get(right.itemId)?.length ?? 0);
      return useDifference || priceOf(draftPrices, right.itemId) - priceOf(draftPrices, left.itemId);
    })[0];
    if (!witness) continue;
    draftPrices.set(witness.itemId, Math.max(priceOf(draftPrices, witness.itemId), targetRewards[index] * 4));
  }

  const roundedPrices = new Map<string, number>();
  const priceUpdates: Update[] = known.sellItems.map((item, index) => {
    const rounded = new Decimal(priceOf(draftPrices, item.id)).toSignificantDigits(10).toString();
    roundedPrices.set(item.id, Number(rounded));
    return { pointer: `$/items/${index}/sellPrice`, value: exactNumber(rounded) };
  });

  const weightUpdates: Update[] = [];
  known.roomDrops.forEach((room, roomIndex) => {
    const weights = fitWeightsToTarget(room, targetRewards[roomIndex], roundedPrices);
    weights.forEach((weight, dropIndex) => {
      weightUpdates.push({
        pointer: `$/${roomIndex}/drops/${dropIndex}/weight`,
        value: exactNumber(weight),
      });
    });
  });

  return {
    ...configs,
    Rooms: applyUpdates(configs.Rooms, hpUpdates),
    SellItems: applyUpdates(configs.SellItems, priceUpdates),
    RoomDrops: applyUpdates(configs.RoomDrops, weightUpdates),
  };
}

export function isSmoothProgression(configs: ConfigTextMap) {
  try {
    if (!roomHpUsesIntegerLiterals(configs)) return false;
    const economy = buildRoomEconomy(configs);
    if (economy.length < 3) return false;
    const hpSteps = stepSizes(economy.map((room) => log10ForChart(room.blockMaxHP)));
    const rewardSteps = stepSizes(economy.map((room) => log10ForChart(room.expectedItemPrice)));
    const averageRewardStep = rewardSteps.reduce((sum, step) => sum + step, 0) / rewardSteps.length;
    return hpSteps.every((step) => step > 0)
      && rewardSteps.every((step) => step > 0)
      && spread(hpSteps) < 0.01
      && spread(rewardSteps) < INTEGER_REWARD_STEP_SPREAD
      && Math.abs(averageRewardStep - Math.log10(REWARD_GROWTH_MULTIPLIER)) < 0.01;
  } catch {
    return false;
  }
}

function fitWeightsToTarget(room: RoomDrop, target: number, prices: Map<string, number>) {
  const itemPrices = room.drops.map((drop) => priceOf(prices, drop.itemId));
  const minimum = Math.min(...itemPrices);
  const maximum = Math.max(...itemPrices);
  if (maximum <= minimum) return normalizedOriginalWeights(room);

  const minimumWeight = 0;
  const remainingWeight = 100 - minimumWeight * room.drops.length;
  const baselineContribution = minimumWeight * itemPrices.reduce((sum, price) => sum + price, 0);
  const remainingTarget = (target * 100 - baselineContribution) / remainingWeight;
  const normalizedPrices = itemPrices.map((price) => (price - minimum) / (maximum - minimum));
  const originalLogWeights = room.drops.map((drop) => Math.log(Math.max(Number(drop.weight), 1e-9)));

  const distribution = (lambda: number) => {
    const logits = normalizedPrices.map((price, index) => originalLogWeights[index] + lambda * price);
    const maximumLogit = Math.max(...logits);
    const raw = logits.map((logit) => Math.exp(logit - maximumLogit));
    const total = raw.reduce((sum, value) => sum + value, 0);
    const weights = raw.map((value) => value / total);
    const mean = weights.reduce((sum, weight, index) => sum + weight * itemPrices[index], 0);
    return { weights, mean };
  };

  let lower = -1;
  let upper = 1;
  while (distribution(lower).mean > remainingTarget && lower > -1e16) lower *= 10;
  while (distribution(upper).mean < remainingTarget && upper < 1e16) upper *= 10;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (distribution(middle).mean < remainingTarget) lower = middle;
    else upper = middle;
  }

  const fitted = distribution((lower + upper) / 2).weights
    .map((weight) => new Decimal(minimumWeight + remainingWeight * weight));
  return apportionIntegerPercentages(fitted);
}

function normalizedOriginalWeights(room: RoomDrop) {
  const total = room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0));
  return apportionIntegerPercentages(room.drops.map((drop) => new Decimal(drop.weight).div(total).mul(100)));
}

function apportionIntegerPercentages(ideals: Decimal[]) {
  const allocated = ideals.map((value) => Decimal.max(0, value).floor());
  let residue = new Decimal(100).minus(allocated.reduce((sum, value) => sum.plus(value), new Decimal(0)));
  const order = ideals.map((value, index) => ({ index, remainder: value.minus(value.floor()) }))
    .sort((left, right) => right.remainder.comparedTo(left.remainder) || left.index - right.index);
  let cursor = 0;
  while (residue.greaterThan(0) && order.length > 0) {
    const index = order[cursor % order.length].index;
    allocated[index] = allocated[index].plus(1);
    residue = residue.minus(1);
    cursor += 1;
  }
  return allocated.map((value) => value.toFixed(0));
}

function targetAt(position: number, count: number, start: number, end: number) {
  return 10 ** (start + ((end - start) * position) / Math.max(count - 1, 1));
}

function applyUpdates(source: string, updates: Update[]) {
  let root = parseExactJson(source);
  updates.forEach((update) => { root = updateAtPointer(root, update.pointer, update.value); });
  return stringifyExactJson(root);
}

function priceOf(prices: Map<string, number>, itemId: string) {
  return prices.get(itemId) ?? 0;
}

function stepSizes(values: number[]) {
  return values.slice(1).map((value, index) => value - values[index]);
}

function spread(values: number[]) {
  return Math.max(...values) - Math.min(...values);
}
