import { describe, expect, it } from 'vitest';
import {
  calculateSimulatorFormulas,
  combineAdditiveMultipliers,
  itemsForRoom,
  miningDamage,
  valueAtLevel,
} from '../lib/game-formulas';

describe('formulas extracted from Dig Get Stronger place version 89', () => {
  it('uses the real deterministic 7/8 item sequence', () => {
    const settings = { minimumItemsPerRoom: '7', maximumItemsPerRoom: '8' };
    expect(itemsForRoom(1, settings)).toBe(7);
    expect(itemsForRoom(2, settings)).toBe(8);
    expect(itemsForRoom(45, settings)).toBe(7);
    expect(itemsForRoom(46, settings)).toBe(8);
  });

  it('adds multiplier sources and applies friends afterwards', () => {
    expect(combineAdditiveMultipliers(['1', '6', '25'], '10').toFixed()).toBe('34.1');
    expect(combineAdditiveMultipliers(['1', '1'], '0').toFixed()).toBe('1');
  });

  it('calculates aura value and mining damage from current Strength', () => {
    expect(valueAtLevel('100', '100', 3, 10).toFixed()).toBe('400');
    expect(miningDamage('0', '100').toFixed()).toBe('10');
    expect(miningDamage('1000', '400').toFixed()).toBe('800');
  });

  it('connects pickaxe, pets, rebirths, friends and cash', () => {
    const result = calculateSimulatorFormulas({
      roomIndex: 2,
      blockMaxHP: '1000',
      currentStrength: '1000',
      pickaxePower: '10',
      hitStrengthPercent: '200',
      rebirths: 2,
      strengthPerRebirth: '1',
      cashPerRebirth: '1',
      equippedPetPowers: ['2', '3'],
      friendCount: 2,
      expectedItemPrice: '100',
      minimumItemsPerRoom: '7',
      maximumItemsPerRoom: '8',
    });
    expect(result.strengthMultiplier).toBe('8.8'); // (rebirth x3 + pets x5) × 1.1
    expect(result.strengthPerHit).toBe('88');
    expect(result.damagePerHit).toBe('400');
    expect(result.hitsAtCurrentStrength).toBe('3');
    expect(result.blockTimeSeconds).toBe('1.8975');
    expect(result.roomItemCount).toBe(8);
    expect(result.cashMultiplier).toBe('3.3');
    expect(result.expectedRoomCash).toBe('2640');
  });

  it('adds the free reward and completed index to their real additive pools', () => {
    const result = calculateSimulatorFormulas({
      roomIndex: 1,
      blockMaxHP: '50',
      currentStrength: '0',
      pickaxePower: '10',
      hitStrengthPercent: '100',
      rebirths: 0,
      strengthPerRebirth: '1',
      cashPerRebirth: '1',
      equippedPetPowers: ['2'],
      indexComplete: true,
      freeRewardClaimed: true,
      friendCount: 0,
      expectedItemPrice: '10',
      minimumItemsPerRoom: '7',
      maximumItemsPerRoom: '8',
    });
    expect(result.miningRewardMultiplier).toBe('3.5'); // pet x2 + index x1.5
    expect(result.strengthMultiplier).toBe('5.5'); // reward pool x3.5 + free x2
    expect(result.strengthPerHit).toBe('55');
  });

  it('uses entered in-game damage for hits and time while keeping the formula comparison', () => {
    const result = calculateSimulatorFormulas({
      roomIndex: 2,
      blockMaxHP: '1000',
      currentStrength: '1000',
      actualDamagePerHit: '250',
      pickaxePower: '10',
      hitStrengthPercent: '200',
      rebirths: 0,
      strengthPerRebirth: '1',
      cashPerRebirth: '1',
      equippedPetPowers: [],
      friendCount: 0,
      expectedItemPrice: '100',
      minimumItemsPerRoom: '7',
      maximumItemsPerRoom: '8',
    });
    expect(result.usesActualDamage).toBe(true);
    expect(result.calculatedDamagePerHit).toBe('400');
    expect(result.damagePerHit).toBe('250');
    expect(result.hitsAtCurrentStrength).toBe('4');
    expect(result.blockTimeSeconds).toBe('2.4475');
  });
});
