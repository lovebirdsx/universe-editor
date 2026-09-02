import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `nls.ts` reads UNIVERSE_DISPLAY_LOCALE once at module load, so each case
// resets the module registry and re-imports after setting the env. Mirrors
// extensions/git/src/__tests__/nls.test.ts.
async function loadLocalize(locale: string | undefined) {
  vi.resetModules()
  if (locale === undefined) delete process.env.UNIVERSE_DISPLAY_LOCALE
  else process.env.UNIVERSE_DISPLAY_LOCALE = locale
  return (await import('../nls.js')).localize
}

/** The Explorer's grey markers — a glyph each, deliberately not translated. */
const GLYPH_KEYS = ['perforce.deco.occupied'] as const

describe('perforce nls localize', () => {
  const original = process.env.UNIVERSE_DISPLAY_LOCALE

  beforeEach(() => {
    delete process.env.UNIVERSE_DISPLAY_LOCALE
  })

  afterEach(() => {
    if (original === undefined) delete process.env.UNIVERSE_DISPLAY_LOCALE
    else process.env.UNIVERSE_DISPLAY_LOCALE = original
  })

  it('returns the English default when no locale is set', async () => {
    const localize = await loadLocalize(undefined)
    expect(localize('perforce.group.resolve', 'Needs Resolve')).toBe('Needs Resolve')
  })

  it('returns the Chinese surface when locale is zh-CN', async () => {
    const localize = await loadLocalize('zh-CN')
    expect(localize('perforce.group.resolve', 'Needs Resolve')).toBe('需要合并')
  })

  // The Explorer's grey text can never be truncated (`.scmDescription` is
  // flex-shrink: 0 / nowrap — the file name gives up width first), so it carries
  // a glyph rather than a phrase. Glyphs are language-neutral: a same-valued
  // ZH_CN entry would be dead data that only invites the two sides to drift.
  // Translating one back would put a phrase in the one place that cannot shrink.
  it('leaves the Explorer glyph markers untranslated in zh-CN', async () => {
    const localize = await loadLocalize('zh-CN')
    for (const key of GLYPH_KEYS) {
      expect(localize(key, 'SENTINEL')).toBe('SENTINEL')
    }
  })

  // The flip side of the glyphs: a symbol says nothing on its own, so the hover
  // has to name the condition — and that text IS translated.
  it('still translates the tooltips that explain the glyphs', async () => {
    const localize = await loadLocalize('zh-CN')
    expect(localize('perforce.deco.occupied.tooltip', 'SENTINEL', { 0: 'testuser' })).toContain(
      '他人占用',
    )
  })

  it('interpolates vars regardless of locale', async () => {
    const localize = await loadLocalize('en-US')
    expect(localize('perforce.sync.applied', 'Updated {0} file(s)', { 0: '3' })).toBe(
      'Updated 3 file(s)',
    )
  })
})
