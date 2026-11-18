/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/editor/modelDirty.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { isModelAtCleanVersion } from '../modelDirty.js'

function makeModel(
  value: string,
  alternativeVersionId: number,
  options: { tooLarge?: boolean; onGetValue?: () => void } = {},
) {
  const model = {
    getAlternativeVersionId: () => alternativeVersionId,
    getValueLength: () => value.length,
    getValue: () => {
      options.onGetValue?.()
      return value
    },
  }
  return options.tooLarge ? { ...model, isTooLargeForHeapOperation: () => true } : model
}

describe('isModelAtCleanVersion', () => {
  it('is clean when the alternative version id still matches the saved one', () => {
    const getValue = vi.fn(() => 'abc')
    expect(
      isModelAtCleanVersion(
        { getAlternativeVersionId: () => 1, getValueLength: () => 3, getValue },
        1,
        'abc',
      ),
    ).toBe(true)
    expect(getValue).not.toHaveBeenCalled()
  })

  it('is dirty without reading the buffer when the length differs', () => {
    const getValue = vi.fn(() => 'abcd')
    expect(
      isModelAtCleanVersion(
        { getAlternativeVersionId: () => 2, getValueLength: () => 4, getValue },
        1,
        'abc',
      ),
    ).toBe(false)
    expect(getValue).not.toHaveBeenCalled()
  })

  it('is clean when a cancelled IME composition left the content at the saved baseline', () => {
    expect(isModelAtCleanVersion(makeModel('abc', 3), 1, 'abc')).toBe(true)
  })

  it('is clean when text was deleted and retyped back to the saved baseline', () => {
    expect(isModelAtCleanVersion(makeModel('abc', 5), 1, 'abc')).toBe(true)
  })

  it('is dirty when the length matches but the content differs', () => {
    expect(isModelAtCleanVersion(makeModel('abd', 2), 1, 'abc')).toBe(false)
  })

  it('stays dirty on models that refuse getValue() for heap safety', () => {
    const getValue = vi.fn(() => 'abc')
    expect(
      isModelAtCleanVersion(
        makeModel('abc', 2, { tooLarge: true, onGetValue: getValue }),
        1,
        'abc',
      ),
    ).toBe(false)
    expect(getValue).not.toHaveBeenCalled()
  })
})
