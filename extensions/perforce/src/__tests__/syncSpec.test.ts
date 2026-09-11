import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  effectiveSyncScope,
  scopeTextOf,
  syncPickItems,
  syncPromptOf,
  syncSpecOf,
  SYNC_FORCE_LABEL_COLOR,
} from '../syncSpec.js'

const KINDS = ['head', 'changelist', 'date', 'rev'] as const

// The id crosses a package boundary as a bare string: `labelColorClass` in
// `workbench-ui` recognises `'force'` and silently falls back to the plain
// color for anything else, so a rename on either side would leave every other
// test green and the destructive rows looking ordinary. Pinned literally here
// (the renderer side is pinned by QuickInput.test.tsx) — this one exists to go
// red.
describe('SYNC_FORCE_LABEL_COLOR', () => {
  it('is the id the renderer knows', () => {
    expect(SYNC_FORCE_LABEL_COLOR).toBe('force')
  })
})

describe('syncPickItems', () => {
  it('offers the four ways to name a revision, plain then forced', () => {
    const items = syncPickItems()
    expect(items).toHaveLength(8)
    expect(items.map((i) => i.kind)).toEqual([...KINDS, ...KINDS])
  })

  // The forced rows are the destructive ones and the list is picked with the
  // keyboard as often as the mouse: a `#head -f` row that drifted upward would
  // be what a stray Enter overwrites local work with.
  it('keeps every forced row below every plain one', () => {
    expect(syncPickItems().map((i) => i.force)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ])
  })

  it('flags the forced rows for the renderer and leaves the plain rows unflagged', () => {
    const items = syncPickItems()
    for (const row of items.slice(4)) {
      expect(row.labelColor).toBe(SYNC_FORCE_LABEL_COLOR)
    }
    // Not `labelColor: undefined` — the key is absent, so an unflagging binder
    // (or a future `??` default) cannot resurrect a color for a plain get.
    for (const row of items.slice(0, 4)) {
      expect(row).not.toHaveProperty('labelColor')
    }
  })

  it('marks the forced rows by a shared label prefix the plain rows never use', () => {
    const items = syncPickItems()
    const forced = items.slice(4).map((i) => i.label)
    const prefix = forced.reduce((acc, label) => {
      let i = 0
      while (i < acc.length && i < label.length && acc[i] === label[i]) i++
      return acc.slice(0, i)
    })
    expect(prefix.trim().length).toBeGreaterThan(0)
    for (const row of items.slice(0, 4)) {
      expect(row.label.startsWith(prefix)).toBe(false)
    }
  })

  it('pairs each forced row with its plain twin, one `-f` apart', () => {
    const items = syncPickItems()
    for (let i = 0; i < 4; i++) {
      expect(items[i + 4]!.description).toBe(`${items[i]!.description} -f`)
      // Plain rows never advertise the flag; forced rows always do.
      expect(items[i]!.description).not.toContain('-f')
    }
  })

  it('labels and descriptions are one per row (no copy-paste collisions)', () => {
    const items = syncPickItems()
    expect(new Set(items.map((i) => i.label)).size).toBe(8)
    expect(new Set(items.map((i) => i.description)).size).toBe(8)
  })
})

describe('syncPromptOf', () => {
  it('asks for nothing on the rows whose value is fixed (#head)', () => {
    expect(syncPromptOf('head')).toBeUndefined()
  })

  it('asks for a value on the other three rows', () => {
    for (const kind of KINDS.slice(1)) {
      const ask = syncPromptOf(kind)
      expect(ask?.prompt.length).toBeGreaterThan(0)
      expect(ask?.placeHolder.length).toBeGreaterThan(0)
    }
  })
})

describe('syncSpecOf', () => {
  it('#head ignores whatever was typed — the row never opened an input box', () => {
    expect(syncSpecOf('head', undefined)).toBe('#head')
    expect(syncSpecOf('head', '')).toBe('#head')
    expect(syncSpecOf('head', '#4')).toBe('#head')
  })

  it('prefixes a bare value with the sigil its row implies', () => {
    expect(syncSpecOf('changelist', '4521')).toBe('@4521')
    expect(syncSpecOf('date', '2026/08/01')).toBe('@2026/08/01')
    expect(syncSpecOf('rev', '4')).toBe('#4')
  })

  it('trims, and honours a sigil the user typed rather than doubling it', () => {
    expect(syncSpecOf('changelist', '  4521 ')).toBe('@4521')
    expect(syncSpecOf('changelist', '@4521')).toBe('@4521')
    expect(syncSpecOf('rev', '#4')).toBe('#4')
  })

  // A typed sigil names a different shape than the row did. Kept as-is (p4 gets
  // exactly what was typed); the confirmation names that spec, so the user sees
  // it before anything runs.
  it('lets a typed sigil override the row', () => {
    expect(syncSpecOf('changelist', '#4')).toBe('#4')
    expect(syncSpecOf('rev', '@4521')).toBe('@4521')
  })

  it('treats an empty input as "not this time"', () => {
    expect(syncSpecOf('changelist', undefined)).toBeUndefined()
    expect(syncSpecOf('changelist', '')).toBeUndefined()
    expect(syncSpecOf('rev', '   ')).toBeUndefined()
  })
})

describe('effectiveSyncScope', () => {
  it('uses an explicit scope', () => {
    expect(effectiveSyncScope(['X:/ws/src/...'], ['//...'])).toEqual(['X:/ws/src/...'])
  })

  // `PerforceClient._syncTargets` falls back on an empty list exactly as it does
  // on an absent one, so the confirmation must name the same range p4 will use.
  it('falls back when the scope is absent or empty', () => {
    expect(effectiveSyncScope(undefined, ['//...'])).toEqual(['//...'])
    expect(effectiveSyncScope([], ['//...'])).toEqual(['//...'])
  })
})

describe('scopeTextOf', () => {
  it('renders a short scope verbatim, without a count', () => {
    expect(scopeTextOf(['X:/ws/a.txt', 'X:/ws/b.txt'])).toBe('X:/ws/a.txt, X:/ws/b.txt')
  })

  it('keeps a scope that is exactly at the limit', () => {
    expect(scopeTextOf(['a'.repeat(300)])).toBe('a'.repeat(300))
  })

  it('truncates past the limit', () => {
    expect(scopeTextOf(['a'.repeat(301)])).toBe(`${'a'.repeat(300)}…`)
  })

  it('adds the path count only when truncating several — "(1 filespecs)" is noise', () => {
    expect(scopeTextOf(['a'.repeat(200), 'b'.repeat(200)])).toBe(
      `${'a'.repeat(200)}, ${'b'.repeat(98)}… (2 filespecs)`,
    )
  })
})

describe('forceConfirmMessage', () => {
  const original = process.env.UNIVERSE_DISPLAY_LOCALE

  afterEach(() => {
    if (original === undefined) delete process.env.UNIVERSE_DISPLAY_LOCALE
    else process.env.UNIVERSE_DISPLAY_LOCALE = original
  })

  async function load(locale: string) {
    vi.resetModules()
    process.env.UNIVERSE_DISPLAY_LOCALE = locale
    return await import('../syncSpec.js')
  }

  it('names the target spec and the scope', async () => {
    const { forceConfirmMessage } = await load('en-US')
    for (const spec of ['#head', '@4521', '@2026/08/01', '#4']) {
      const body = forceConfirmMessage(spec, 'X:/ws/src/...')
      expect(body).toContain(spec)
      expect(body).toContain('X:/ws/src/...')
    }
  })

  // The spec can be a revision or a date, so the body may not call it a
  // changelist. The graph's get is always `@CL`, this one is not.
  it('does not call a non-changelist spec a changelist', async () => {
    const { forceConfirmMessage } = await load('en-US')
    expect(forceConfirmMessage('#4', 's')).not.toMatch(/changelist/i)
    expect(forceConfirmMessage('@2026/08/01', 's')).not.toMatch(/changelist/i)
  })

  // These three phrases are what the force-get e2e specs assert on; changing the
  // wording without them turns a dialog assertion into a red e2e run.
  it('keeps the wording the e2e dialogs are asserted on', async () => {
    const { forceConfirmMessage } = await load('en-US')
    const body = forceConfirmMessage('@4521', 'X:/ws/src/...')
    expect(body).toContain('Perforce thinks they are current')
    expect(body).toContain('uncollected changes')
    expect(body).toContain('cannot be undone')
  })

  it('carries a truncated scope through with its count', async () => {
    const { forceConfirmMessage } = await load('en-US')
    const body = forceConfirmMessage('@4521', scopeTextOf(['a'.repeat(200), 'b'.repeat(200)]))
    expect(body).toContain('… (2 filespecs)')
  })
})
