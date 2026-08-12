/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/files/languageDisplay.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { displayNameFromAliases, languageDisplayName } from '../languageDisplay.js'

describe('displayNameFromAliases', () => {
  it('prefers the override table over aliases', () => {
    expect(displayNameFromAliases('plaintext', ['plaintext'])).toBe('Plain Text')
    expect(displayNameFromAliases('dotenv')).toBe('Dotenv')
    expect(displayNameFromAliases('ignore')).toBe('Ignore')
    expect(displayNameFromAliases('makefile')).toBe('Makefile')
    expect(displayNameFromAliases('diff')).toBe('Diff')
  })

  it('uses the first alias when no override matches', () => {
    expect(displayNameFromAliases('typescript', ['TypeScript', 'ts'])).toBe('TypeScript')
    expect(displayNameFromAliases('csharp', ['C#'])).toBe('C#')
  })

  it('falls back to the capitalized id when aliases are missing or empty', () => {
    expect(displayNameFromAliases('python', [])).toBe('Python')
    expect(displayNameFromAliases('python')).toBe('Python')
    expect(displayNameFromAliases('objective-c')).toBe('Objective-c')
  })
})

describe('languageDisplayName', () => {
  // renderer-node: Monaco is never loaded, so the wrapper must degrade to the
  // pure fallback instead of throwing.
  it('falls back gracefully when Monaco is not initialized', () => {
    expect(languageDisplayName('json')).toBe('JSON')
    expect(languageDisplayName('plaintext')).toBe('Plain Text')
    expect(languageDisplayName('dotenv')).toBe('Dotenv')
  })
})
