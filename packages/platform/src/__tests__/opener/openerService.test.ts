/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/opener/openerService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import { extractSelection, withSelection } from '../../opener/openerService.js'

describe('withSelection', () => {
  const file = URI.file('/some/file.ts')

  it('encodes a single position', () => {
    expect(withSelection(file, { startLineNumber: 73, startColumn: 84 }).fragment).toBe('73,84')
  })

  it('encodes a range', () => {
    expect(
      withSelection(file, {
        startLineNumber: 73,
        startColumn: 84,
        endLineNumber: 83,
        endColumn: 52,
      }).fragment,
    ).toBe('73,84-83,52')
  })

  it('omits the end column when absent', () => {
    expect(
      withSelection(file, { startLineNumber: 73, startColumn: 84, endLineNumber: 83 }).fragment,
    ).toBe('73,84-83')
  })
})

describe('extractSelection', () => {
  const base = URI.file('/some/file.ts')

  it('parses line only', () => {
    const { selection, uri } = extractSelection(base.with({ fragment: '73' }))
    expect(selection).toEqual({ startLineNumber: 73, startColumn: 1 })
    expect(uri.fragment).toBe('')
  })

  it('parses an L-prefixed line', () => {
    expect(extractSelection(base.with({ fragment: 'L73' })).selection).toEqual({
      startLineNumber: 73,
      startColumn: 1,
    })
  })

  it('parses line and column', () => {
    expect(extractSelection(base.with({ fragment: '73,84' })).selection).toEqual({
      startLineNumber: 73,
      startColumn: 84,
    })
  })

  it('parses a full range', () => {
    expect(extractSelection(base.with({ fragment: 'L73,84-L83,52' })).selection).toEqual({
      startLineNumber: 73,
      startColumn: 84,
      endLineNumber: 83,
      endColumn: 52,
    })
  })

  it('defaults the end column to 1 when only the end line is given', () => {
    expect(extractSelection(base.with({ fragment: '73-83' })).selection).toEqual({
      startLineNumber: 73,
      startColumn: 1,
      endLineNumber: 83,
      endColumn: 1,
    })
  })

  it('returns no selection and the untouched URI for a non-position fragment', () => {
    const uri = base.with({ fragment: 'section-heading' })
    const result = extractSelection(uri)
    expect(result.selection).toBeUndefined()
    expect(result.uri.fragment).toBe('section-heading')
  })

  it('round-trips with withSelection', () => {
    const selection = { startLineNumber: 10, startColumn: 5, endLineNumber: 12, endColumn: 3 }
    expect(extractSelection(withSelection(base, selection)).selection).toEqual(selection)
  })
})
