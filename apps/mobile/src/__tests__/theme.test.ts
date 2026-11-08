import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_META_COLORS,
  THEME_STORAGE_KEY,
  initTheme,
  readThemePreference,
  resolveThemePreference,
  setThemePreference,
} from '../theme.js'

interface FakeMedia {
  matches: boolean
  listeners: Array<() => void>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function stubMatchMedia(matches: boolean): FakeMedia {
  const media: FakeMedia = {
    matches,
    listeners: [],
    addEventListener: vi.fn((_: string, listener: () => void) => {
      media.listeners.push(listener)
    }),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  )
  return media
}

describe('theme preference', () => {
  let meta: HTMLMetaElement

  beforeEach(() => {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.append(meta)
  })

  afterEach(() => {
    meta.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to system and resolves it against the OS preference', () => {
    expect(readThemePreference()).toBe('system')
    stubMatchMedia(true)
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(meta.getAttribute('content')).toBe(THEME_META_COLORS.dark)
  })

  it('applies explicit light and dark regardless of the OS preference', () => {
    stubMatchMedia(true)
    setThemePreference('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(meta.getAttribute('content')).toBe(THEME_META_COLORS.light)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    setThemePreference('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('follows OS changes while the preference is system and unbinds otherwise', () => {
    const media = stubMatchMedia(false)
    setThemePreference('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    media.matches = true
    media.listeners[0]?.()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    setThemePreference('light')
    expect(media.removeEventListener).toHaveBeenCalled()
  })

  it('falls back to system for unknown stored values and survives storage errors', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readThemePreference()).toBe('system')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(readThemePreference()).toBe('system')
  })

  it('resolves the pure preference mapping', () => {
    expect(resolveThemePreference('light', true)).toBe('light')
    expect(resolveThemePreference('dark', false)).toBe('dark')
    expect(resolveThemePreference('system', true)).toBe('dark')
    expect(resolveThemePreference('system', false)).toBe('light')
  })
})
