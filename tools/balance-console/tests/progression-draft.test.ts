import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildRoomEconomy, log10ForChart } from '../lib/analytics';
import { parseKnownConfigs, type ConfigTextMap } from '../lib/config-model';
import { seedConfigText } from '../lib/generated/seed-configs';
import { createSmoothProgressionDraft, isSmoothProgression, REWARD_GROWTH_MULTIPLIER } from '../lib/progression-draft';
import { validateConfigs } from '../lib/validation';

const base: ConfigTextMap = { ...seedConfigText };

describe('smooth progression draft', () => {
  it('creates steadily growing HP and expected rewards', () => {
    const draft = createSmoothProgressionDraft(base);
    const economy = buildRoomEconomy(draft);
    const hpSteps = steps(economy.map((room) => log10ForChart(room.blockMaxHP)));
    const rewardSteps = steps(economy.map((room) => log10ForChart(room.expectedItemPrice)));

    expect(draft).not.toBe(base);
    expect(isSmoothProgression(draft)).toBe(true);
    expect(Math.max(...hpSteps) - Math.min(...hpSteps)).toBeLessThan(0.01);
    expect(Math.max(...rewardSteps) - Math.min(...rewardSteps)).toBeLessThan(0.01);
    expect(hpSteps.every((step) => step > 0)).toBe(true);
    expect(rewardSteps.every((step) => step > 0)).toBe(true);
    expect(Number(economy[1].rewardGrowth)).toBeCloseTo(REWARD_GROWTH_MULTIPLIER, 3);
  });

  it('keeps every drop pool normalized and the draft publishable', () => {
    const draft = createSmoothProgressionDraft(base);
    const known = parseKnownConfigs(draft);

    known.roomDrops.forEach((room) => {
      const total = room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0));
      expect(total.equals(100)).toBe(true);
    });
    expect(validateConfigs(draft).errorCount).toBe(0);
  });

  it('does not generate a second draft when progression is already smooth', () => {
    const draft = createSmoothProgressionDraft(base);
    expect(createSmoothProgressionDraft(draft)).toBe(draft);
  });
});

function steps(values: number[]) {
  return values.slice(1).map((value, index) => value - values[index]);
}
