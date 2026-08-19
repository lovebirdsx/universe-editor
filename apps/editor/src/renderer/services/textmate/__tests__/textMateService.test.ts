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

import { URI, type IFileService } from '@universe-editor/platform'
import { TokenizationRegistry } from 'monaco-editor/esm/vs/editor/common/languages.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { languageRegistry } from '../../languages/LanguageRegistry.js'
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

function makeMonacoStub(knownLanguages: readonly string[], modelLanguages: readonly string[] = []) {
  const registered: string[] = []
  const configured: Array<{ id: string; config: unknown }> = []
  const modelListeners: Array<(model: { getLanguageId(): string }) => void> = []
  const stub = {
    languages: {
      getEncodedLanguageId: () => 1,
      getLanguages: () => knownLanguages.map((id) => ({ id })),
      register: (language: { id: string }) => {
        registered.push(language.id)
      },
      setLanguageConfiguration: (id: string, config: unknown) => {
        configured.push({ id, config })
      },
    },
    editor: {
      getModels: () => modelLanguages.map((id) => ({ getLanguageId: () => id })),
      onDidCreateModel: (listener: (model: { getLanguageId(): string }) => void) => {
        modelListeners.push(listener)
        return { dispose: () => {} }
      },
      onDidChangeModelLanguage: () => ({ dispose: () => {} }),
    },
  }
  const createModel = (languageId: string): void => {
    for (const listener of modelListeners) {
      listener({ getLanguageId: () => languageId })
    }
  }
  return { stub, registered, configured, createModel }
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
      { extensionId: 'test', extensionLocation: URI.file('/ext'), extensionIsBuiltin: true },
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
      { extensionId: 'test', extensionLocation: URI.file('/ext'), extensionIsBuiltin: true },
    )
    const { stub, registered } = makeMonacoStub([])

    await service.initialize(stub)
    handle.dispose()

    expect(registered).toEqual(['toml'])
    service.dispose()
  })
})

describe('TextMateService.registerLanguages', () => {
  afterEach(() => {
    languageRegistry._resetForTests()
  })

  it('registers contributed language ids into monaco so models keep their language', async () => {
    const service = makeService()
    service.registerLanguages([{ id: 'csv', aliases: ['CSV'], extensions: ['.csv'] }], {
      extensionId: 'test',
      extensionLocation: URI.file('/ext'),
      extensionIsBuiltin: true,
    })
    const { stub, registered } = makeMonacoStub([])

    await service.initialize(stub)

    expect(registered).toContain('csv')
    service.dispose()
  })

  it('maps vscode language ids onto monaco ids (jsonc → json)', async () => {
    const service = makeService()
    service.registerLanguages([{ id: 'jsonc', extensions: ['.jsonc'] }], {
      extensionId: 'test',
      extensionLocation: URI.file('/ext'),
      extensionIsBuiltin: true,
    })
    const { stub, registered } = makeMonacoStub(['json'])

    await service.initialize(stub)

    expect(registered).not.toContain('jsonc')
    expect(registered).not.toContain('json')
    service.dispose()
  })

  it('applies a contributed language-configuration.json', async () => {
    const readFileText = vi.fn(() =>
      Promise.resolve(JSON.stringify({ comments: { lineComment: '--' }, brackets: [['[', ']']] })),
    )
    const service = new TextMateService(
      { readFileText } as unknown as IFileService,
      undefined as never,
    )
    service.registerLanguages([{ id: 'csv', configuration: './language-configuration.json' }], {
      extensionId: 'test',
      extensionLocation: URI.file('/ext'),
      extensionIsBuiltin: true,
    })
    const { stub, configured } = makeMonacoStub([])

    await service.initialize(stub)
    await vi.waitFor(() => expect(configured).toHaveLength(1))

    expect(configured[0]!.id).toBe('csv')
    expect(configured[0]!.config).toMatchObject({ comments: { lineComment: '--' } })
    expect(readFileText).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/ext/language-configuration.json' }),
    )
    service.dispose()
  })
})

const TS_GRAMMAR = {
  language: 'typescript',
  scopeName: 'source.ts',
  path: './syntaxes/ts.tmLanguage.json',
}
const EXT_CONTEXT = {
  extensionId: 'test',
  extensionLocation: URI.file('/ext'),
  extensionIsBuiltin: true,
}

describe('TextMateService live-model recovery', () => {
  // Guards the e2e-visible race: a model created after initialize() may lose
  // its pending Monarch resolve when our registerFactory replaces the factory
  // mid-flight — no registry event ever fires for it, so only an explicit
  // warm-up over *live models at rebuild time* re-resolves tokenization.
  it('warms up live-model languages when grammars register after initialize', async () => {
    const service = makeService()
    const { stub } = makeMonacoStub(['typescript'], ['typescript'])
    await service.initialize(stub)

    const getOrCreate = vi.spyOn(TokenizationRegistry, 'getOrCreate')
    service.registerGrammars([TS_GRAMMAR], EXT_CONTEXT)

    expect(getOrCreate).toHaveBeenCalledWith('typescript')
    getOrCreate.mockRestore()
    service.dispose()
  })

  // The opposite direction: monaco's requestRichLanguageFeatures resolves
  // tokenization only once per language id, so a model created after our
  // factory replaced the registration (and after the rebuild-time warm-up saw
  // no live model) would never trigger a resolve on its own.
  it('warms up when a model is created after the grammar registered', async () => {
    const service = makeService()
    service.registerGrammars([TS_GRAMMAR], EXT_CONTEXT)
    const { stub, createModel } = makeMonacoStub(['typescript'])
    await service.initialize(stub)

    const getOrCreate = vi.spyOn(TokenizationRegistry, 'getOrCreate')
    createModel('typescript')
    expect(getOrCreate).toHaveBeenCalledWith('typescript')

    getOrCreate.mockClear()
    createModel('plaintext')
    expect(getOrCreate).not.toHaveBeenCalled()

    getOrCreate.mockRestore()
    service.dispose()
  })

  // Token metadata stores indices into the theme's color table at
  // tokenization time; a later theme change must re-tokenize live models or
  // they keep stale (mis-colored or merged) spans forever.
  it('re-tokenizes live models on theme change', async () => {
    const service = makeService()
    service.registerGrammars([TS_GRAMMAR], EXT_CONTEXT)
    const { stub } = makeMonacoStub(['typescript'], ['typescript'])
    await service.initialize(stub)

    const handleChange = vi.spyOn(TokenizationRegistry, 'handleChange')
    service.setTheme(
      { name: 'test', settings: [{ settings: { foreground: '#FFFFFF', background: '#000000' } }] },
      ['', '#FFFFFF', '#000000'],
    )

    expect(handleChange).toHaveBeenCalledWith(['typescript'])
    handleChange.mockRestore()
    service.dispose()
  })

  it('does not fire tokenization changes for languages without grammars', async () => {
    const service = makeService()
    service.registerGrammars([TS_GRAMMAR], EXT_CONTEXT)
    const { stub } = makeMonacoStub(['typescript'], ['plaintext'])
    await service.initialize(stub)

    const handleChange = vi.spyOn(TokenizationRegistry, 'handleChange')
    service.setTheme(
      { name: 'test', settings: [{ settings: { foreground: '#FFFFFF', background: '#000000' } }] },
      ['', '#FFFFFF', '#000000'],
    )

    expect(handleChange).not.toHaveBeenCalled()
    handleChange.mockRestore()
    service.dispose()
  })
})

describe('TextMateService remote grammar read routing', () => {
  it('passes the remote-ssh grammar URI through IFileService untouched', async () => {
    const readFileText = vi.fn((_resource: URI) => Promise.resolve('{}'))
    const service = new TextMateService(
      { readFileText } as unknown as IFileService,
      undefined as never,
    )
    service.registerGrammars(
      [{ language: 'toml', scopeName: 'source.toml', path: './syntaxes/toml.tmLanguage.json' }],
      {
        extensionId: 'test',
        extensionLocation: URI.parse('remote-ssh://wsl+Ubuntu/home/xiao/ext'),
        extensionIsBuiltin: true,
      },
    )
    const { stub } = makeMonacoStub(['typescript'], ['toml'])
    await service.initialize(stub)

    await vi.waitFor(() => expect(readFileText).toHaveBeenCalled())
    const received = readFileText.mock.calls[0]![0]
    expect(received.scheme).toBe('remote-ssh')
    expect(received.path).toBe('/home/xiao/ext/syntaxes/toml.tmLanguage.json')
    service.dispose()
  })
})
