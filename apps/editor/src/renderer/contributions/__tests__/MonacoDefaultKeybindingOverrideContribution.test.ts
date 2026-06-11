import { describe, expect, it } from 'vitest'
import { diffMonacoDisabled } from '../MonacoDefaultKeybindingOverrideContribution.js'

describe('diffMonacoDisabled', () => {
  it('adds newly desired commands not yet applied', () => {
    const { toAdd, toRemove } = diffMonacoDisabled(new Set(['a', 'b']), new Set(['a']))
    expect(toAdd).toEqual(['b'])
    expect(toRemove).toEqual([])
  })

  it('removes applied commands no longer desired', () => {
    const { toAdd, toRemove } = diffMonacoDisabled(new Set(['a']), new Set(['a', 'b']))
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual(['b'])
  })

  it('is a no-op when desired equals applied', () => {
    const { toAdd, toRemove } = diffMonacoDisabled(new Set(['a', 'b']), new Set(['b', 'a']))
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual([])
  })
})
