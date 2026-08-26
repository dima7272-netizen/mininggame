import Decimal from 'decimal.js';
import { buildRoomEconomy } from './analytics';
import type { ConfigTextMap, KnownConfigs } from './config-model';
import { parseKnownConfigs } from './config-model';
import { canonicalExactJson, parseExactJson } from './exact-json';
import { diffConfigs } from './config-diff';

export type IssueSeverity = 'error' | 'warning' | 'observation';
export type ValidationIssue = {
  severity: IssueSeverity;
  code: string;
  title: string;
  detail: string;
  configName?: string;
  path?: string;
  formula?: string;
  related?: string[];
};

export type ValidationResult = {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  observationCount: number;
  canPublish: boolean;
};

const REQUIRED_CONFIGS = [
  'Arenas',
  'Pets',
  'Pickaxes',
  'Rebirth',
  'RoomDrops',
  'Rooms',
  'SellItems',
  'Upgrades',
  'Spiders',
];

export function validateConfigs(
  configs: ConfigTextMap,
  options: { comparison?: ConfigTextMap; baseIsCurrent?: boolean } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const [name, source] of Object.entries(configs)) {
    try {
      const canonical = canonicalExactJson(source);
      parseExactJson(canonical);
    } catch (error) {
      issues.push(issue('error', 'json.invalid', `${name}: JSON не читается`, String(error), name));
    }
  }

  for (const name of REQUIRED_CONFIGS) {
    if (!(name in configs)) {
      issues.push(issue('error', 'config.missing', `Отсутствует ${name}.json`, 'Обязательный игровой конфиг не найден.', name));
    }
  }

  if (issues.some((item) => item.severity === 'error')) return summarize(issues);

  let known: KnownConfigs;
  try {
    known = parseKnownConfigs(configs);
  } catch (error) {
    issues.push(issue('error', 'schema.invalid', 'Структура конфига не соответствует схеме', String(error)));
    return summarize(issues);
  }

  unique(known.arenas.map((item) => String(item.id)), 'Arenas.id', 'Arenas', issues);
  unique(known.pets.map((item) => item.id), 'Pets.id', 'Pets', issues);
  unique(known.pickaxes.map((item) => item.modelName), 'Pickaxes.modelName', 'Pickaxes', issues);
  unique(known.rooms.map((item) => String(item.index)), 'Rooms.index', 'Rooms', issues);
  unique(known.roomDrops.map((item) => String(item.index)), 'RoomDrops.index', 'RoomDrops', issues);
  unique(known.sellItems.map((item) => item.id), 'SellItems.id', 'SellItems', issues);
  unique(known.upgrades.map((item) => item.id), 'Upgrades.id', 'Upgrades', issues);

  const sellIds = new Set(known.sellItems.map((item) => item.id));
  for (const room of known.roomDrops) {
    if (room.drops.length === 0) {
      issues.push(issue(
        'error',
        'drops.empty_room',
        `Комната ${room.index}: нет наград`,
        'В каждой комнате должна оставаться хотя бы одна награда.',
        'RoomDrops',
        `$/room/${room.index}/drops`,
      ));
    }
    const roomIds = new Set<string>();
    for (const drop of room.drops) {
      if (roomIds.has(drop.itemId)) {
        issues.push(issue(
          'error',
          'drops.duplicate_item',
          `Комната ${room.index}: ${drop.itemId} указан дважды`,
          'Один предмет должен встречаться в пуле комнаты только один раз.',
          'RoomDrops',
          `$/room/${room.index}/drops`,
        ));
      }
      roomIds.add(drop.itemId);
    }
    const total = room.drops.reduce((sum, drop) => sum.plus(drop.weight), new Decimal(0));
    if (!total.equals(100)) {
      issues.push(issue(
        'error',
        'drops.weight_sum',
        `Комната ${room.index}: сумма весов ${total.toString()}, а не 100`,
        'Вероятности не образуют корректный пул выпадения.',
        'RoomDrops',
        `$/room/${room.index}/drops`,
        'Σ weight = 100',
      ));
    }
    for (const drop of room.drops) {
      if (!sellIds.has(drop.itemId)) {
        issues.push(issue(
          'error',
          'drops.missing_item',
          `Не найден предмет ${drop.itemId}`,
          `Комната ${room.index} ссылается на ID, которого нет в SellItems.`,
          'RoomDrops',
        ));
      }
      nonNegative(drop.weight, `Вес ${drop.itemId} в комнате ${room.index}`, 'RoomDrops', issues);
    }
  }

  for (const room of known.rooms) nonNegative(room.blockMaxHP, `HP комнаты ${room.index}`, 'Rooms', issues);
  for (const item of known.sellItems) nonNegative(item.sellPrice, `Цена ${item.id}`, 'SellItems', issues);
  for (const item of known.pickaxes) {
    nonNegative(item.currencyPrice, `Цена ${item.modelName}`, 'Pickaxes', issues);
    nonNegative(item.power, `Сила ${item.modelName}`, 'Pickaxes', issues);
  }
  for (const item of known.pets) {
    nonNegative(item.currencyPrice, `Цена ${item.id}`, 'Pets', issues);
    nonNegative(item.power, `Сила ${item.id}`, 'Pets', issues);
  }

  if (new Decimal(known.sellSettings.minimumItemsPerRoom).greaterThan(known.sellSettings.maximumItemsPerRoom)) {
    issues.push(issue(
      'error',
      'sell.range',
      'Минимум предметов больше максимума',
      `${known.sellSettings.minimumItemsPerRoom} > ${known.sellSettings.maximumItemsPerRoom}`,
      'SellItems',
    ));
  }

  for (const upgrade of known.upgrades) {
    if (upgrade.prices.length !== upgrade.maxLevel) {
      issues.push(issue(
        'error',
        'upgrade.price_count',
        `${upgrade.id}: число цен не совпадает с maxLevel`,
        `${upgrade.prices.length} цен при maxLevel=${upgrade.maxLevel}.`,
        'Upgrades',
      ));
    }
  }

  for (let index = 1; index < known.rebirth.growth.length; index += 1) {
    if (known.rebirth.growth[index].upTo <= known.rebirth.growth[index - 1].upTo) {
      issues.push(issue(
        'error',
        'rebirth.unsorted',
        'Участки роста ребёртов не отсортированы',
        'Каждый следующий upTo должен быть больше предыдущего.',
        'Rebirth',
      ));
      break;
    }
  }

  for (let index = 1; index < known.pickaxes.length; index += 1) {
    const previous = known.pickaxes[index - 1];
    const current = known.pickaxes[index];
    if (new Decimal(current.currencyPrice).lessThan(previous.currencyPrice)) {
      issues.push(issue(
        'warning',
        'pickaxe.price_drop',
        `${current.modelName} дешевле ${previous.modelName}`,
        `Цена падает с ${previous.currencyPrice} до ${current.currencyPrice}, а сила меняется с ${previous.power} до ${current.power}.`,
        'Pickaxes',
        `$/modelName/${current.modelName}/currencyPrice`,
      ));
    }
    if (new Decimal(current.power).lessThan(previous.power)) {
      issues.push(issue(
        'warning',
        'pickaxe.power_drop',
        `${current.modelName}: сила ниже предыдущей кирки`,
        `${current.power} < ${previous.power}.`,
        'Pickaxes',
      ));
    }
  }

  const economy = buildRoomEconomy(known);
  const room16 = economy.find((room) => room.index === 16);
  if (room16 && new Decimal(room16.hpGrowth ?? 0).greaterThanOrEqualTo(20) && new Decimal(room16.rewardGrowth ?? 0).equals(1)) {
    issues.push(issue(
      'warning',
      'room.16_wall',
      'Комната 16: HP ×20 без роста средней награды',
      `Ожидаемая цена предмета остаётся ${room16.expectedItemPrice}.`,
      'Rooms',
      '$/rooms/15/blockMaxHP',
      'Σ(weight / Σweight × sellPrice)',
      ['RoomDrops', 'SellItems'],
    ));
  }

  const wallRooms = economy.filter((room) =>
    room.index >= 38 &&
    room.index <= 46 &&
    new Decimal(room.hpGrowth ?? 0).greaterThanOrEqualTo(9.9) &&
    new Decimal(room.rewardGrowth ?? 0).lessThan(1.05),
  );
  if (wallRooms.length > 0) {
    issues.push(issue(
      'warning',
      'room.late_wall',
      `Стена прогрессии в комнатах ${wallRooms[0].index}–${wallRooms.at(-1)?.index}`,
      `HP растёт примерно в 10 раз, а ожидаемая цена предмета — лишь на ${wallRooms
        .map((room) => new Decimal(room.rewardGrowth ?? 1).minus(1).mul(100).toFixed(1))
        .join('%, ')}%.`,
      'Rooms',
      '$/rooms',
      'HP growth / expected reward growth',
      ['RoomDrops', 'SellItems'],
    ));
  }

  const beyond = known.beyondLastRoom;
  if (
    new Decimal(beyond.hpMultiplier ?? 0).equals(1) &&
    new Decimal(beyond.blockMaxHP ?? 0).equals(beyond.maxBlockHP ?? 1)
  ) {
    issues.push(issue(
      'warning',
      'rooms.beyond_plateau',
      'После 46-й комнаты HP может остановиться',
      `hpMultiplier=1, blockMaxHP=maxBlockHP=${beyond.blockMaxHP}. Поведение потребителя в игровом коде отсутствует и требует подтверждения.`,
      'Rooms',
      '$/beyondLastRoom',
    ));
  }

  const arena10 = known.arenas.find((arena) => arena.id === 10);
  const arena11 = known.arenas.find((arena) => arena.id === 11);
  const arena12 = known.arenas.find((arena) => arena.id === 12);
  if (arena10 && arena11 && arena12 && new Decimal(arena12.multiplier).lessThan(arena11.multiplier)) {
    issues.push(issue(
      'observation',
      'arena.order_unknown',
      'Порядок ID арен не похож на линейную прогрессию',
      `Арены 10 и 11 имеют ×${arena10.multiplier}, а арена 12 — ×${arena12.multiplier}. Назначение арен не найдено в коде.`,
      'Arenas',
    ));
  }

  if (options.comparison) {
    const changes = diffConfigs(options.comparison, configs);
    const spiderChanges = changes.filter((change) => change.configName === 'Spiders');
    if (spiderChanges.length > 0) {
      issues.push(issue(
        'warning',
        'sources.spiders_drift',
        `Spiders: ${spiderChanges.length} значений расходятся между источниками`,
        spiderChanges.map((change) => `${change.path}: ${change.before} → ${change.after}`).join('; '),
        'Spiders',
      ));
    }
  }

  if (options.baseIsCurrent === false) {
    issues.push(issue(
      'error',
      'version.stale_base',
      'Черновик создан не от актуальной опубликованной версии',
      'Сначала сравните и перенесите изменения на новую базовую версию.',
    ));
  }

  issues.push(issue(
    'observation',
    'formula.unavailable',
    'Формулы силы, денег и времени не подключены',
    'Репозиторий содержит загрузчик конфигов, но не код игровых потребителей. Симулятор не подставляет предположения.',
  ));
  issues.push(issue(
    'observation',
    'roblox.number_precision',
    'Luau использует 64-битные числа с плавающей точкой',
    'Сервис сохраняет десятичные лексемы точно, но Roblox/Luau всё равно округляет большие значения при чтении. Для 1.3e30 сохраняется порядок величины, а не каждая целая цифра.',
  ));

  return summarize(issues);
}

function unique(values: string[], label: string, configName: string, issues: ValidationIssue[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push(issue('error', 'id.duplicate', `Дублируется ${label}: ${value}`, 'ID должен быть уникальным.', configName));
    }
    seen.add(value);
  }
}

function nonNegative(value: string, label: string, configName: string, issues: ValidationIssue[]) {
  if (new Decimal(value).isNegative()) {
    issues.push(issue('error', 'number.negative', `${label}: отрицательное значение`, value, configName));
  }
}

function issue(
  severity: IssueSeverity,
  code: string,
  title: string,
  detail: string,
  configName?: string,
  path?: string,
  formula?: string,
  related?: string[],
): ValidationIssue {
  return { severity, code, title, detail, configName, path, formula, related };
}

function summarize(issues: ValidationIssue[]): ValidationResult {
  const errorCount = issues.filter((item) => item.severity === 'error').length;
  const warningCount = issues.filter((item) => item.severity === 'warning').length;
  const observationCount = issues.filter((item) => item.severity === 'observation').length;
  return { issues, errorCount, warningCount, observationCount, canPublish: errorCount === 0 };
}
