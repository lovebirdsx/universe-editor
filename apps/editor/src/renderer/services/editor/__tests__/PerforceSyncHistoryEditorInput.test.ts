import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerforceSyncHistoryEditorInput } from '../PerforceSyncHistoryEditorInput.js'
import {
  _resetForTests,
  perforceSyncHistoryViewState,
} from '../../perforceSyncHistory/syncHistoryViewState.js'

afterEach(() => {
  _resetForTests()
})

describe('PerforceSyncHistoryEditorInput', () => {
  it('has a constant identity, so every open lands on the one tab', () => {
    const a = new PerforceSyncHistoryEditorInput()
    const b = new PerforceSyncHistoryEditorInput()
    expect(a.typeId).toBe('perforceSyncHistory')
    expect(a.resource.toString()).toBe('universe:/perforceSyncHistory')
    expect(a.id).toBe('universe:/perforceSyncHistory')
    expect(a.id).toBe(b.id)
    expect(a.getName()).toBe('Perforce Sync History')
  })

  it('restores from nothing and refuses a payload it has no place for', () => {
    expect(PerforceSyncHistoryEditorInput.deserialize(undefined)).toBeInstanceOf(
      PerforceSyncHistoryEditorInput,
    )
    expect(PerforceSyncHistoryEditorInput.deserialize(null)).toBeInstanceOf(
      PerforceSyncHistoryEditorInput,
    )
    // A payload would mean the id had drifted from the constant URI above.
    expect(PerforceSyncHistoryEditorInput.deserialize({ paths: [] })).toBeNull()
    expect(PerforceSyncHistoryEditorInput.deserialize([])).toBeNull()
  })

  it('hands focus to the mounted list, and says so when there is none', () => {
    const input = new PerforceSyncHistoryEditorInput()
    // Nothing mounted yet: the base class's behaviour (focus the editor group)
    // is the honest answer, so the input reports "not handled".
    expect(input.focus()).toBe(false)

    const focusRows = vi.fn()
    perforceSyncHistoryViewState.focusRows = focusRows
    expect(input.focus()).toBe(true)
    expect(focusRows).toHaveBeenCalledTimes(1)
  })
})
