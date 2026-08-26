import { isLosslessNumber, LosslessNumber, parse, stringify } from 'lossless-json';

export type ExactNumber = { readonly $number: string };
export type ExactJson =
  | null
  | boolean
  | string
  | ExactNumber
  | ExactJson[]
  | { [key: string]: ExactJson };

export function exactNumber(value: string): ExactNumber {
  if (!isValidJsonNumber(value)) {
    throw new Error(`Некорректное JSON-число: ${value}`);
  }
  return { $number: value };
}

export function isExactNumber(value: unknown): value is ExactNumber {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      typeof (value as ExactNumber).$number === 'string',
  );
}

export function parseExactJson(source: string): ExactJson {
  const parsed = parse(source);
  return fromLossless(parsed);
}

export function stringifyExactJson(value: ExactJson, spaces = 2): string {
  return `${stringify(toLossless(value), undefined, spaces)}\n`;
}

export function canonicalExactJson(source: string): string {
  return stringifyExactJson(parseExactJson(source));
}

export function asObject(value: ExactJson, label = 'объект'): Record<string, ExactJson> {
  if (value === null || Array.isArray(value) || typeof value !== 'object' || isExactNumber(value)) {
    throw new Error(`Ожидался ${label}`);
  }
  return value;
}

export function asArray(value: ExactJson, label = 'массив'): ExactJson[] {
  if (!Array.isArray(value)) throw new Error(`Ожидался ${label}`);
  return value;
}

export function asString(value: ExactJson, label = 'строка'): string {
  if (typeof value !== 'string') throw new Error(`Ожидалась ${label}`);
  return value;
}

export function asNumberText(value: ExactJson, label = 'число'): string {
  if (!isExactNumber(value)) throw new Error(`Ожидалось ${label}`);
  return value.$number;
}

export function asSafeInteger(value: ExactJson, label = 'целое число'): number {
  const raw = asNumberText(value, label);
  if (!/^-?(0|[1-9]\d*)$/.test(raw)) throw new Error(`Ожидалось ${label}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} выходит за безопасный диапазон`);
  return parsed;
}

export function updateAtPointer(root: ExactJson, pointer: string, next: ExactJson): ExactJson {
  if (pointer === '$') return next;
  if (!pointer.startsWith('$/')) throw new Error(`Некорректный JSON Pointer: ${pointer}`);

  const segments = pointer
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  const update = (current: ExactJson, index: number): ExactJson => {
    if (index === segments.length) return next;
    const key = segments[index];
    if (Array.isArray(current)) {
      const arrayIndex = Number(key);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
        throw new Error(`Не найден индекс ${key} в ${pointer}`);
      }
      return current.map((item, itemIndex) =>
        itemIndex === arrayIndex ? update(item, index + 1) : item,
      );
    }
    const object = asObject(current);
    if (!(key in object)) throw new Error(`Не найден ключ ${key} в ${pointer}`);
    return { ...object, [key]: update(object[key], index + 1) };
  };

  return update(root, 0);
}

export function flattenJson(root: ExactJson): Array<{ path: string; type: string; value: string }> {
  const rows: Array<{ path: string; type: string; value: string }> = [];
  const walk = (value: ExactJson, path: string) => {
    if (Array.isArray(value)) {
      rows.push({ path, type: 'array', value: '' });
      value.forEach((item, index) => walk(item, `${path}/${index}`));
      return;
    }
    if (isExactNumber(value)) {
      rows.push({ path, type: 'number', value: value.$number });
      return;
    }
    if (value === null) {
      rows.push({ path, type: 'null', value: '' });
      return;
    }
    if (typeof value === 'object') {
      rows.push({ path, type: 'object', value: '' });
      for (const [key, child] of Object.entries(value)) {
        const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
        walk(child, `${path}/${escaped}`);
      }
      return;
    }
    rows.push({ path, type: typeof value, value: String(value) });
  };
  walk(root, '$');
  return rows;
}

function fromLossless(value: unknown): ExactJson {
  if (isLosslessNumber(value)) return exactNumber(value.toString());
  if (Array.isArray(value)) return value.map(fromLossless);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, fromLossless(child)]),
    );
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  throw new Error(`Неподдерживаемый тип JSON: ${typeof value}`);
}

function toLossless(value: ExactJson): unknown {
  if (isExactNumber(value)) return new LosslessNumber(value.$number);
  if (Array.isArray(value)) return value.map(toLossless);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toLossless(child)]));
  }
  return value;
}

function isValidJsonNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}
