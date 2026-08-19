/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LanguageRegistry,
  languageRegistry,
  type ILanguageDefinition,
} from '../LanguageRegistry.js'

function def(partial: Partial<ILanguageDefinition> & { id: string }): ILanguageDefinition {
  return {
    extensionLocation: URI.file('/ext'),
    sourceExtensionId: 'test-ext',
    ...partial,
  }
}

describe('LanguageRegistry', () => {
  const registry = new LanguageRegistry()
  afterEach(() => {
    registry._resetForTests()
  })

  it('looks up by extension case-insensitively, normalizing a missing dot', () => {
    registry.registerLanguages([def({ id: 'csv', extensions: ['.CSV', 'DAT'] })])
    expect(registry.lookupByExtension('.csv')?.id).toBe('csv')
    expect(registry.lookupByExtension('.dat')?.id).toBe('csv')
  })

  it('looks up by exact filename (lowercased)', () => {
    registry.registerLanguages([def({ id: 'makefile', filenames: ['Makefile'] })])
    expect(registry.lookupByFilename('makefile')?.id).toBe('makefile')
    expect(registry.lookupByFilename('Makefile')).toBeUndefined()
  })

  it('matches filenamePatterns against a path, slashless patterns at any depth', () => {
    registry.registerLanguages([def({ id: 'sql', filenamePatterns: ['*.sql'] })])
    expect(registry.lookupByPattern('/a/b/query.sql')?.id).toBe('sql')
    expect(registry.lookupByPattern('query.sql')?.id).toBe('sql')
    expect(registry.lookupByPattern('/a/query.sql.bak')).toBeUndefined()
  })

  it('unregisters only the same registration (later overwrite survives)', () => {
    const first = registry.registerLanguages([def({ id: 'a', extensions: ['.foo'] })])
    registry.registerLanguages([def({ id: 'b', extensions: ['.foo'], sourceExtensionId: 'other' })])
    first.dispose()
    expect(registry.lookupByExtension('.foo')?.id).toBe('b')
  })

  it('fires onDidChangeLanguages on register and unregister', () => {
    let fires = 0
    const listener = registry.onDidChangeLanguages(() => fires++)
    const handle = registry.registerLanguages([def({ id: 'x', extensions: ['.x'] })])
    expect(fires).toBe(1)
    handle.dispose()
    expect(fires).toBe(2)
    listener.dispose()
  })

  it('returns definitions in registration order', () => {
    const local = new LanguageRegistry()
    local.registerLanguages([def({ id: 'one' }), def({ id: 'two' })])
    expect(local.getDefinitions().map((d) => d.id)).toEqual(['one', 'two'])
  })
})

describe('languageRegistry singleton', () => {
  afterEach(() => {
    languageRegistry._resetForTests()
  })

  it('is queryable after a registerLanguages batch', () => {
    const handle = languageRegistry.registerLanguages([
      {
        id: 'csv',
        extensions: ['.csv'],
        extensionLocation: URI.file('/ext'),
        sourceExtensionId: 'csv-ext',
      },
    ])
    expect(languageRegistry.lookupByExtension('.csv')?.id).toBe('csv')
    handle.dispose()
    expect(languageRegistry.lookupByExtension('.csv')).toBeUndefined()
  })
})
