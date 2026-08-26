import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { buildRoomEconomy } from '../lib/analytics';
import { parseKnownConfigs, type ConfigTextMap } from '../lib/config-model';
import { exactNumber, parseExactJson, stringifyExactJson, updateAtPointer } from '../lib/exact-json';
import { seedConfigText } from '../lib/generated/seed-configs';
import { spreadsheetPreviewSnapshot } from '../lib/source-snapshots';
import { validateConfigs } from '../lib/validation';

const base: ConfigTextMap = { ...seedConfigText };

function mutate(configs: ConfigTextMap, name: string, pointer: string, value: Parameters<typeof updateAtPointer>[2]) {
  return {
    ...configs,
    [name]: stringifyExactJson(updateAtPointer(parseExactJson(configs[name]), pointer, value)),
  };
}

function codes(configs: ConfigTextMap, comparison?: ConfigTextMap) {
  return validateConfigs(configs, comparison ? { comparison } : {}).issues.map((item) => item.code);
}

describe('repository import', () => {
  it('imports all nine known configs and every cross-linked record', () => {
    expect(Object.keys(base).sort()).toEqual([
      'Arenas', 'Pets', 'Pickaxes', 'Rebirth', 'RoomDrops', 'Rooms', 'SellItems', 'Spiders', 'Upgrades',
    ]);
    const known = parseKnownConfigs(base);
    expect(known.rooms).toHaveLength(46);
    expect(known.roomDrops).toHaveLength(46);
    expect(known.pickaxes).toHaveLength(55);
    expect(known.roomDrops.reduce((sum, room) => sum + room.drops.length, 0)).toBeGreaterThanOrEqual(449);
    expect(known.beyondLastRoom.blockMaxHP).toBe('1.3e+30');
    expect(base.Pickaxes).toContain('10000000000000000');
  });

  it('keeps every room weight sum equal to 100', () => {
    const known = parseKnownConfigs(base);
    for (const room of known.roomDrops) {
      expect(room.drops.reduce((sum, drop) => sum + Number(drop.weight), 0)).toBe(100);
    }
  });

  it('keeps a rounded, strictly growing price ladder after pickaxe 50', () => {
    const known = parseKnownConfigs(base);
    expect(known.pickaxes.slice(50).map((pickaxe) => pickaxe.currencyPrice)).toEqual([
      '100000000000000000',
      '200000000000000000',
      '500000000000000000',
      '1000000000000000000',
      '2000000000000000000',
    ]);
    expect(known.pickaxes.slice(49).every((pickaxe, index, tail) => (
      index === 0 || new Decimal(pickaxe.currencyPrice).greaterThan(tail[index - 1].currencyPrice)
    ))).toBe(true);
  });

  it('computes room 16 from the current configs and the exact even-room item count', () => {
    const room16 = buildRoomEconomy(parseKnownConfigs(base)).find((room) => room.index === 16);
    expect(new Decimal(room16?.hpGrowth ?? 0).greaterThan(1)).toBe(true);
    expect(new Decimal(room16?.expectedItemPrice ?? 0).greaterThan(0)).toBe(true);
    expect(room16?.spawnedItemCount).toBe(8);
    expect(new Decimal(room16?.expectedRoomIncome ?? 0).equals(
      new Decimal(room16?.expectedItemPrice ?? 0).mul(8),
    )).toBe(true);
  });
});

describe('validation gates', () => {
  it('reports the audited baseline findings without blocking publication', () => {
    const result = validateConfigs(base, { comparison: spreadsheetPreviewSnapshot });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBeGreaterThanOrEqual(0);
    expect(result.observationCount).toBe(3);
    expect(result.canPublish).toBe(true);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'arena.order_unknown', 'formula.connected', 'roblox.number_precision',
    ]));
  });

  it('blocks missing configs, duplicate IDs, broken references and bad weight sums', () => {
    const missing = { ...base };
    delete missing.Spiders;
    expect(codes(missing)).toContain('config.missing');

    const duplicate = mutate(base, 'Pickaxes', '$/1/modelName', 'Plunger');
    expect(codes(duplicate)).toContain('id.duplicate');

    const brokenReference = mutate(base, 'RoomDrops', '$/0/drops/0/itemId', 'MissingItem');
    expect(codes(brokenReference)).toContain('drops.missing_item');

    const brokenWeight = mutate(base, 'RoomDrops', '$/0/drops/0/weight', exactNumber('99'));
    expect(codes(brokenWeight)).toContain('drops.weight_sum');

    const duplicateDrop = mutate(base, 'RoomDrops', '$/0/drops/1/itemId', 'Cardboard_C');
    expect(codes(duplicateDrop)).toContain('drops.duplicate_item');
  });

  it('blocks negative values, invalid ranges, upgrade length mismatches and stale bases', () => {
    expect(codes(mutate(base, 'Pets', '$/0/power', exactNumber('-1')))).toContain('number.negative');
    expect(codes(mutate(base, 'SellItems', '$/settings/minimumItemsPerRoom', exactNumber('11')))).toContain('sell.range');
    expect(codes(mutate(base, 'Upgrades', '$/0/maxLevel', exactNumber('999')))).toContain('upgrade.price_count');
    expect(validateConfigs(base, { baseIsCurrent: false }).issues.map((item) => item.code)).toContain('version.stale_base');
  });

  it('accepts an unknown well-formed config without requiring a code change', () => {
    const result = validateConfigs({ ...base, FutureEconomy: '{"huge":999999999999999999999}\n' });
    expect(result.errorCount).toBe(0);
  });
});
