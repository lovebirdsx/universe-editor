import { afterEach, describe, expect, it } from 'vitest'
import { scmViewState } from '../scmViewState.js'

afterEach(() => scmViewState._resetForTests())

describe('scmViewState', () => {
  it('setViewMode updates the shared view-mode observable', () => {
    scmViewState.setViewMode('tree')
    expect(scmViewState.viewMode.get()).toBe('tree')
    scmViewState.setViewMode('list')
    expect(scmViewState.viewMode.get()).toBe('list')
  })

  it('requestCollapseAll increments the signal counter', () => {
    const before = scmViewState.collapseAllSignal.get()
    scmViewState.requestCollapseAll()
    expect(scmViewState.collapseAllSignal.get()).toBe(before + 1)
    scmViewState.requestCollapseAll()
    expect(scmViewState.collapseAllSignal.get()).toBe(before + 2)
  })

  it('requestReveal bumps the tick and records the focusInput intent', () => {
    scmViewState.requestReveal('D:/repo/a.ts')
    expect(scmViewState.getRevealRequest()).toEqual({ fsPath: 'D:/repo/a.ts', tick: 1 })

    scmViewState.requestReveal(null, { focusInput: true })
    expect(scmViewState.getRevealRequest()).toEqual({
      fsPath: null,
      tick: 2,
      focusInput: true,
    })
  })
})
