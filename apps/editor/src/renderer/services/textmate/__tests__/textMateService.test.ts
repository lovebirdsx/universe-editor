/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Regression pin: grammar-contributed languages that monaco's basic-languages
 *  don't know (toml, dockercompose, cuda-cpp, …) must be registered into
 *  monaco's language registry when their tokenization factory is wired up.
 *  Otherwise createModel's plaintext fallback (LanguageService
 *  ._createAndGetLanguageIdentifier) silently strips the language and the
 *  factory never fires — the file opens uncolored while the UI still reports
 *  the mapped language id.
 *--------------------------------------------------------------------------------------------*/

import type { IFileService } from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import { TextMateService } from '../textMateService.js'

// The wasm asset only resolves through vite; tests never create a real grammar
// (per onigurumaLoader.ts's own contract), so the lib stays a never-used stub.
vi.mock('../onigurumaLoader.js', () => ({
  getOnigLib: () => new Promise(() => {}),
}))

function makeService(): TextMateService {
  const fileService = {
    readFileText: () => Promise.resolve(''),
  } as unknown as IFileService
  return new TextMateService(fileService, undefined as never)
}

function makeMonacoStub(knownLanguages: readonly string[]) {
  const registered: string[] = []
  const stub = {
    languages: {
      getEncodedLanguageId: () => 1,
      getLanguages: () => knownLanguages.map((id) => ({ id })),
      register: (language: { id: string }) => {
        registered.push(language.id)
      },
    },
    editor: { getModels: () => [] },
  }
  return { stub, registered }
}

describe('TextMateService.initialize', () => {
  it('registers grammar-only languages into monaco so models keep their language id', async () => {
    const service = makeService()
    service.registerGrammars(
      [
        {
          language: 'toml',
          scopeName: 'source.toml',
          path: './syntaxes/toml.tmLanguage.json',
        },
        { language: 'typescript', scopeName: 'source.ts', path: './syntaxes/ts.tmLanguage.json' },
      ],
      { extensionId: 'test', extensionLocation: '/ext', extensionIsBuiltin: true },
    )
    const { stub, registered } = makeMonacoStub(['typescript'])

    await service.initialize(stub)

    expect(registered).toEqual(['toml'])
    service.dispose()
  })

  it('does not re-register languages across grammar rebuilds', async () => {
    const service = makeService()
    const handle = service.registerGrammars(
      [{ language: 'toml', scopeName: 'source.toml', path: './syntaxes/toml.tmLanguage.json' }],
      { extensionId: 'test', extensionLocation: '/ext', extensionIsBuiltin: true },
    )
    const { stub, registered } = makeMonacoStub([])

    await service.initialize(stub)
    handle.dispose()

    expect(registered).toEqual(['toml'])
    service.dispose()
  })
})
