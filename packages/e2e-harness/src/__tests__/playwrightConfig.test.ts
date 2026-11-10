import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
  'UNIVERSE_E2E_ONLY_TAG',
  'UNIVERSE_E2E_ONLY_TAG_INVERT',
  'UNIVERSE_E2E_NO_TAG_FILTER',
  'UNIVERSE_E2E_INCLUDE_REGRESSION',
] as const
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

/** Env seams are read when the config module loads, so each case re-imports it. */
async function configWith(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  vi.resetModules()
  return import('../playwrightConfig.js')
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function matches(pattern: RegExp | RegExp[] | undefined, text: string): boolean {
  if (pattern === undefined) return false
  return Array.isArray(pattern) ? pattern.some((p) => p.test(text)) : pattern.test(text)
}

describe('tag filtering', () => {
  it('a parallel ONLY_TAG pass (e.g. @regression) excludes @serial', async () => {
    const { defineE2EConfig } = await configWith({ UNIVERSE_E2E_ONLY_TAG: '@regression' })
    const { grep, grepInvert } = defineE2EConfig()
    expect(matches(grep, 'right-clicking a chip @regression @serial')).toBe(true)
    expect(matches(grepInvert, 'right-clicking a chip @regression @serial')).toBe(true)
    expect(matches(grepInvert, 'right-clicking a chip @regression')).toBe(false)
  })

  it('merges an explicit ONLY_TAG_INVERT with the implicit @serial exclusion', async () => {
    const { defineE2EConfig } = await configWith({
      UNIVERSE_E2E_ONLY_TAG: '@p0',
      UNIVERSE_E2E_ONLY_TAG_INVERT: '@flaky|@perf',
    })
    const { grepInvert } = defineE2EConfig()
    expect(matches(grepInvert, '@serial')).toBe(true)
    expect(matches(grepInvert, '@flaky')).toBe(true)
    expect(matches(grepInvert, '@p0')).toBe(false)
  })

  it('the @serial pass itself keeps @serial cases selected', async () => {
    const { defineE2EConfig } = await configWith({ UNIVERSE_E2E_ONLY_TAG: '@serial' })
    const { grep, grepInvert } = defineE2EConfig()
    expect(matches(grep, 'writes the clipboard @serial')).toBe(true)
    expect(grepInvert).toBeUndefined()
  })

  it('the default pass excludes @serial even when @regression is folded in', async () => {
    const { defineE2EConfig } = await configWith({ UNIVERSE_E2E_INCLUDE_REGRESSION: '1' })
    const { grepInvert } = defineE2EConfig()
    expect(matches(grepInvert, '@regression')).toBe(false)
    expect(matches(grepInvert, '@serial')).toBe(true)
  })
})
