import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `nls.ts` reads UNIVERSE_DISPLAY_LOCALE once at module load, so each case
// resets the module registry and re-imports after setting the env.
async function loadLocalize(locale: string | undefined) {
  vi.resetModules()
  if (locale === undefined) delete process.env.UNIVERSE_DISPLAY_LOCALE
  else process.env.UNIVERSE_DISPLAY_LOCALE = locale
  return (await import('../nls.js')).localize
}

describe('git nls localize', () => {
  const original = process.env.UNIVERSE_DISPLAY_LOCALE

  beforeEach(() => {
    delete process.env.UNIVERSE_DISPLAY_LOCALE
  })

  afterEach(() => {
    if (original === undefined) delete process.env.UNIVERSE_DISPLAY_LOCALE
    else process.env.UNIVERSE_DISPLAY_LOCALE = original
  })

  it('returns the English default when locale is en-US', async () => {
    const localize = await loadLocalize('en-US')
    expect(localize('git.group.changes', 'Changes')).toBe('Changes')
  })

  it('returns the English default when no locale is set', async () => {
    const localize = await loadLocalize(undefined)
    expect(localize('git.group.changes', 'Changes')).toBe('Changes')
  })

  it('returns the Chinese surface when locale is zh-CN', async () => {
    const localize = await loadLocalize('zh-CN')
    expect(localize('git.group.changes', 'Changes')).toBe('更改')
  })

  it('interpolates vars regardless of locale', async () => {
    const localize = await loadLocalize('en-US')
    expect(localize('git.worktree.created', 'Worktree created at {0}.', { 0: '/tmp' })).toBe(
      'Worktree created at /tmp.',
    )
  })
})
