import { readStoredString, writeStoredString } from './preferences.js'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'universe.mobile.theme'
export const THEME_META_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  light: '#f3f4f6',
  dark: '#0b1120',
}
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readThemePreference(): ThemePreference {
  const stored = readStoredString(THEME_STORAGE_KEY)
  return isThemePreference(stored) ? stored : 'system'
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference
  return systemPrefersDark ? 'dark' : 'light'
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', THEME_META_COLORS[theme])
}

export function setThemePreference(preference: ThemePreference): void {
  writeStoredString(THEME_STORAGE_KEY, preference)
  applyThemePreference(preference)
}

/** Applies the stored preference and keeps `system` Live with OS changes. */
export function initTheme(): void {
  applyThemePreference(readThemePreference())
}

let stopSystemListener: (() => void) | undefined

function applyThemePreference(preference: ThemePreference): void {
  applyResolvedTheme(resolveThemePreference(preference, systemPrefersDark()))
  watchSystemTheme(preference === 'system')
}

function watchSystemTheme(active: boolean): void {
  stopSystemListener?.()
  stopSystemListener = undefined
  if (!active || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  const onChange = (): void => {
    applyResolvedTheme(systemPrefersDark() ? 'dark' : 'light')
  }
  media.addEventListener('change', onChange)
  stopSystemListener = () => media.removeEventListener('change', onChange)
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches
  } catch {
    return false
  }
}
