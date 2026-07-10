import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  getStoredTheme,
  initTheme,
  isDark,
  setTheme,
  systemPrefersDark,
  THEME_STORAGE_KEY,
} from './theme';

/** Install a controllable `window.matchMedia` (jsdom ships none). */
function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  // Let a test flip the OS preference and notify listeners, mimicking the OS.
  return {
    setDark(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) cb();
    },
    listenerCount: () => listeners.size,
  };
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    // A theme-color meta so applyTheme has something to update.
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', '#ffffff');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to system when nothing is stored', () => {
    expect(getStoredTheme()).toBe('system');
  });

  it('reads a stored choice and ignores garbage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(getStoredTheme()).toBe('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'nonsense');
    expect(getStoredTheme()).toBe('system');
  });

  it('setTheme("dark") persists and adds the html class', () => {
    setTheme('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('setTheme("light") persists and removes the html class', () => {
    document.documentElement.classList.add('dark');
    setTheme('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('system mode follows prefers-color-scheme', () => {
    stubMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    expect(isDark('system')).toBe(true);
    setTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    stubMatchMedia(false);
    setTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('explicit dark/light ignore the OS preference', () => {
    stubMatchMedia(false);
    expect(isDark('dark')).toBe(true);
    stubMatchMedia(true);
    expect(isDark('light')).toBe(false);
  });

  it('applyTheme updates the theme-color meta', () => {
    stubMatchMedia(false);
    applyTheme('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#111827');
    applyTheme('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#ffffff');
  });

  it('initTheme applies the stored theme and tracks live OS changes in system mode', () => {
    const os = stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const cleanup = initTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // OS flips to dark → the class follows.
    os.setDark(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    cleanup();
    expect(os.listenerCount()).toBe(0);
  });

  it('initTheme does not track OS changes for an explicit choice', () => {
    const os = stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const cleanup = initTheme();
    os.setDark(true); // OS goes dark, but the user chose light
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    cleanup();
  });
});
