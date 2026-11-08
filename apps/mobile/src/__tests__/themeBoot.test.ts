import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { THEME_META_COLORS, THEME_STORAGE_KEY } from '../theme.js'

const SOURCE = readFileSync(resolve(process.cwd(), 'public/theme-boot.js'), 'utf8')

interface BootResult {
  readonly dataTheme: string | undefined
  readonly meta: ReturnType<typeof vi.fn>
  readonly requestedKey: string | undefined
}

function runBoot(stored: string | null, systemDark: boolean, storageThrows = false): BootResult {
  const attributes = new Map<string, string>()
  const meta = vi.fn()
  let requestedKey: string | undefined
  runInNewContext(SOURCE, {
    localStorage: {
      getItem: (key: string) => {
        requestedKey = key
        if (storageThrows) throw new Error('storage denied')
        return stored
      },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
      querySelector: () => ({ setAttribute: meta }),
    },
  })
  return { dataTheme: attributes.get('data-theme'), meta, requestedKey }
}

describe('theme-boot.js', () => {
  it('applies an explicit dark preference even on a light system', () => {
    const result = runBoot('dark', false)
    expect(result.requestedKey).toBe(THEME_STORAGE_KEY)
    expect(result.dataTheme).toBe('dark')
    expect(result.meta).toHaveBeenCalledWith('content', THEME_META_COLORS.dark)
  })

  it('applies an explicit light preference even on a dark system', () => {
    const result = runBoot('light', true)
    expect(result.dataTheme).toBe('light')
    expect(result.meta).toHaveBeenCalledWith('content', THEME_META_COLORS.light)
  })

  it('follows the system for a missing or system preference', () => {
    expect(runBoot(null, true).dataTheme).toBe('dark')
    expect(runBoot('system', false).dataTheme).toBe('light')
  })

  it('keeps the CSS fallback when storage is unavailable', () => {
    const result = runBoot(null, true, true)
    expect(result.dataTheme).toBeUndefined()
    expect(result.meta).not.toHaveBeenCalled()
  })
})
