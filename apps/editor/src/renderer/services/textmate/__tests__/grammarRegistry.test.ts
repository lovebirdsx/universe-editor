/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { GrammarRegistry, type IGrammarDefinition } from '../grammarRegistry.js'

function def(partial: Partial<IGrammarDefinition> & { scopeName: string }): IGrammarDefinition {
  return {
    path: `./syntaxes/${partial.scopeName}.tmLanguage.json`,
    location: URI.file(`/ext/syntaxes/${partial.scopeName}.tmLanguage.json`),
    sourceExtensionId: 'test-ext',
    ...partial,
  }
}

describe('GrammarRegistry', () => {
  it('registers and looks up by scopeName and language', () => {
    const registry = new GrammarRegistry()
    registry.registerGrammars([
      def({ scopeName: 'source.ts', language: 'typescript' }),
      def({ scopeName: 'source.js', language: 'javascript' }),
    ])

    expect(registry.getGrammarDefinition('source.ts')?.language).toBe('typescript')
    expect(registry.getScopeForLanguage('typescript')).toBe('source.ts')
    expect(registry.getScopeForLanguage('javascript')).toBe('source.js')
    expect(registry.getScopeForLanguage('nope')).toBeUndefined()
    expect(registry.getRegisteredLanguages()).toEqual(['typescript', 'javascript'])
  })

  it('fires onDidChangeGrammars on register and unregister', () => {
    const registry = new GrammarRegistry()
    let fires = 0
    registry.onDidChangeGrammars(() => fires++)
    const handle = registry.registerGrammars([def({ scopeName: 'source.ts' })])
    expect(fires).toBe(1)
    handle.dispose()
    expect(fires).toBe(2)
    expect(registry.getGrammarDefinition('source.ts')).toBeUndefined()
  })

  it('unregister only removes the same registration (a later overwrite survives)', () => {
    const registry = new GrammarRegistry()
    const first = registry.registerGrammars([
      def({ scopeName: 'source.ts', language: 'typescript' }),
    ])
    registry.registerGrammars([
      {
        ...def({ scopeName: 'source.ts', language: 'typescript' }),
        location: URI.file('/other/syntaxes/ts.tmLanguage.json'),
      },
    ])
    first.dispose()
    // The overwrite is still current — unregistering the stale batch must not
    // clear the scope.
    expect(registry.getGrammarDefinition('source.ts')?.location.path).toBe(
      '/other/syntaxes/ts.tmLanguage.json',
    )
    expect(registry.getScopeForLanguage('typescript')).toBe('source.ts')
  })

  it('collects injections prefix-wise (VSCode getInjections semantics)', () => {
    const registry = new GrammarRegistry()
    registry.registerGrammars([
      def({ scopeName: 'injection.broad', injectTo: ['source'] }),
      def({ scopeName: 'injection.specific', injectTo: ['source.ts'] }),
    ])

    // 'source.ts' collects injections for the 'source' prefix and 'source.ts'.
    expect(registry.getInjections('source.ts')).toEqual(['injection.broad', 'injection.specific'])
    // 'source' only collects its own prefix.
    expect(registry.getInjections('source')).toEqual(['injection.broad'])
    // Unrelated scope gets nothing.
    expect(registry.getInjections('text.html')).toEqual([])
  })

  it('unregister cleans the injection map', () => {
    const registry = new GrammarRegistry()
    const handle = registry.registerGrammars([
      def({ scopeName: 'injection.jsdoc', injectTo: ['source.ts'] }),
    ])
    expect(registry.getInjections('source.ts')).toEqual(['injection.jsdoc'])
    handle.dispose()
    expect(registry.getInjections('source.ts')).toEqual([])
  })
})
