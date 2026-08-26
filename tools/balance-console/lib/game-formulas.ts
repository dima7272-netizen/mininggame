import Decimal from 'decimal.js';

Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

export const MINIMUM_MINING_DAMAGE = new Decimal(10);
export const MINING_DAMAGE_PER_STRENGTH = new Decimal('0.2');
export const FRIEND_BOOST_PER_FRIEND_PERCENT = new Decimal(5);
export const PICKAXE_SWING_INTERVAL_SECONDS = new Decimal('0.55');
export const PICKAXE_CONTACT_DELAY_SECONDS = PICKAXE_SWING_INTERVAL_SECONDS.mul('0.45');
export const MAX_GAME_STAT = new Decimal('1e30');
export const INDEX_COMPLETION_STRENGTH_MULTIPLIER = new Decimal('1.5');
export const FREE_REWARD_STRENGTH_MULTIPLIER = new Decimal(2);

export type SimulatorFormulaInput = {
  roomIndex: number;
  blockMaxHP: string;
  currentStrength: string;
  pickaxePower: string;
  hitStrengthPercent: string;
  rebirths: number;
  strengthPerRebirth: string;
  cashPerRebirth: string;
  equippedPetPowers: string[];
  indexComplete?: boolean;
  freeRewardClaimed?: boolean;
  friendCount: number;
  permanentStrengthMultiplier?: string;
  permanentCashMultiplier?: string;
  expectedItemPrice: string;
  minimumItemsPerRoom: string;
  maximumItemsPerRoom: string;
};

export type SimulatorFormulaResult = {
  damagePerHit: string;
  hitsAtCurrentStrength: string;
  blockTimeSeconds: string;
  strengthPerHit: string;
  strengthMultiplier: string;
  cashMultiplier: string;
  petPower: string;
  miningRewardMultiplier: string;
  friendBoostPercent: string;
  roomItemCount: number;
  baseRoomIncome: string;
  expectedRoomCash: string;
};

function positiveDecimal(raw: string | undefined, fallback = '0') {
  try {
    const value = new Decimal(raw ?? fallback);
    return value.isFinite() && value.isPositive() ? value : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
}

function nonNegativeDecimal(raw: string | undefined, fallback = '0') {
  try {
    const value = new Decimal(raw ?? fallback);
    return value.isFinite() && !value.isNegative() ? value : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
}

function luaRound(value: Decimal) {
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** Mirrors ProgressionService.CombineProgressionMultipliers. */
export function combineAdditiveMultipliers(
  multipliers: Array<string | Decimal>,
  friendBoostPercent: string | Decimal = '0',
) {
  const additivePool = multipliers.reduce((sum, raw) => {
    const value = raw instanceof Decimal ? raw : nonNegativeDecimal(raw, '1');
    return value.greaterThan(1) ? sum.plus(value) : sum;
  }, new Decimal(0));
  const base = Decimal.max(1, additivePool);
  const friends = friendBoostPercent instanceof Decimal
    ? Decimal.max(0, friendBoostPercent)
    : nonNegativeDecimal(friendBoostPercent);
  return base.mul(new Decimal(1).plus(friends.div(100)));
}

/** Mirrors UpgradeConfig.ValueAtLevel. */
export function valueAtLevel(baseValue: string, valuePerLevel: string, level: number, maxLevel: number) {
  const normalizedLevel = Math.min(Math.max(Math.trunc(level) || 0, 0), Math.max(0, maxLevel));
  return nonNegativeDecimal(baseValue).plus(nonNegativeDecimal(valuePerLevel).mul(normalizedLevel));
}

/** Mirrors SellItemConfig.GetTargetItemCountForStage. */
export function itemsForRoom(
  roomIndex: number,
  settings: { minimumItemsPerRoom: string; maximumItemsPerRoom: string },
) {
  const minimum = Math.max(1, Math.trunc(Number(settings.minimumItemsPerRoom)) || 1);
  const maximum = Math.max(minimum, Math.trunc(Number(settings.maximumItemsPerRoom)) || minimum);
  const range = maximum - minimum + 1;
  const stage = Math.max(1, Math.trunc(roomIndex) || 1);
  return minimum + ((stage + 13_337) % range);
}

/** Current snapshot damage from ProgressionService.GetMiningDamage. */
export function miningDamage(currentStrength: string, hitStrengthPercent: string) {
  const strength = nonNegativeDecimal(currentStrength);
  const scaledDamage = luaRound(strength.mul(MINING_DAMAGE_PER_STRENGTH));
  const baseDamage = Decimal.max(MINIMUM_MINING_DAMAGE, scaledDamage);
  return Decimal.min(
    MAX_GAME_STAT,
    Decimal.max(1, luaRound(baseDamage.mul(positiveDecimal(hitStrengthPercent, '100')).div(100))),
  );
}

export function calculateSimulatorFormulas(input: SimulatorFormulaInput): SimulatorFormulaResult {
  const friendBoostPercent = new Decimal(Math.max(0, Math.trunc(input.friendCount) || 0))
    .mul(FRIEND_BOOST_PER_FRIEND_PERCENT);
  const rebirthCount = new Decimal(Math.min(120, Math.max(0, Math.trunc(input.rebirths) || 0)));
  const rebirthStrengthMultiplier = new Decimal(1)
    .plus(rebirthCount.mul(nonNegativeDecimal(input.strengthPerRebirth)));
  const rebirthCashMultiplier = new Decimal(1)
    .plus(rebirthCount.mul(nonNegativeDecimal(input.cashPerRebirth)));
  const petPower = input.equippedPetPowers.reduce(
    (sum, power) => sum.plus(nonNegativeDecimal(power)),
    new Decimal(0),
  );
  const miningRewardMultiplier = Decimal.max(
    1,
    petPower.plus(input.indexComplete ? INDEX_COMPLETION_STRENGTH_MULTIPLIER : 0),
  );
  const strengthMultiplier = combineAdditiveMultipliers([
    rebirthStrengthMultiplier,
    positiveDecimal(input.permanentStrengthMultiplier, '1'),
    input.freeRewardClaimed ? FREE_REWARD_STRENGTH_MULTIPLIER : new Decimal(1),
    miningRewardMultiplier,
  ], friendBoostPercent);
  const cashMultiplier = combineAdditiveMultipliers([
    rebirthCashMultiplier,
    positiveDecimal(input.permanentCashMultiplier, '1'),
  ], friendBoostPercent);
  const strengthPerHit = Decimal.min(
    MAX_GAME_STAT,
    Decimal.max(1, luaRound(positiveDecimal(input.pickaxePower, '1').mul(strengthMultiplier))),
  );
  const damagePerHit = miningDamage(input.currentStrength, input.hitStrengthPercent);
  const blockHP = positiveDecimal(input.blockMaxHP, '1');
  const hitsAtCurrentStrength = blockHP.div(damagePerHit).ceil();
  // MiningClient first waits for an interval, then applies contact at 45% of the animation.
  const blockTimeSeconds = hitsAtCurrentStrength
    .mul(PICKAXE_SWING_INTERVAL_SECONDS)
    .plus(PICKAXE_CONTACT_DELAY_SECONDS);
  const roomItemCount = itemsForRoom(input.roomIndex, input);
  const baseRoomIncome = nonNegativeDecimal(input.expectedItemPrice).mul(roomItemCount);
  const expectedRoomCash = luaRound(baseRoomIncome.mul(cashMultiplier));

  return {
    damagePerHit: damagePerHit.toFixed(),
    hitsAtCurrentStrength: hitsAtCurrentStrength.toFixed(),
    blockTimeSeconds: blockTimeSeconds.toFixed(),
    strengthPerHit: strengthPerHit.toFixed(),
    strengthMultiplier: strengthMultiplier.toFixed(),
    cashMultiplier: cashMultiplier.toFixed(),
    petPower: petPower.toFixed(),
    miningRewardMultiplier: miningRewardMultiplier.toFixed(),
    friendBoostPercent: friendBoostPercent.toFixed(),
    roomItemCount,
    baseRoomIncome: baseRoomIncome.toFixed(),
    expectedRoomCash: expectedRoomCash.toFixed(),
  };
}
