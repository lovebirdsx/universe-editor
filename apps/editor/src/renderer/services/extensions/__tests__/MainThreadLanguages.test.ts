/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadLanguages: registering plugin language providers into
 *  ILanguageFeaturesService and tearing them down on dispose.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  } as unknown as ILanguageFeaturesService
  return { service, disposed: () => disposedCount, live: () => created - disposedCount }
}

describe('MainThreadLanguages', () => {
  it('disposes all registered providers when the service is disposed', () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    void mt.$registerProvider(1, 'definition', ['typescript', 'javascript'])
    void mt.$registerProvider(2, 'references', ['typescript'])
    expect(lf.live()).toBe(3)

    mt.dispose()
    expect(lf.live()).toBe(0)
    expect(lf.disposed()).toBe(3)
  })

  it('disposes the prior provider when a handle is re-registered', () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    void mt.$registerProvider(1, 'definition', ['typescript'])
    void mt.$registerProvider(1, 'references', ['typescript'])
    expect(lf.disposed()).toBe(1)
    expect(lf.live()).toBe(1)

    mt.dispose()
    expect(lf.live()).toBe(0)
  })

  it('disposes a provider on explicit unregister', () => {
    const lf = fakeLanguageFeatures()
    const mt = new MainThreadLanguages({} as IExtHostLanguages, lf.service)

    void mt.$registerProvider(5, 'hover', ['typescript'])
    expect(lf.live()).toBe(1)

    void mt.$unregisterProvider(5)
    expect(lf.live()).toBe(0)

    mt.dispose()
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

  it('roots registered providers through a singleton owner (no leak before unmount)', () => {
    // Mirror the real wiring: a singleton root → owner store → MainThreadLanguages.
    const root = markAsSingleton(new DisposableStore())
    const lf = fakeLanguageFeatures()
    const mt = root.add(new MainThreadLanguages({} as IExtHostLanguages, lf.service))

    void mt.$registerProvider(1, 'definition', ['typescript', 'javascript'])
    void mt.$registerProvider(2, 'references', ['typescript'])

    // Simulate the leak report fired at beforeunload without disposing the
    // singleton-rooted services: nothing should be reported as leaking.
    const report = tracker.computeLeakingDisposables()
    expect(report).toBeUndefined()
  })
})
