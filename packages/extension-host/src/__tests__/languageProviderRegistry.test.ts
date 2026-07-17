import { describe, expect, it } from 'vitest'
import type {
  DocumentSelector,
  HoverProvider,
  DefinitionProvider,
  UriComponents,
} from '@universe-editor/extension-api'
import type {
  ILanguageProviderMetadata,
  IMainThreadLanguages,
  LanguageProviderType,
} from '@universe-editor/extensions-common'
import type { Diagnostic } from 'vscode-languageserver-types'
import { LanguageProviderRegistry } from '../languageProviderRegistry.js'
import { ExtHostDocuments } from '../hostDocuments.js'

function recording(): {
  impl: IMainThreadLanguages
  registered: Array<{ handle: number; type: LanguageProviderType; selector: DocumentSelector }>
  unregistered: number[]
  diagnostics: Array<{ owner: string; uri?: UriComponents; count?: number }>
  codeLensRefreshes: number[]
} {
  const registered: Array<{
    handle: number
    type: LanguageProviderType
    selector: DocumentSelector
  }> = []
  const unregistered: number[] = []
  const diagnostics: Array<{ owner: string; uri?: UriComponents; count?: number }> = []
  const codeLensRefreshes: number[] = []
  return {
    registered,
    unregistered,
    diagnostics,
    codeLensRefreshes,
    impl: {
      $registerProvider: (
        handle: number,
        type: LanguageProviderType,
        selector: DocumentSelector,
        _metadata?: ILanguageProviderMetadata,
      ) => {
        registered.push({ handle, type, selector })
        return Promise.resolve()
      },
      $unregisterProvider: (handle: number) => {
        unregistered.push(handle)
        return Promise.resolve()
      },
      $publishDiagnostics: (owner: string, uri: UriComponents, diags: readonly Diagnostic[]) => {
        diagnostics.push({ owner, uri, count: diags.length })
        return Promise.resolve()
      },
      $clearDiagnostics: (owner: string, uri?: UriComponents) => {
        diagnostics.push(uri !== undefined ? { owner, uri } : { owner })
        return Promise.resolve()
      },
      $emitCodeLensDidChange: (handle: number) => {
        codeLensRefreshes.push(handle)
      },
      $setLanguageServerStatus: () => {},
    },
  }
}

const uri: UriComponents = { scheme: 'file', path: '/repo/a.ts' }

describe('LanguageProviderRegistry', () => {
  it('registers a provider with an allocated handle and ships it to the renderer', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const provider: HoverProvider = { provideHover: () => null }
    reg.registerHoverProvider('typescript', provider)
    expect(mt.registered).toEqual([{ handle: 0, type: 'hover', selector: ['typescript'] }])
  })

  it('routes a provide* call to the matching provider', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const hover = { contents: { kind: 'plaintext' as const, value: 'hi' } }
    reg.registerHoverProvider('typescript', { provideHover: () => hover })
    await expect(reg.provideHover(0, uri, { line: 0, character: 0 })).resolves.toEqual(hover)
  })

  it('returns null when the handle type does not match', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const def: DefinitionProvider = { provideDefinition: () => null }
    reg.registerDefinitionProvider('typescript', def)
    // handle 0 is a definition provider; asking for hover on it must miss.
    await expect(reg.provideHover(0, uri, { line: 0, character: 0 })).resolves.toBeNull()
  })

  it('unregisters on dispose', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const d = reg.registerHoverProvider('typescript', { provideHover: () => null })
    d.dispose()
    expect(mt.unregistered).toEqual([0])
  })

  it('allocates distinct handles per registration', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    reg.registerHoverProvider('a', { provideHover: () => null })
    reg.registerHoverProvider('b', { provideHover: () => null })
    expect(mt.registered.map((r) => r.handle)).toEqual([0, 1])
  })

  it('diagnostic collection publishes and clears by owner name', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const collection = reg.createDiagnosticCollection('my-linter')
    collection.set(uri, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' },
    ])
    collection.clear()
    expect(mt.diagnostics).toEqual([{ owner: 'my-linter', uri, count: 1 }, { owner: 'my-linter' }])
  })

  it('bridges a CodeLens provider onDidChangeCodeLenses to $emitCodeLensDidChange', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const listeners: Array<() => void> = []
    const disposable = reg.registerCodeLensProvider('typescript', {
      onDidChangeCodeLenses: (listener) => {
        listeners.push(listener)
        return { dispose: () => undefined }
      },
      provideCodeLenses: () => [],
    })
    expect(mt.registered).toEqual([{ handle: 0, type: 'codeLens', selector: ['typescript'] }])
    listeners.forEach((l) => l())
    expect(mt.codeLensRefreshes).toEqual([0])
    disposable.dispose()
    expect(mt.unregistered).toEqual([0])
  })

  it('stops forwarding CodeLens refreshes after dispose', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    let disposed = false
    const listeners: Array<() => void> = []
    const disposable = reg.registerCodeLensProvider('typescript', {
      onDidChangeCodeLenses: (listener) => {
        listeners.push(listener)
        return { dispose: () => (disposed = true) }
      },
      provideCodeLenses: () => [],
    })
    disposable.dispose()
    expect(disposed).toBe(true)
  })

  it('throws when language features are unavailable', () => {
    const reg = new LanguageProviderRegistry(() => {
      throw new Error('language features are not available in this extension host')
    }, new ExtHostDocuments())
    expect(() => reg.registerHoverProvider('typescript', { provideHover: () => null })).toThrow(
      /not available/,
    )
  })
})
