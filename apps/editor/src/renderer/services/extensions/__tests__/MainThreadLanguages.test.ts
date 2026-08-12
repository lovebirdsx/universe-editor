/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadLanguages: registering plugin language providers into
 *  ILanguageFeaturesService and tearing them down on dispose.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DisposableStore,
  DisposableTracker,
  URI,
  markAsSingleton,
  setDisposableTracker,
  toDisposable,
  type IDisposable,
  type UriComponents,
} from '@universe-editor/platform'
import type { IExtHostLanguages } from '@universe-editor/extensions-common'
import { MainThreadLanguages } from '../MainThreadLanguages.js'
import type { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'

// The host's provider batch races Monaco's dynamic import (see
// $registerProvider); the gate lets tests hold Monaco "not yet loaded" and
// release it mid-flight. Default: already loaded.
let monacoGate: Promise<void> = Promise.resolve()

/** The namespace MonacoLoader hands out; the diagnostics tests swap in one with
 *  an `editor` marker section. Reset to the language-registry-only default by
 *  the top-level beforeEach. */
let monacoNs: unknown = defaultMonacoNs()

function defaultMonacoNs(): unknown {
  return {
    languages: {
      getLanguages: () => [{ id: 'typescript' }, { id: 'markdown' }],
    },
  }
}

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => monacoGate.then(() => monacoNs as never),
    peek: () => monacoNs as never,
    get: () => {
      throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
    },
  },
}))

function fakeLanguageFeatures(): {
  service: ILanguageFeaturesService
  disposed: () => number
  live: () => number
  registeredProviders: () => ReadonlyMap<string, unknown[]>
} {
  let created = 0
  let disposedCount = 0
  const providers = new Map<string, unknown[]>()
  const register =
    (kind: string) =>
    (_languageId: string, provider: unknown): IDisposable => {
      created++
      const list = providers.get(kind) ?? []
      list.push(provider)
      providers.set(kind, list)
      return toDisposable(() => {
        disposedCount++
      })
    }
  const service = {
    registerDefinitionProvider: register('definition'),
    registerReferenceProvider: register('references'),
    registerImplementationProvider: register('implementation'),
    registerTypeDefinitionProvider: register('typeDefinition'),
    registerHoverProvider: register('hover'),
    registerCompletionProvider: register('completion'),
    registerSignatureHelpProvider: register('signatureHelp'),
    registerDocumentSymbolProvider: register('documentSymbol'),
    registerRenameProvider: register('rename'),
    registerWorkspaceSymbolProvider: register('workspaceSymbol'),
    registerFoldingRangeProvider: register('foldingRange'),
    registerDocumentLinkProvider: register('documentLink'),
    registerDocumentHighlightProvider: register('documentHighlight'),
    registerSelectionRangeProvider: register('selectionRange'),
    registerCodeActionProvider: register('codeAction'),
    registerDocumentFormattingEditProvider: register('documentFormatting'),
    registerDocumentRangeFormattingEditProvider: register('documentRangeFormatting'),
    registerOnTypeFormattingEditProvider: register('onTypeFormatting'),
    registerInlayHintsProvider: register('inlayHints'),
    registerDocumentSemanticTokensProvider: register('documentSemanticTokens'),
    registerCodeLensProvider: register('codeLens'),
  } as unknown as ILanguageFeaturesService
  return {
    service,
    disposed: () => disposedCount,
    live: () => created - disposedCount,
    registeredProviders: () => providers,
  }
}

beforeEach(() => {
  monacoGate = Promise.resolve()
  monacoNs = defaultMonacoNs()
})

describe('MainThreadLanguages', () => {
  it('disposes all registered providers when the service is disposed', async () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    await mt.$registerProvider(1, 'definition', ['typescript', 'javascript'])
    await mt.$registerProvider(2, 'references', ['typescript'])
    expect(lf.live()).toBe(3)

    mt.dispose()
    expect(lf.live()).toBe(0)
    expect(lf.disposed()).toBe(3)
  })

  it('disposes the prior provider when a handle is re-registered', async () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    await mt.$registerProvider(1, 'definition', ['typescript'])
    await mt.$registerProvider(1, 'references', ['typescript'])
    expect(lf.disposed()).toBe(1)
    expect(lf.live()).toBe(1)

    mt.dispose()
    expect(lf.live()).toBe(0)
  })

  it('disposes a provider on explicit unregister', async () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    await mt.$registerProvider(5, 'hover', ['typescript'])
    expect(lf.live()).toBe(1)

    await mt.$unregisterProvider(5)
    expect(lf.live()).toBe(0)

    mt.dispose()
  })

  it('drops a late $registerProvider arriving after dispose (dying-host race)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    await mt.$registerProvider(1, 'definition', ['typescript'])
    expect(lf.live()).toBe(1)

    mt.dispose()
    expect(lf.live()).toBe(0)

    // The dying host's in-flight frame lands post-dispose: no new Monaco
    // registrations are created, nothing is resurrected.
    await mt.$registerProvider(2, 'references', ['typescript'])
    expect(lf.live()).toBe(0)
    expect(lf.disposed()).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('waits for Monaco before touching the language features service', async () => {
    let releaseMonaco!: () => void
    monacoGate = new Promise((resolve) => {
      releaseMonaco = resolve
    })
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    const pending = mt.$registerProvider(1, 'definition', ['typescript'])
    await Promise.resolve()
    // Monaco still loading: the batch must be queued, not registered (a direct
    // registration would throw [MonacoLoader] not initialized in production).
    expect(lf.live()).toBe(0)

    releaseMonaco()
    await pending
    expect(lf.live()).toBe(1)

    mt.dispose()
    expect(lf.live()).toBe(0)
  })

  it('drops a registration whose host died while waiting for Monaco', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseMonaco!: () => void
    monacoGate = new Promise((resolve) => {
      releaseMonaco = resolve
    })
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    const pending = mt.$registerProvider(1, 'definition', ['typescript'])
    mt.dispose()
    releaseMonaco()
    await pending

    expect(lf.live()).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('registers range-formatting / on-type-formatting / inlay-hints providers per language', async () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    await mt.$registerProvider(1, 'documentRangeFormatting', ['typescript', 'javascript'])
    await mt.$registerProvider(2, 'onTypeFormatting', ['typescript'], {
      onTypeFormattingTriggerCharacters: ['}'],
    })
    await mt.$registerProvider(3, 'inlayHints', ['typescript'])
    expect(lf.live()).toBe(4)

    const onType = lf.registeredProviders().get('onTypeFormatting')?.[0] as {
      autoFormatTriggerCharacters: string[]
    }
    expect(onType.autoFormatTriggerCharacters).toEqual(['}'])

    await mt.$unregisterProvider(1)
    await mt.$unregisterProvider(2)
    await mt.$unregisterProvider(3)
    expect(lf.live()).toBe(0)
    mt.dispose()
  })

  it('$emitInlayHintsDidChange fires the provider onDidChangeInlayHints so Monaco re-requests', async () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    await mt.$registerProvider(7, 'inlayHints', ['typescript'])
    const provider = lf.registeredProviders().get('inlayHints')?.[0] as {
      onDidChangeInlayHints: (listener: () => void) => IDisposable
    }
    let fired = 0
    const sub = provider.onDidChangeInlayHints(() => fired++)

    mt.$emitInlayHintsDidChange(7)
    expect(fired).toBe(1)
    // An unknown handle is a no-op (the host may emit after an unregister raced).
    mt.$emitInlayHintsDidChange(99)
    expect(fired).toBe(1)

    sub.dispose()
    mt.dispose()
    // The emitter is released with the provider store: a late emit finds nothing.
    mt.$emitInlayHintsDidChange(7)
    expect(fired).toBe(1)
  })

  it('$getLanguages enumerates the Monaco language registry ids', async () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)
    await expect(mt.$getLanguages()).resolves.toEqual(['typescript', 'markdown'])
    mt.dispose()
  })
})

interface FakeMarker {
  resource: string
  severity: number
  message: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  source?: string
  code?: string | { value: string; target: { toString(): string } }
  tags?: number[]
}

/** Monaco namespace stand-in with a marker registry: `editor.getModelMarkers`
 *  answers from `markers`, `onDidChangeMarkers` is fired by the test through
 *  `fireMarkersChanged`. */
function fakeMonacoWithMarkers(markers: FakeMarker[]): {
  fireMarkersChanged: (uris: string[]) => void
  markerListenerCount: () => number
} & Record<string, unknown> {
  const listeners = new Set<(resources: Array<{ toString(): string }>) => void>()
  const stored = markers.map((m) => ({ ...m, resource: { toString: () => m.resource } }))
  return {
    languages: { getLanguages: () => [{ id: 'typescript' }] },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    editor: {
      getModelMarkers: (filter?: { resource?: { toString(): string } }) =>
        filter?.resource
          ? stored.filter((m) => m.resource.toString() === filter.resource?.toString())
          : stored,
      onDidChangeMarkers: (listener: (resources: Array<{ toString(): string }>) => void) => {
        listeners.add(listener)
        return toDisposable(() => listeners.delete(listener))
      },
    },
    fireMarkersChanged: (uris: string[]) => {
      const resources = uris.map((u) => ({ toString: () => u }))
      for (const listener of [...listeners]) listener(resources)
    },
    markerListenerCount: () => listeners.size,
  }
}

function fakeExtHostLanguages(): {
  service: IExtHostLanguages
  pushes: () => Array<readonly UriComponents[]>
} {
  const pushes: Array<readonly UriComponents[]> = []
  const service = {
    $acceptDiagnosticsChange: (uris: readonly UriComponents[]) => {
      pushes.push(uris)
      return Promise.resolve()
    },
  } as unknown as IExtHostLanguages
  return { service, pushes: () => pushes }
}

describe('MainThreadLanguages — diagnostics', () => {
  const errorOnA: FakeMarker = {
    resource: 'file:///test/a.ts',
    severity: 8, // MarkerSeverity.Error
    message: 'boom',
    startLineNumber: 3,
    startColumn: 5,
    endLineNumber: 3,
    endColumn: 9,
    source: 'ts',
    code: { value: '2304', target: { toString: () => 'https://typescript.tv/errors/#2304' } },
    tags: [1], // MarkerTag.Unnecessary
  }
  const warningOnA: FakeMarker = {
    resource: 'file:///test/a.ts',
    severity: 4, // MarkerSeverity.Warning
    message: 'meh',
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 2,
  }
  const hintOnB: FakeMarker = {
    resource: 'file:///test/b.ts',
    severity: 1, // MarkerSeverity.Hint
    message: 'hint',
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 2,
    endColumn: 4,
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("$getDiagnostics returns every owner's markers, grouped per resource and LSP-shaped", async () => {
    monacoNs = fakeMonacoWithMarkers([errorOnA, warningOnA, hintOnB])
    const mt = new MainThreadLanguages({} as IExtHostLanguages, fakeLanguageFeatures().service)

    const all = await mt.$getDiagnostics()
    const byPath = new Map(all.map(([uri, diags]) => [uri.path, diags] as const))
    expect([...byPath.keys()].sort()).toEqual(['/test/a.ts', '/test/b.ts'])

    const aDiags = byPath.get('/test/a.ts')!
    expect(aDiags).toHaveLength(2)
    expect(aDiags[0]).toEqual({
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
      message: 'boom',
      severity: 1,
      source: 'ts',
      code: 2304,
      codeDescription: { href: 'https://typescript.tv/errors/#2304' },
      tags: [1],
    })
    expect(aDiags[1]!.severity).toBe(2)
    expect(byPath.get('/test/b.ts')![0]!.severity).toBe(4)

    mt.dispose()
  })

  it('$getDiagnostics(uri) filters to that resource only', async () => {
    monacoNs = fakeMonacoWithMarkers([errorOnA, hintOnB])
    const mt = new MainThreadLanguages({} as IExtHostLanguages, fakeLanguageFeatures().service)

    const one = await mt.$getDiagnostics(URI.parse('file:///test/b.ts').toJSON())
    expect(one).toHaveLength(1)
    expect(one[0]![0].path).toBe('/test/b.ts')
    expect(one[0]![1]).toHaveLength(1)
    expect(one[0]![1][0]!.message).toBe('hint')

    mt.dispose()
  })

  it('arms no marker listener while nobody is subscribed (zero RPC traffic)', async () => {
    const ns = fakeMonacoWithMarkers([])
    monacoNs = ns
    const ext = fakeExtHostLanguages()
    const mt = new MainThreadLanguages(ext.service, fakeLanguageFeatures().service)

    ns.fireMarkersChanged(['file:///test/a.ts'])
    await vi.advanceTimersByTimeAsync(200)
    expect(ns.markerListenerCount()).toBe(0)
    expect(ext.pushes()).toHaveLength(0)

    mt.dispose()
  })

  it('debounces a burst of marker changes into one push with deduped uris', async () => {
    const ns = fakeMonacoWithMarkers([])
    monacoNs = ns
    const ext = fakeExtHostLanguages()
    const mt = new MainThreadLanguages(ext.service, fakeLanguageFeatures().service)

    await mt.$subscribeDiagnostics()
    expect(ns.markerListenerCount()).toBe(1)

    ns.fireMarkersChanged(['file:///test/a.ts', 'file:///test/b.ts'])
    await vi.advanceTimersByTimeAsync(20)
    ns.fireMarkersChanged(['file:///test/a.ts', 'file:///test/c.ts'])
    await vi.advanceTimersByTimeAsync(200)

    expect(ext.pushes()).toHaveLength(1)
    expect(
      ext
        .pushes()[0]!
        .map((u) => u.path)
        .sort(),
    ).toEqual(['/test/a.ts', '/test/b.ts', '/test/c.ts'])

    mt.dispose()
  })

  it('keeps pushing while a second subscriber remains (interest is ref-counted)', async () => {
    const ns = fakeMonacoWithMarkers([])
    monacoNs = ns
    const ext = fakeExtHostLanguages()
    const mt = new MainThreadLanguages(ext.service, fakeLanguageFeatures().service)

    await mt.$subscribeDiagnostics()
    await mt.$subscribeDiagnostics()
    await mt.$unsubscribeDiagnostics()
    expect(ns.markerListenerCount()).toBe(1)

    ns.fireMarkersChanged(['file:///test/a.ts'])
    await vi.advanceTimersByTimeAsync(200)
    expect(ext.pushes()).toHaveLength(1)

    mt.dispose()
  })

  it('stops pushing after the last unsubscribe and drops a queued burst', async () => {
    const ns = fakeMonacoWithMarkers([])
    monacoNs = ns
    const ext = fakeExtHostLanguages()
    const mt = new MainThreadLanguages(ext.service, fakeLanguageFeatures().service)

    await mt.$subscribeDiagnostics()
    ns.fireMarkersChanged(['file:///test/a.ts'])
    await mt.$unsubscribeDiagnostics()
    expect(ns.markerListenerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(200)
    expect(ext.pushes()).toHaveLength(0)

    ns.fireMarkersChanged(['file:///test/a.ts'])
    await vi.advanceTimersByTimeAsync(200)
    expect(ext.pushes()).toHaveLength(0)

    mt.dispose()
  })

  it('drops a queued push when the service is disposed mid-debounce', async () => {
    const ns = fakeMonacoWithMarkers([])
    monacoNs = ns
    const ext = fakeExtHostLanguages()
    const mt = new MainThreadLanguages(ext.service, fakeLanguageFeatures().service)

    await mt.$subscribeDiagnostics()
    ns.fireMarkersChanged(['file:///test/a.ts'])
    mt.dispose()

    await vi.advanceTimersByTimeAsync(200)
    expect(ext.pushes()).toHaveLength(0)
  })
})

/**
 * Reproduces the leak seen on "Restart Editor": the provider disposables created
 * per `$registerProvider` must root through the owning MainThreadLanguages (which
 * roots through a singleton). A plain `Map<number, IDisposable>` holds the
 * provider stores without establishing a parent link, so the leak tracker — which
 * judges by parent chain, not by whether `dispose()` would eventually run —
 * reports them even though `_disposeProviders` would clean them up on teardown.
 */
describe('MainThreadLanguages — leak tracking', () => {
  let tracker: DisposableTracker

  beforeEach(() => {
    tracker = new DisposableTracker()
    setDisposableTracker(tracker)
  })

  afterEach(() => {
    setDisposableTracker(null)
  })

  it('roots registered providers through a singleton owner (no leak before unmount)', async () => {
    // Mirror the real wiring: a singleton root → owner store → MainThreadLanguages.
    const root = markAsSingleton(new DisposableStore())
    const lf = fakeLanguageFeatures()
    const mt = root.add(new MainThreadLanguages({} as IExtHostLanguages, lf.service))

    await mt.$registerProvider(1, 'definition', ['typescript', 'javascript'])
    await mt.$registerProvider(2, 'references', ['typescript'])

    // Simulate the leak report fired at beforeunload without disposing the
    // singleton-rooted services: nothing should be reported as leaking.
    const report = tracker.computeLeakingDisposables()
    expect(report).toBeUndefined()
  })

  it('a late $registerProvider after dispose leaves no leak', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = markAsSingleton(new DisposableStore())
    const lf = fakeLanguageFeatures()
    const mt = root.add(new MainThreadLanguages({} as IExtHostLanguages, lf.service))

    await mt.$registerProvider(1, 'definition', ['typescript'])
    mt.dispose()
    await mt.$registerProvider(2, 'codeLens', ['typescript'])

    expect(tracker.computeLeakingDisposables()).toBeUndefined()
    vi.mocked(console.warn).mockRestore()
  })

  it('a registration that throws mid-build does not leak the half-built store', async () => {
    // The e2e leak gate caught exactly this: lf.registerXxx throwing (e.g.
    // [MonacoLoader] not initialized) left the DisposableStore created by
    // _createProvider orphaned — tracked, never disposed, never parented.
    const root = markAsSingleton(new DisposableStore())
    const failing = {
      registerDefinitionProvider: () => {
        throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
      },
    } as unknown as ILanguageFeaturesService
    const mt = root.add(new MainThreadLanguages({} as IExtHostLanguages, failing))

    await expect(mt.$registerProvider(1, 'definition', ['typescript'])).rejects.toThrow(
      'not initialized',
    )

    expect(tracker.computeLeakingDisposables()).toBeUndefined()
  })
})
