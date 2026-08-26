import {
  asArray,
  asNumberText,
  asObject,
  asSafeInteger,
  asString,
  parseExactJson,
  type ExactJson,
} from './exact-json';

export type ConfigTextMap = Record<string, string>;

export type Room = {
  index: number;
  blockMaxHP: string;
  roomLengthCells: string;
  barrierLayers: string;
};

export type RoomDrop = {
  index: number;
  drops: Array<{ itemId: string; weight: string }>;
};

export type SellItem = { id: string; sellPrice: string };
export type Pickaxe = { modelName: string; currencyPrice: string; power: string };
export type Pet = { id: string; currencyPrice: string; power: string };
export type Arena = { id: number; multiplier: string; requiredRebirths?: string };
export type Upgrade = {
  id: string;
  maxLevel: number;
  prices: string[];
  baseValue: string;
  valuePerLevel: string;
};

export type KnownConfigs = {
  rooms: Room[];
  beyondLastRoom: Record<string, string>;
  roomDrops: RoomDrop[];
  sellSettings: { minimumItemsPerRoom: string; maximumItemsPerRoom: string };
  sellItems: SellItem[];
  pickaxes: Pickaxe[];
  pets: Pet[];
  arenas: Arena[];
  upgrades: Upgrade[];
  rebirth: {
    firstRequirements: string[];
    growth: Array<{ upTo: number; multiplier: string }>;
    strengthPerRebirth: string;
    cashPerRebirth: string;
  };
  spiders: Record<string, string>;
};

export function parseKnownConfigs(configs: ConfigTextMap): KnownConfigs {
  const roomsRoot = asObject(required(configs, 'Rooms'));
  const sellRoot = asObject(required(configs, 'SellItems'));
  const rebirthRoot = asObject(required(configs, 'Rebirth'));

  const rooms = asArray(roomsRoot.rooms, 'Rooms.rooms').map((value) => {
    const room = asObject(value, 'комната');
    return {
      index: asSafeInteger(room.index, 'Rooms.index'),
      blockMaxHP: asNumberText(room.blockMaxHP, 'Rooms.blockMaxHP'),
      roomLengthCells: asNumberText(room.roomLengthCells, 'Rooms.roomLengthCells'),
      barrierLayers: asNumberText(room.barrierLayers, 'Rooms.barrierLayers'),
    };
  });

  const roomDrops = asArray(required(configs, 'RoomDrops')).map((value) => {
    const room = asObject(value, 'RoomDrops room');
    return {
      index: asSafeInteger(room.index, 'RoomDrops.index'),
      drops: asArray(room.drops, 'RoomDrops.drops').map((dropValue) => {
        const drop = asObject(dropValue, 'drop');
        return {
          itemId: asString(drop.itemId, 'RoomDrops.itemId'),
          weight: asNumberText(drop.weight, 'RoomDrops.weight'),
        };
      }),
    };
  });

  const sellSettings = asObject(sellRoot.settings, 'SellItems.settings');

  return {
    rooms,
    beyondLastRoom: numberRecord(asObject(roomsRoot.beyondLastRoom, 'Rooms.beyondLastRoom')),
    roomDrops,
    sellSettings: {
      minimumItemsPerRoom: asNumberText(sellSettings.minimumItemsPerRoom),
      maximumItemsPerRoom: asNumberText(sellSettings.maximumItemsPerRoom),
    },
    sellItems: asArray(sellRoot.items, 'SellItems.items').map((value) => {
      const item = asObject(value, 'SellItem');
      return { id: asString(item.id), sellPrice: asNumberText(item.sellPrice) };
    }),
    pickaxes: parsePricePowerList(required(configs, 'Pickaxes'), 'modelName') as Pickaxe[],
    pets: parsePricePowerList(required(configs, 'Pets'), 'id') as Pet[],
    arenas: asArray(required(configs, 'Arenas')).map((value) => {
      const arena = asObject(value, 'Arena');
      return {
        id: asSafeInteger(arena.id, 'Arenas.id'),
        multiplier: asNumberText(arena.multiplier, 'Arenas.multiplier'),
        ...(arena.requiredRebirths === undefined
          ? {}
          : { requiredRebirths: asNumberText(arena.requiredRebirths) }),
      };
    }),
    upgrades: asArray(required(configs, 'Upgrades')).map((value) => {
      const upgrade = asObject(value, 'Upgrade');
      return {
        id: asString(upgrade.id, 'Upgrades.id'),
        maxLevel: asSafeInteger(upgrade.maxLevel, 'Upgrades.maxLevel'),
        prices: asArray(upgrade.prices, 'Upgrades.prices').map((price) => asNumberText(price)),
        baseValue: asNumberText(upgrade.baseValue),
        valuePerLevel: asNumberText(upgrade.valuePerLevel),
      };
    }),
    rebirth: {
      firstRequirements: asArray(rebirthRoot.firstRequirements).map((value) => asNumberText(value)),
      growth: asArray(rebirthRoot.growth).map((value) => {
        const growth = asObject(value);
        return {
          upTo: asSafeInteger(growth.upTo),
          multiplier: asNumberText(growth.multiplier),
        };
      }),
      strengthPerRebirth: asNumberText(rebirthRoot.strengthPerRebirth),
      cashPerRebirth: asNumberText(rebirthRoot.cashPerRebirth),
    },
    spiders: numberRecord(asObject(required(configs, 'Spiders'), 'Spiders')),
  };
}

function required(configs: ConfigTextMap, name: string): ExactJson {
  const raw = configs[name];
  if (raw === undefined) throw new Error(`Отсутствует обязательный конфиг ${name}`);
  return parseExactJson(raw);
}

function numberRecord(object: Record<string, ExactJson>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, asNumberText(value, key)]),
  );
}

function parsePricePowerList(value: ExactJson, idKey: 'modelName' | 'id') {
  return asArray(value).map((entry) => {
    const object = asObject(entry);
    return {
      [idKey]: asString(object[idKey]),
      currencyPrice: asNumberText(object.currencyPrice),
      power: asNumberText(object.power),
    };
  });
}
