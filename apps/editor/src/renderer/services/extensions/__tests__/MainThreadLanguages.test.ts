/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadLanguages: registering plugin language providers into
 *  ILanguageFeaturesService and tearing them down on dispose.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DisposableStore,
  DisposableTracker,
  markAsSingleton,
  setDisposableTracker,
  toDisposable,
  type IDisposable,
} from '@universe-editor/platform'
import type { IExtHostLanguages } from '@universe-editor/extensions-common'
import { MainThreadLanguages } from '../MainThreadLanguages.js'
import type { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'

// The host's provider batch races Monaco's dynamic import (see
// $registerProvider); the gate lets tests hold Monaco "not yet loaded" and
// release it mid-flight. Default: already loaded.
let monacoGate: Promise<void> = Promise.resolve()

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => monacoGate.then(() => ({}) as never),
    peek: () => undefined,
    get: () => {
      throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
    },
  },
}))

function fakeLanguageFeatures(): {
  service: ILanguageFeaturesService
  disposed: () => number
  live: () => number
} {
  let created = 0
  let disposedCount = 0
  const register = (): IDisposable => {
    created++
    return toDisposable(() => {
      disposedCount++
    })
  }
  const service = {
    registerDefinitionProvider: register,
    registerReferenceProvider: register,
    registerImplementationProvider: register,
    registerTypeDefinitionProvider: register,
    registerHoverProvider: register,
    registerCompletionProvider: register,
    registerSignatureHelpProvider: register,
    registerDocumentSymbolProvider: register,
    registerRenameProvider: register,
    registerWorkspaceSymbolProvider: register,
    registerFoldingRangeProvider: register,
    registerDocumentLinkProvider: register,
    registerDocumentHighlightProvider: register,
    registerSelectionRangeProvider: register,
    registerCodeActionProvider: register,
    registerDocumentFormattingEditProvider: register,
    registerDocumentSemanticTokensProvider: register,
    registerCodeLensProvider: register,
  } as unknown as ILanguageFeaturesService
  return { service, disposed: () => disposedCount, live: () => created - disposedCount }
}

beforeEach(() => {
  monacoGate = Promise.resolve()
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
