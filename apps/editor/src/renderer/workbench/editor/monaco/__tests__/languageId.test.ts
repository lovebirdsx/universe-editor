/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for fence-language → Monaco languageId resolution.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach } from 'vitest'
import { resolveLanguageId, _resetForTests } from '../languageId.js'

const fakeMonaco = {
  languages: {
    getLanguages: () => [
      { id: 'javascript', aliases: ['JavaScript', 'js'], extensions: ['.js', '.jsx', '.mjs'] },
      { id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts', '.tsx'] },
      { id: 'python', aliases: ['Python', 'py'], extensions: ['.py'] },
      { id: 'shell', aliases: ['Shell', 'sh'], extensions: ['.sh', '.bash'] },
      { id: 'yaml', aliases: ['YAML', 'yaml', 'yml'], extensions: ['.yaml', '.yml'] },
      { id: 'cpp', aliases: ['C++'], extensions: ['.cpp', '.cc', '.cxx'] },
      { id: 'csharp', aliases: ['C#', 'csharp'], extensions: ['.cs'] },
      { id: 'go', aliases: ['Go'], extensions: ['.go'] },
      { id: 'rust', aliases: ['Rust', 'rust'], extensions: ['.rs'] },
      { id: 'json', aliases: ['JSON', 'json'], extensions: ['.json'] },
    ],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

describe('resolveLanguageId', () => {
  beforeEach(() => _resetForTests())

  it('resolves canonical ids directly', () => {
    expect(resolveLanguageId('json', fakeMonaco)).toBe('json')
    expect(resolveLanguageId('python', fakeMonaco)).toBe('python')
  })

  it('resolves Monaco aliases', () => {
    expect(resolveLanguageId('js', fakeMonaco)).toBe('javascript')
    expect(resolveLanguageId('ts', fakeMonaco)).toBe('typescript')
    expect(resolveLanguageId('py', fakeMonaco)).toBe('python')
    expect(resolveLanguageId('yml', fakeMonaco)).toBe('yaml')
    expect(resolveLanguageId('c#', fakeMonaco)).toBe('csharp')
  })

  it('falls back to file extensions for tags Monaco lists only as extensions', () => {
    expect(resolveLanguageId('bash', fakeMonaco)).toBe('shell')
    expect(resolveLanguageId('cc', fakeMonaco)).toBe('cpp')
    expect(resolveLanguageId('jsx', fakeMonaco)).toBe('javascript')
    expect(resolveLanguageId('rs', fakeMonaco)).toBe('rust')
    expect(resolveLanguageId('cs', fakeMonaco)).toBe('csharp')
  })

  it('uses the extra-alias table for spellings Monaco carries nowhere', () => {
    expect(resolveLanguageId('c++', fakeMonaco)).toBe('cpp')
    expect(resolveLanguageId('golang', fakeMonaco)).toBe('go')
    expect(resolveLanguageId('zsh', fakeMonaco)).toBe('shell')
  })

  it('is case-insensitive', () => {
    expect(resolveLanguageId('JS', fakeMonaco)).toBe('javascript')
    expect(resolveLanguageId('Python', fakeMonaco)).toBe('python')
  })

  it('returns undefined for unknown or empty tags', () => {
    expect(resolveLanguageId('nonsense', fakeMonaco)).toBeUndefined()
    expect(resolveLanguageId('', fakeMonaco)).toBeUndefined()
  })
})
