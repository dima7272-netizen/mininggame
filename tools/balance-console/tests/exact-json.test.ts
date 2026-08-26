import { describe, expect, it } from 'vitest';
import {
  exactNumber,
  flattenJson,
  parseExactJson,
  stringifyExactJson,
  updateAtPointer,
} from '../lib/exact-json';

describe('exact JSON numbers', () => {
  it('round-trips integers beyond Number.MAX_SAFE_INTEGER and exponents', () => {
    const source = '{"price":10000000000000000,"cap":1.3e30,"fraction":0.000000000000000001}\n';
    const canonical = stringifyExactJson(parseExactJson(source));
    expect(canonical).toContain('10000000000000000');
    expect(canonical).toContain('1.3e30');
    expect(canonical).toContain('0.000000000000000001');
  });

  it('updates a numeric lexeme without converting it to a JS number', () => {
    const next = updateAtPointer(parseExactJson('{"nested":{"value":1}}'), '$/nested/value', exactNumber('999999999999999999999999'));
    expect(stringifyExactJson(next)).toContain('999999999999999999999999');
    expect(flattenJson(next)).toContainEqual({
      path: '$/nested/value',
      type: 'number',
      value: '999999999999999999999999',
    });
  });

  it('rejects non-JSON numeric input', () => {
    expect(() => exactNumber('01')).toThrow('Некорректное JSON-число');
    expect(() => exactNumber('Infinity')).toThrow('Некорректное JSON-число');
  });
});
