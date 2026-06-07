/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/languageFeatures/LanguageFeaturesService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'

const registerDocumentSymbolProvider = vi.fn(() => ({ dispose: vi.fn() }))
const registerDefinitionProvider = vi.fn(() => ({ dispose: vi.fn() }))
const registerReferenceProvider = vi.fn(() => ({ dispose: vi.fn() }))

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({
      languages: {
        registerDocumentSymbolProvider,
        registerDefinitionProvider,
        registerReferenceProvider,
      },
    }),
  },
}))

import { LanguageFeaturesService } from '../LanguageFeaturesService.js'

const fakeProvider = { provideDocumentSymbols: vi.fn() } as never

describe('LanguageFeaturesService', () => {
  it('exposes a registered document symbol provider via the mirror table', () => {
    const svc = new LanguageFeaturesService()
    svc.registerDocumentSymbolProvider('markdown', fakeProvider)
    expect(svc.getDocumentSymbolProviders('markdown')).toHaveLength(1)
    expect(svc.getDocumentSymbolProviders('json')).toEqual([])
    svc.dispose()
  })

  it('forwards the registration to Monaco', () => {
    registerDocumentSymbolProvider.mockClear()
    const svc = new LanguageFeaturesService()
    svc.registerDocumentSymbolProvider('markdown', fakeProvider)
    expect(registerDocumentSymbolProvider).toHaveBeenCalledTimes(1)
    expect(registerDocumentSymbolProvider).toHaveBeenCalledWith('markdown', fakeProvider)
    svc.dispose()
  })

  it('fires onDidChangeDocumentSymbolProviders on register and dispose', () => {
    const svc = new LanguageFeaturesService()
    const seen: string[] = []
    svc.onDidChangeDocumentSymbolProviders((e) => seen.push(e.languageId))
    const reg = svc.registerDocumentSymbolProvider('markdown', fakeProvider)
    reg.dispose()
    expect(seen).toEqual(['markdown', 'markdown'])
    svc.dispose()
  })

  it('removes the provider and the Monaco registration on dispose', () => {
    const monacoDispose = vi.fn()
    registerDocumentSymbolProvider.mockReturnValueOnce({ dispose: monacoDispose })
    const svc = new LanguageFeaturesService()
    const reg = svc.registerDocumentSymbolProvider('markdown', fakeProvider)
    expect(svc.getDocumentSymbolProviders('markdown')).toHaveLength(1)
    reg.dispose()
    expect(monacoDispose).toHaveBeenCalledTimes(1)
    expect(svc.getDocumentSymbolProviders('markdown')).toEqual([])
    svc.dispose()
  })

  it('also forwards definition and reference providers to Monaco', () => {
    registerDefinitionProvider.mockClear()
    registerReferenceProvider.mockClear()
    const svc = new LanguageFeaturesService()
    svc.registerDefinitionProvider('markdown', fakeProvider)
    svc.registerReferenceProvider('markdown', fakeProvider)
    expect(registerDefinitionProvider).toHaveBeenCalledTimes(1)
    expect(registerReferenceProvider).toHaveBeenCalledTimes(1)
    svc.dispose()
  })
})
