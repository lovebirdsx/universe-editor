import { describe, expect, it } from 'vitest'
import { scmViewState } from '../scmViewState.js'

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
})
