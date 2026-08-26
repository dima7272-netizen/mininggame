import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import entityManifest from '../data/entity-icons.json';
import iconManifest from '../data/item-icons.json';
import { parseKnownConfigs } from '../lib/config-model';
import { spreadsheetPreviewSnapshot } from '../lib/source-snapshots';

describe('real item icon manifest', () => {
  const known = parseKnownConfigs(spreadsheetPreviewSnapshot);
  const itemIds = known.sellItems.map((item) => item.id);

  it('covers every SellItems entry and every RoomDrops reference', () => {
    const mappedIds = Object.keys(iconManifest.items);
    const usedIds = new Set(known.roomDrops.flatMap((room) => room.drops.map((drop) => drop.itemId)));

    expect(mappedIds.sort()).toEqual([...itemIds].sort());
    expect([...usedIds].every((itemId) => itemId in iconManifest.items)).toBe(true);
    expect(iconManifest.itemCount).toBe(itemIds.length);
    expect(iconManifest.source.path).toBe('ReplicatedStorage.Game.Selling.SellItemConfig');
    expect(iconManifest.source.readOnly).toBe(true);
  });

  it('keeps a valid local PNG for every game asset', () => {
    for (const [itemId, entry] of Object.entries(iconManifest.items)) {
      const file = readFileSync(new URL(`../public${entry.src}`, import.meta.url));
      expect(file.subarray(0, 8), `${itemId} must point to a PNG`).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(entry.sourceUri).toBe(`rbxassetid://${entry.assetId}`);
      expect(entry.sourcePath).toBe(iconManifest.source.path);
    }
  });

  it('covers every pickaxe, pet and upgrade with an author-configured icon', () => {
    const expected = {
      pickaxes: known.pickaxes.map((item) => item.modelName),
      pets: known.pets.map((item) => item.id),
      upgrades: known.upgrades.map((item) => item.id),
    };

    for (const category of Object.keys(expected) as Array<keyof typeof expected>) {
      const group = entityManifest.categories[category];
      expect(Object.keys(group.items).sort()).toEqual(expected[category].sort());
      expect(group.count).toBe(expected[category].length);
      expect(group.sourcePath).toMatch(/^ReplicatedStorage\.Game\./);

      for (const [entityId, entry] of Object.entries(group.items)) {
        const file = readFileSync(new URL(`../public${entry.src}`, import.meta.url));
        expect(file.subarray(0, 8), `${category}/${entityId} must point to a PNG`).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
    }
  });
});
