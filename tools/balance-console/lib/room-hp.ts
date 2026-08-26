import Decimal from 'decimal.js';
import type { ConfigTextMap } from './config-model';
import {
  asArray,
  asNumberText,
  asObject,
  exactNumber,
  parseExactJson,
  stringifyExactJson,
  updateAtPointer,
  type ExactJson,
} from './exact-json';

type HpUpdate = { pointer: string; value: string };

export function roundRoomHpToIntegers(configs: ConfigTextMap): ConfigTextMap {
  if (!configs.Rooms) return configs;
  const root = parseExactJson(configs.Rooms);
  const object = asObject(root, 'Rooms');
  const rooms = asArray(object.rooms, 'Rooms.rooms');
  const updates: HpUpdate[] = [];

  rooms.forEach((room, index) => {
    collectIntegerUpdate(
      asObject(room, `Rooms.rooms[${index}]`).blockMaxHP,
      `$/rooms/${index}/blockMaxHP`,
      updates,
    );
  });

  const beyond = asObject(object.beyondLastRoom, 'Rooms.beyondLastRoom');
  collectIntegerUpdate(beyond.blockMaxHP, '$/beyondLastRoom/blockMaxHP', updates);
  collectIntegerUpdate(beyond.maxBlockHP, '$/beyondLastRoom/maxBlockHP', updates);
  if (updates.length === 0) return configs;

  let next: ExactJson = root;
  updates.forEach((update) => {
    next = updateAtPointer(next, update.pointer, exactNumber(update.value));
  });
  return { ...configs, Rooms: stringifyExactJson(next) };
}

export function roomHpUsesIntegerLiterals(configs: ConfigTextMap): boolean {
  return roundRoomHpToIntegers(configs) === configs;
}

function collectIntegerUpdate(value: ExactJson | undefined, pointer: string, updates: HpUpdate[]) {
  const source = asNumberText(value ?? null, pointer);
  const rounded = new Decimal(source).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
  if (source !== rounded) updates.push({ pointer, value: rounded });
}
