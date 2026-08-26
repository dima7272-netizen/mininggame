import { describe, expect, it } from 'vitest';
import { resolveThemeMode } from '../lib/theme';

describe('theme modes', () => {
  it('keeps explicit day and night modes independent from the system', () => {
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
  });

  it('follows the system in automatic mode', () => {
    expect(resolveThemeMode('auto', true)).toBe('dark');
    expect(resolveThemeMode('auto', false)).toBe('light');
  });
});
