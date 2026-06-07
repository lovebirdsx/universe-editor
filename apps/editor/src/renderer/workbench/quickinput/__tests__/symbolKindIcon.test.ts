/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/quickinput/symbolKindIcon.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Hash } from 'lucide-react'
import { resolveSymbolKindIcon } from '../symbolKindIcon.js'

describe('resolveSymbolKindIcon', () => {
  it('resolves a known kind (String=14 → Hash, as markdown headings)', () => {
    expect(resolveSymbolKindIcon('symbol-kind-14')).toBe(Hash)
  })

  it('falls back to Hash for an out-of-range kind', () => {
    expect(resolveSymbolKindIcon('symbol-kind-999')).toBe(Hash)
  })

  it('returns undefined for ids outside the symbol-kind namespace', () => {
    expect(resolveSymbolKindIcon('files')).toBeUndefined()
    expect(resolveSymbolKindIcon('symbol-kind-')).toBeUndefined()
    expect(resolveSymbolKindIcon('symbol-kind-abc')).toBeUndefined()
  })
})
