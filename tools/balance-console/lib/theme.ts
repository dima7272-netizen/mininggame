export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';
export type ThemeSnapshot = `${ThemeMode}:${ResolvedTheme}`;

const STORAGE_KEY = 'dig-balance-theme';
const CHANGE_EVENT = 'dig-balance-theme-change';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  return mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function getThemeSnapshot(): ThemeSnapshot {
  if (typeof window === 'undefined') return getServerThemeSnapshot();
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const mode: ThemeMode = stored === 'light' || stored === 'dark' || stored === 'auto'
    ? stored
    : 'auto';
  return `${mode}:${resolveThemeMode(mode, window.matchMedia(DARK_QUERY).matches)}`;
}

export function getServerThemeSnapshot(): ThemeSnapshot {
  return 'auto:light';
}

export function subscribeTheme(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  const notify = () => onChange();
  window.addEventListener('storage', notify);
  window.addEventListener(CHANGE_EVENT, notify);
  media.addEventListener('change', notify);
  return () => {
    window.removeEventListener('storage', notify);
    window.removeEventListener(CHANGE_EVENT, notify);
    media.removeEventListener('change', notify);
  };
}

export function saveThemeMode(mode: ThemeMode) {
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
