import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
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
  registered: Array<{
    handle: number
    type: LanguageProviderType
    selector: DocumentSelector
    metadata?: ILanguageProviderMetadata
  }>
  unregistered: number[]
  diagnostics: Array<{ owner: string; uri?: UriComponents; count?: number }>
  codeLensRefreshes: number[]
  inlayHintsRefreshes: number[]
} {
  const registered: Array<{
    handle: number
    type: LanguageProviderType
    selector: DocumentSelector
    metadata?: ILanguageProviderMetadata
  }> = []
  const unregistered: number[] = []
  const diagnostics: Array<{ owner: string; uri?: UriComponents; count?: number }> = []
  const codeLensRefreshes: number[] = []
  const inlayHintsRefreshes: number[] = []
  return {
    registered,
    unregistered,
    diagnostics,
    codeLensRefreshes,
    inlayHintsRefreshes,
    impl: {
      $registerProvider: (
        handle: number,
        type: LanguageProviderType,
        selector: DocumentSelector,
        metadata?: ILanguageProviderMetadata,
      ) => {
        registered.push(
          metadata !== undefined
            ? { handle, type, selector, metadata }
            : { handle, type, selector },
        )
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
      $emitInlayHintsDidChange: (handle: number) => {
        inlayHintsRefreshes.push(handle)
      },
      $setLanguageServerStatus: () => {},
      $getLanguages: () => Promise.resolve([]),
      $getDiagnostics: () => Promise.resolve([]),
      $subscribeDiagnostics: () => Promise.resolve(),
      $unsubscribeDiagnostics: () => Promise.resolve(),
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
    expect(mt.diagnostics).toEqual([
      { owner: 'my-linter', uri: URI.from(uri), count: 1 },
      { owner: 'my-linter' },
    ])
  })

  it('revives extension-originated diagnostic uris so the wire codec sees $mid', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const collection = reg.createDiagnosticCollection('my-linter')
    const diag = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: 'x',
    }
    // Hand-built components (no $mid, the TS built-in's shape) and an already
    // revived URI instance must both serialize with $mid for the remote codec.
    const handBuilt: UriComponents = { scheme: 'file', path: '/x' }
    collection.set(handBuilt, [diag])
    collection.delete(handBuilt)
    collection.set(URI.file('/y'), [diag])
    expect(mt.diagnostics).toHaveLength(3)
    for (const entry of mt.diagnostics) {
      expect(JSON.parse(JSON.stringify(entry.uri))).toMatchObject({ $mid: 1 })
    }
    expect(JSON.parse(JSON.stringify(mt.diagnostics[0]!.uri))).toMatchObject({
      scheme: 'file',
      path: '/x',
    })
    expect(JSON.parse(JSON.stringify(mt.diagnostics[2]!.uri))).toMatchObject({
      scheme: 'file',
      path: '/y',
    })
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

  it('registers a range-formatting provider and routes provideDocumentRangeFormattingEdits', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }
    const edits = [{ range, newText: 'formatted' }]
    const disposable = reg.registerDocumentRangeFormattingEditProvider('typescript', {
      provideDocumentRangeFormattingEdits: (_doc, r, options) => {
        expect(r).toEqual(range)
        expect(options).toEqual({ tabSize: 2, insertSpaces: true })
        return edits
      },
    })
    expect(mt.registered).toEqual([
      { handle: 0, type: 'documentRangeFormatting', selector: ['typescript'] },
    ])
    await expect(
      reg.provideDocumentRangeFormattingEdits(0, uri, range, { tabSize: 2, insertSpaces: true }),
    ).resolves.toEqual(edits)
    disposable.dispose()
    expect(mt.unregistered).toEqual([0])
  })

  it('ships on-type trigger characters as metadata and routes provideOnTypeFormattingEdits', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const edits = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        newText: '}',
      },
    ]
    reg.registerOnTypeFormattingEditProvider(
      'typescript',
      {
        provideOnTypeFormattingEdits: (_doc, _position, ch) => {
          expect(ch).toBe('}')
          return edits
        },
      },
      ['}', ';'],
    )
    expect(mt.registered).toEqual([
      {
        handle: 0,
        type: 'onTypeFormatting',
        selector: ['typescript'],
        metadata: { onTypeFormattingTriggerCharacters: ['}', ';'] },
      },
    ])
    await expect(
      reg.provideOnTypeFormattingEdits(0, uri, { line: 0, character: 1 }, '}', {
        tabSize: 4,
        insertSpaces: false,
      }),
    ).resolves.toEqual(edits)
  })

  it('registers an inlay-hints provider and routes provideInlayHints', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const range = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }
    const hints = [{ position: { line: 0, character: 3 }, label: ': string', kind: 1 as const }]
    reg.registerInlayHintsProvider('typescript', {
      provideInlayHints: (_doc, r) => {
        expect(r).toEqual(range)
        return hints
      },
    })
    expect(mt.registered).toEqual([{ handle: 0, type: 'inlayHints', selector: ['typescript'] }])
    await expect(reg.provideInlayHints(0, uri, range)).resolves.toEqual(hints)
  })

  it('bridges an inlay-hints provider onDidChangeInlayHints to $emitInlayHintsDidChange', () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const listeners: Array<() => void> = []
    const disposable = reg.registerInlayHintsProvider('typescript', {
      onDidChangeInlayHints: (listener) => {
        listeners.push(listener)
        return { dispose: () => undefined }
      },
      provideInlayHints: () => [],
    })
    expect(mt.registered).toEqual([{ handle: 0, type: 'inlayHints', selector: ['typescript'] }])
    listeners.forEach((l) => l())
    expect(mt.inlayHintsRefreshes).toEqual([0])
    disposable.dispose()
    expect(mt.unregistered).toEqual([0])
  })

  it('declares resolve support in metadata and hands the original hint (with data) to resolveInlayHint', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const range = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }
    const original = {
      position: { line: 0, character: 3 },
      label: ': string',
      data: { file: 'a.ts', symbol: 42 },
    }
    const resolvedHint = { ...original, tooltip: 'the inferred type' }
    const resolveCalls: unknown[] = []
    reg.registerInlayHintsProvider('typescript', {
      provideInlayHints: () => [original],
      resolveInlayHint: (hint) => {
        resolveCalls.push(hint)
        return resolvedHint
      },
    })
    expect(mt.registered).toEqual([
      {
        handle: 0,
        type: 'inlayHints',
        selector: ['typescript'],
        metadata: { inlayHintsResolve: true },
      },
    ])

    const dtos = await reg.provideInlayHints(0, uri, range)
    expect(dtos).toHaveLength(1)
    // `data` never crosses the wire; the DTO carries cache coordinates instead.
    expect('data' in dtos![0]!).toBe(false)
    const { resolveCacheId, resolveIndex } = dtos![0]!
    expect(resolveCacheId).toBeTypeOf('number')
    expect(resolveIndex).toBe(0)

    const resolved = await reg.resolveInlayHint(0, resolveCacheId!, resolveIndex!)
    // The provider received its own object back — identity, `data` included.
    expect(resolveCalls).toEqual([original])
    expect(resolveCalls[0]).toBe(original)
    expect(resolved).toEqual({
      position: { line: 0, character: 3 },
      label: ': string',
      tooltip: 'the inferred type',
    })
    expect('data' in resolved!).toBe(false)
  })

  it('invalidates the inlay-hint cache on a new provide round and on dispose', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const range = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }
    let round = 0
    const disposable = reg.registerInlayHintsProvider('typescript', {
      provideInlayHints: () => [{ position: { line: 0, character: round++ }, label: 'x' }],
      resolveInlayHint: (hint) => hint,
    })

    const first = await reg.provideInlayHints(0, uri, range)
    const second = await reg.provideInlayHints(0, uri, range)
    expect(second![0]!.resolveCacheId).not.toBe(first![0]!.resolveCacheId)
    // The superseded round's coordinates no longer resolve.
    await expect(
      reg.resolveInlayHint(0, first![0]!.resolveCacheId!, first![0]!.resolveIndex!),
    ).resolves.toBeNull()
    await expect(
      reg.resolveInlayHint(0, second![0]!.resolveCacheId!, second![0]!.resolveIndex!),
    ).resolves.not.toBeNull()

    disposable.dispose()
    await expect(
      reg.resolveInlayHint(0, second![0]!.resolveCacheId!, second![0]!.resolveIndex!),
    ).resolves.toBeNull()
  })

  it('tags no resolve coordinates when the provider lacks resolveInlayHint', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    const range = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }
    reg.registerInlayHintsProvider('typescript', {
      provideInlayHints: () => [{ position: { line: 0, character: 3 }, label: 'x' }],
    })
    expect(mt.registered).toEqual([{ handle: 0, type: 'inlayHints', selector: ['typescript'] }])
    const dtos = await reg.provideInlayHints(0, uri, range)
    expect(dtos![0]!.resolveCacheId).toBeUndefined()
    await expect(reg.resolveInlayHint(0, 0, 0)).resolves.toBeNull()
  })

  it('returns null from the new provide* routes when the handle type does not match', async () => {
    const mt = recording()
    const reg = new LanguageProviderRegistry(() => mt.impl, new ExtHostDocuments())
    reg.registerHoverProvider('typescript', { provideHover: () => null })
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    await expect(
      reg.provideDocumentRangeFormattingEdits(0, uri, range, { tabSize: 2, insertSpaces: true }),
    ).resolves.toBeNull()
    await expect(
      reg.provideOnTypeFormattingEdits(0, uri, { line: 0, character: 0 }, '}', {
        tabSize: 2,
        insertSpaces: true,
      }),
    ).resolves.toBeNull()
    await expect(reg.provideInlayHints(0, uri, range)).resolves.toBeNull()
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
