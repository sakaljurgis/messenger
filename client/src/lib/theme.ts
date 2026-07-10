// Theme management: "system" (default) / "light" / "dark".
//
// Dark mode is applied by toggling a `.dark` class on <html> — that's what
// Tailwind v4's dark variant keys off (see index.css:
// `@custom-variant dark (&:where(.dark, .dark *))`), so flipping the class
// restyles the whole tree instantly with no re-render needed. The choice is
// persisted in localStorage under `theme`; in "system" mode we follow the OS's
// prefers-color-scheme live via a matchMedia listener. A tiny inline copy of the
// initial-apply logic lives in index.html so the class is set before React
// mounts, avoiding a flash-of-wrong-theme.

export type Theme = 'system' | 'light' | 'dark';

/** localStorage key holding the user's theme choice. */
export const THEME_STORAGE_KEY = 'theme';

/** PWA chrome colors, kept in sync with the app's light/dark app-background. */
const THEME_COLORS = { light: '#ffffff', dark: '#111827' } as const;

function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** The persisted choice, or 'system' when unset / invalid / storage unavailable. */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Whether the OS currently prefers a dark color scheme. */
export function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Resolve a mode to a concrete dark/light decision. */
export function isDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark());
}

/** Toggle the `.dark` class on <html> and keep the theme-color meta in sync. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const dark = isDark(theme);
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? THEME_COLORS.dark : THEME_COLORS.light);
}

/** Persist a choice and apply it immediately. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore (private mode / quota) — the class is still applied below.
  }
  applyTheme(theme);
}

/**
 * Apply the stored theme and, while in "system" mode, keep following live OS
 * theme changes. Returns an unsubscribe function. Called once on app boot.
 */
export function initTheme(): () => void {
  applyTheme(getStoredTheme());
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    // Only "system" tracks the OS; an explicit light/dark choice is fixed.
    if (getStoredTheme() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
