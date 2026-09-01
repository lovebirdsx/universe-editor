import { describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the pure `revertGuardPlan` helper doesn't require the real host.
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

import { revertGuardPlan } from '../extension.js'

/** `p4 revert` only affects opened files; `p4 clean` (Discard Uncollected) only
 *  affects unopened ones. The guard plan must run each command on just the
 *  subset it can affect, and redirect a selection it can't affect at all to the
 *  sibling command instead of confirming a promise it won't keep. */
describe('revertGuardPlan', () => {
  const paths = ['a.txt', 'b.txt', 'c.txt']

  it('revert: all opened → run on the whole selection', () => {
    const opened = new Set(paths)
    expect(revertGuardPlan(paths, opened, 'opened')).toEqual({
      action: 'run',
      targets: paths,
      skipped: 0,
    })
  })

  it('revert: none opened → misdirect (the silent no-op case)', () => {
    expect(revertGuardPlan(paths, new Set(), 'opened')).toEqual({ action: 'misdirect' })
  })

  it('revert: mixed → run on the opened subset and count the skipped', () => {
    const opened = new Set(['a.txt', 'c.txt'])
    expect(revertGuardPlan(paths, opened, 'opened')).toEqual({
      action: 'run',
      targets: ['a.txt', 'c.txt'],
      skipped: 1,
    })
  })

  it('discard: none opened → run on the whole selection', () => {
    expect(revertGuardPlan(paths, new Set(), 'unopened')).toEqual({
      action: 'run',
      targets: paths,
      skipped: 0,
    })
  })

  it('discard: all opened → misdirect (clean never touches opened files)', () => {
    const opened = new Set(paths)
    expect(revertGuardPlan(paths, opened, 'unopened')).toEqual({ action: 'misdirect' })
  })

  it('discard: mixed → run on the unopened subset and count the skipped', () => {
    const opened = new Set(['a.txt', 'c.txt'])
    expect(revertGuardPlan(paths, opened, 'unopened')).toEqual({
      action: 'run',
      targets: ['b.txt'],
      skipped: 2,
    })
  })

  it('empty selection → misdirect (callers short-circuit earlier)', () => {
    expect(revertGuardPlan([], new Set(), 'opened')).toEqual({ action: 'misdirect' })
  })
})
