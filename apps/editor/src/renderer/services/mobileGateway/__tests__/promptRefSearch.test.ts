/*---------------------------------------------------------------------------------------------
 *  Tests for the phone's `@` / `#` completion source. File listing + fuzzy
 *  filtering and the truncated-listing fallback are covered first, then the
 *  `#` provider merge (group ordering, session-scope filtering, docs exemption,
 *  provider failure isolation).
 *--------------------------------------------------------------------------------------------*/

import {
  normalizePlatform,
  observableValue,
  URI,
  UriIdentityService,
  type IFileSearchComplete,
  type IFileSearchQuery,
  type IFileSearchService,
} from '@universe-editor/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { initUserDocsForTests } from '../../editor/docRegistry.js'
import { setCurrentLocale } from '../../../../shared/i18n/availableLocales.js'
import { invalidateMentionFileCache } from '../../acp/mentionFileSearch.js'
import type { SessionScopeRoot } from '../../acp/sessionScope.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => Promise.resolve({}) },
}))
vi.mock('../../languageFeatures/typescript/lspMonacoConvert.js', () => ({
  workspaceSymbolsToEntries: (symbols: readonly unknown[] | null) => symbols ?? [],
}))

const { MobilePromptRefSearch } = await import('../promptRefSearch.js')

const IDENTITY = new UriIdentityService(normalizePlatform('linux'))

function completeBase(limitHit = false): {
  limitHit: boolean
  filesWalked: number
  directoriesWalked: number
  durationMs: number
} {
  return { limitHit, filesWalked: 0, directoriesWalked: 0, durationMs: 0 }
}

function makeFileSearch(options: {
  relPaths?: readonly string[]
  limitHit?: boolean
  fallbackRelPaths?: readonly string[]
  results?: readonly { resource: URI; relativePath: string; basename: string }[]
}): IFileSearchService & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn(async (query: IFileSearchQuery): Promise<IFileSearchComplete> => {
      if (query.matchAll) {
        return {
          relPaths:
            query.omitTruncatedListing === true
              ? (options.relPaths ?? [])
              : (options.fallbackRelPaths ?? []),
          ...completeBase(options.limitHit ?? false),
        }
      }
      return {
        results: (options.results ?? []).map((hit) => ({
          ...hit,
          fsPath: hit.resource.fsPath,
          score: 1,
        })),
        ...completeBase(),
      }
    }),
  } as unknown as IFileSearchService & { search: ReturnType<typeof vi.fn> }
}

function makeExclude(): {
  getDirNameIgnores: ReturnType<typeof vi.fn>
  getSearchExcludeGlobs: ReturnType<typeof vi.fn>
  getUseIgnoreFiles: ReturnType<typeof vi.fn>
} {
  return {
    getDirNameIgnores: vi.fn(() => ['node_modules']),
    getSearchExcludeGlobs: vi.fn(() => ['**/dist/**']),
    getUseIgnoreFiles: vi.fn(() => true),
  }
}

function makeSearch(options: {
  fileSearch: IFileSearchService
  scmSourceControls?: readonly unknown[]
  editorGroups?: readonly { editors: readonly unknown[] }[]
  symbolEntries?: readonly unknown[]
  docsRoot?: string
  docsFail?: boolean
  chatProviders?: readonly { handle: number; provider: unknown }[]
}): InstanceType<typeof MobilePromptRefSearch> {
  const workspace = { current: { folder: URI.file('/workspace'), name: 'workspace' } }
  const langFeatures = {
    getWorkspaceSymbolProviders: () => [
      { provideWorkspaceSymbols: async () => options.symbolEntries ?? [] },
    ],
  }
  const scm = { sourceControls: observableValue('test.scm', options.scmSourceControls ?? []) }
  const editorGroups = { groups: options.editorGroups ?? [] }
  const docs = {
    getDocs: async () => ({ user: {}, extensionDev: {} }),
    getDocsRoot: async () => {
      if (options.docsFail === true) throw new Error('docs unavailable')
      return options.docsRoot ?? '/docs/user'
    },
  }
  const chatContext = { getProviders: () => options.chatProviders ?? [] }
  return new MobilePromptRefSearch({
    fileSearch: options.fileSearch,
    exclude: makeExclude() as never,
    workspace: workspace as never,
    editorGroups: editorGroups as never,
    scm: scm as never,
    uriIdentity: IDENTITY,
    langFeatures: langFeatures as never,
    docs: docs as never,
    chatContext: chatContext as never,
  })
}

function scope(root = '/workspace', narrowed = false): SessionScopeRoot {
  return { root: URI.file(root), narrowed }
}

beforeEach(() => {
  invalidateMentionFileCache()
})

afterEach(() => {
  setCurrentLocale('en-US')
  initUserDocsForTests({ 'en-US': {}, 'zh-CN': {} })
})

describe('MobilePromptRefSearch @ files', () => {
  it('filters the workspace listing and maps entries to file suggestions', async () => {
    const fileSearch = makeFileSearch({
      relPaths: ['src/a.ts', 'src/b.ts', 'docs/readme.md'],
    })
    const search = makeSearch({ fileSearch })

    const entries = await search.search(scope(), '@', 'src', 10)

    expect(entries).toEqual([
      { kind: 'file', label: 'src/a.ts', uri: 'file:///workspace/src/a.ts' },
      { kind: 'file', label: 'src/b.ts', uri: 'file:///workspace/src/b.ts' },
    ])
    expect(fileSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({
        root: URI.file('/workspace'),
        matchAll: true,
        ignore: ['node_modules'],
        excludes: ['**/dist/**'],
        useIgnoreFiles: true,
      }),
      undefined,
    )
  })

  it('drops entries whose identity fields exceed the wire limits', async () => {
    const fileSearch = makeFileSearch({
      relPaths: [`${'a'.repeat(512)}.ts`, 'ok.ts'],
    })
    const search = makeSearch({ fileSearch })

    expect(await search.search(scope(), '@', '', 10)).toEqual([
      { kind: 'file', label: 'ok.ts', uri: 'file:///workspace/ok.ts' },
    ])
  })

  it('uses the scored fallback when the listing was truncated', async () => {
    const fileSearch = makeFileSearch({
      relPaths: [],
      limitHit: true,
      results: [
        { resource: URI.file('/workspace/deep/a.ts'), relativePath: 'deep/a.ts', basename: 'a.ts' },
      ],
    })
    const search = makeSearch({ fileSearch })

    const entries = await search.search(scope(), '@', 'a.ts', 5)

    expect(entries).toEqual([
      { kind: 'file', label: 'deep/a.ts', uri: 'file:///workspace/deep/a.ts' },
    ])
    expect(fileSearch.search).toHaveBeenCalledTimes(2)
    expect(fileSearch.search.mock.calls[1]?.[0]).toMatchObject({
      pattern: 'a.ts',
      maxResults: 5,
    })
  })

  it('falls back with matchAll when an empty query meets a truncated listing', async () => {
    const fileSearch = makeFileSearch({
      relPaths: [],
      limitHit: true,
      fallbackRelPaths: ['a.ts'],
    })
    const search = makeSearch({ fileSearch })

    expect(await search.search(scope(), '@', '', 5)).toEqual([
      { kind: 'file', label: 'a.ts', uri: 'file:///workspace/a.ts' },
    ])
    expect(fileSearch.search).toHaveBeenCalledTimes(2)
    expect(fileSearch.search.mock.calls[1]?.[0]).toMatchObject({ matchAll: true })
  })
})

describe('MobilePromptRefSearch # context', () => {
  beforeEach(() => {
    setCurrentLocale('zh-CN')
    initUserDocsForTests({ 'zh-CN': { index: '# 指南' }, 'en-US': {} })
  })

  function scmControl(resources: readonly string[]): unknown {
    return {
      rootUri: '/workspace',
      groups: observableValue('test.groups', [
        {
          resources: observableValue(
            'test.resources',
            resources.map((path) => ({ resourceUri: path, contextValue: 'M' })),
          ),
        },
      ]),
    }
  }

  function gitControl(resources: readonly string[] = []): unknown {
    return { id: 'git', ...(scmControl(resources) as Record<string, unknown>) }
  }

  function chatProvider(
    handle: number,
    over: Record<string, unknown> = {},
  ): { handle: number; provider: unknown } {
    return {
      handle,
      provider: {
        label: 'Perforce CL',
        description: 'Pick a changelist',
        keywords: ['cl', 'changelist'],
        iconId: 'git-commit',
        ...over,
      },
    }
  }

  it('merges provider groups fewest-first and maps every kind', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [scmControl(['/workspace/a.ts', '/workspace/b.ts'])],
      editorGroups: [],
      docsRoot: '/docs/user',
    })

    const entries = await search.search(scope(), '#', '', 20)

    expect(entries.map((entry) => entry.kind)).toEqual(['docs', 'scmChange', 'scmChange'])
    expect(entries[0]).toMatchObject({ kind: 'docs', dirPath: '/docs/user/zh-CN' })
    expect(entries[1]).toMatchObject({ kind: 'scmChange', label: 'a.ts', scmStatus: 'M' })
  })

  it('maps symbol line and column into the suggestion', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      symbolEntries: [
        {
          name: 'fn',
          kind: 11,
          containerName: '',
          uri: URI.file('/workspace/src/a.ts'),
          range: { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 9 },
        },
      ],
    })

    const entries = await search.search(scope(), '#', 'fn', 20)

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'symbol',
        label: 'fn',
        uri: 'file:///workspace/src/a.ts',
        line: 3,
        column: 2,
        symbolKind: 11,
      }),
    ])
  })

  it('narrows path-bearing groups to the session scope but never docs', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [scmControl(['/workspace/sub/a.ts', '/workspace/out.ts'])],
      editorGroups: [
        { editors: [new FileEditorInput(URI.file('/workspace/out.ts'), {} as never)] },
      ],
      docsRoot: '/docs/user',
    })

    const entries = await search.search(scope('/workspace/sub', true), '#', '', 20)

    expect(
      entries.filter((entry) => entry.kind === 'scmChange').map((entry) => entry.label),
    ).toEqual(['sub/a.ts'])
    expect(entries.some((entry) => entry.kind === 'openEditor')).toBe(false)
    expect(entries.some((entry) => entry.kind === 'docs')).toBe(true)
  })

  it('narrows symbols to the session scope', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      symbolEntries: [
        {
          name: 'inA',
          kind: 11,
          containerName: '',
          uri: URI.file('/workspace/sub/in.ts'),
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
        },
        {
          name: 'inB',
          kind: 11,
          containerName: '',
          uri: URI.file('/workspace/out.ts'),
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
        },
      ],
    })

    const entries = await search.search(scope('/workspace/sub', true), '#', 'in', 20)

    expect(entries.map((entry) => entry.label)).toEqual(['inA'])
  })

  it('drops only the failing provider group', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [scmControl(['/workspace/a.ts'])],
      docsRoot: '/docs/user',
      docsFail: true,
    })

    const entries = await search.search(scope(), '#', '', 20)

    expect(entries.map((entry) => entry.kind)).toEqual(['scmChange'])
  })

  it('surfaces git commit and extension chatContext entries with empty uris', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [gitControl()],
      chatProviders: [chatProvider(4)],
      docsRoot: '/docs/user',
    })

    const entries = await search.search(scope(), '#', '', 20)

    expect(entries.map((entry) => entry.kind)).toEqual(['docs', 'commit', 'chatContext'])
    expect(entries[1]).toMatchObject({ kind: 'commit', uri: '' })
    expect(entries[2]).toMatchObject({
      kind: 'chatContext',
      label: 'Perforce CL',
      uri: '',
      chatContextHandle: 4,
      description: 'Pick a changelist',
    })
  })

  it('hides the commit entry in a P4-only workspace but keeps extension entries', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [{ id: 'perforce', ...(scmControl([]) as Record<string, unknown>) }],
      chatProviders: [chatProvider(2)],
      docsRoot: '/docs/user',
    })

    const entries = await search.search(scope(), '#', '', 20)

    expect(entries.some((entry) => entry.kind === 'commit')).toBe(false)
    expect(entries.some((entry) => entry.kind === 'chatContext')).toBe(true)
  })

  it('hides the commit entry when the git control has no repository root', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [{ id: 'git' }],
      docsRoot: '/docs/user',
    })

    const entries = await search.search(scope(), '#', '', 20)

    expect(entries.some((entry) => entry.kind === 'commit')).toBe(false)
  })

  it('keeps commit and chatContext entries for narrowed sessions', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      scmSourceControls: [gitControl()],
      chatProviders: [chatProvider(1)],
      docsRoot: '/docs/user',
    })

    const entries = await search.search(scope('/workspace/sub', true), '#', '', 20)

    expect(entries.some((entry) => entry.kind === 'commit')).toBe(true)
    expect(entries.some((entry) => entry.kind === 'chatContext')).toBe(true)
  })

  it('drops extension entries without a valid chatContext handle', async () => {
    const search = makeSearch({
      fileSearch: makeFileSearch({}),
      chatProviders: [chatProvider(0)],
    })

    const entries = await search.search(scope(), '#', '', 20)

    expect(entries.some((entry) => entry.kind === 'chatContext')).toBe(false)
  })
})
