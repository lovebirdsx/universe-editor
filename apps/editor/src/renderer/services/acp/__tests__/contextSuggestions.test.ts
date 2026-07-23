/*---------------------------------------------------------------------------------------------
 *  Tests for the #-context data sources:
 *  - WorkspaceSymbolContextProvider: empty-query no-op, fuzzy ranking,
 *    ContextSuggestionItem normalization.
 *  - ScmChangeContextProvider: multi-group dedup + status-letter normalization.
 *  - OpenEditorContextProvider: cross-group FileEditorInput enumeration + dedup.
 *  workspaceSymbolsToEntries has its own tests (lspMonacoConvert.test.ts), so it's
 *  mocked here as identity to isolate the provider's own orchestration logic.
 *--------------------------------------------------------------------------------------------*/

import type { ISourceControlResourceStateDto } from '@universe-editor/extensions-common'
import { URI } from '@universe-editor/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { initDocRegistry } from '../../editor/docRegistry.js'
import { setCurrentLocale } from '../../../../shared/i18n/availableLocales.js'
import { resourceIconId } from '../../quickInput/quickPickResourceIcon.js'
import type { WorkspaceSymbolEntry } from '../../languageFeatures/typescript/lspMonacoConvert.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => Promise.resolve({}) },
}))
vi.mock('../../languageFeatures/typescript/lspMonacoConvert.js', () => ({
  workspaceSymbolsToEntries: (symbols: readonly WorkspaceSymbolEntry[] | null) => symbols ?? [],
}))

const {
  WorkspaceSymbolContextProvider,
  ScmChangeContextProvider,
  OpenEditorContextProvider,
  DocsContextProvider,
  CommitContextProvider,
} = await import('../contextSuggestions.js')

function fileEditor(uri: string): FileEditorInput {
  return new FileEditorInput(URI.file(uri), {} as never)
}

function entry(name: string, uri: string, line = 1): WorkspaceSymbolEntry {
  return {
    name,
    kind: 11, // Function
    containerName: '',
    uri: uri as unknown as WorkspaceSymbolEntry['uri'],
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
  }
}

function entryOfKind(name: string, uri: string, kind: number): WorkspaceSymbolEntry {
  return {
    name,
    kind,
    containerName: '',
    uri: uri as unknown as WorkspaceSymbolEntry['uri'],
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  }
}

function makeProvider(provideWorkspaceSymbols: (query: string) => Promise<WorkspaceSymbolEntry[]>) {
  const langFeatures = { getWorkspaceSymbolProviders: () => [{ provideWorkspaceSymbols }] }
  const workspace = { current: { folder: URI.file('/workspace') } }
  const uriIdentity = {
    relativePathUnder: (root: string, child: string) =>
      child.startsWith(root) ? child.slice(root.length + 1) : null,
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  }
  return new WorkspaceSymbolContextProvider(
    langFeatures as never,
    workspace as never,
    uriIdentity as never,
  )
}

describe('WorkspaceSymbolContextProvider', () => {
  it('normalizes entries into ContextSuggestionItem with relPath:line description', async () => {
    const provider = makeProvider(async () => [entry('foo', 'file:///workspace/src/foo.ts', 42)])
    const items = await provider.query('foo')
    expect(items).toEqual([
      {
        kind: 'symbol',
        label: 'foo',
        uri: 'file:///workspace/src/foo.ts',
        description: 'src/foo.ts:42',
        iconId: 'symbol-kind-11',
        meta: { line: 42, column: 1, symbolKind: 11 },
      },
    ])
  })

  it('returns nothing for an empty query without calling the providers', async () => {
    const fetchSpy = vi.fn<(query: string) => Promise<WorkspaceSymbolEntry[]>>()
    const provider = makeProvider(fetchSpy)
    expect(await provider.query('')).toEqual([])
    expect(await provider.query('   ')).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ranks a non-empty query by fuzzy score', async () => {
    const provider = makeProvider(async () => [
      entry('barFoo', 'file:///workspace/b.ts'),
      entry('foo', 'file:///workspace/f.ts'),
    ])
    const items = await provider.query('foo')
    // Exact-prefix match ('foo') scores higher than a substring match ('barFoo').
    expect(items.map((i) => i.label)).toEqual(['foo', 'barFoo'])
  })

  it('drops entries that do not fuzzy-match the query', async () => {
    const provider = makeProvider(async () => [entry('foo', 'file:///workspace/f.ts')])
    const items = await provider.query('zzz')
    expect(items).toEqual([])
  })

  it('drops fine-grained symbol kinds (variables/constants/fields/properties), keeping navigable ones', async () => {
    const provider = makeProvider(async () => [
      entryOfKind('MyClass', 'file:///workspace/a.ts', 4), // Class → kept
      entryOfKind('myFn', 'file:///workspace/a.ts', 11), // Function → kept
      entryOfKind('localVar', 'file:///workspace/a.ts', 12), // Variable → dropped
      entryOfKind('MY_CONST', 'file:///workspace/a.ts', 13), // Constant → dropped
      entryOfKind('field', 'file:///workspace/a.ts', 7), // Field → dropped
      entryOfKind('prop', 'file:///workspace/a.ts', 6), // Property → dropped
    ])
    const items = await provider.query('my')
    expect(items.map((i) => i.label).sort()).toEqual(['MyClass', 'myFn'])
  })

  it('keeps short markdown headings but ignores overly long ones', async () => {
    const longHeading = 'x'.repeat(61)
    const provider = makeProvider(async () => [
      entryOfKind('Getting Started', 'file:///workspace/guide.md', 14), // md heading → kept
      entryOfKind(longHeading, 'file:///workspace/guide.md', 14), // too long → dropped
      entryOfKind('someString', 'file:///workspace/a.ts', 14), // String in non-md → dropped
    ])
    const items = await provider.query('get')
    expect(items.map((i) => i.label)).toEqual(['Getting Started'])
  })
})

function scmResource(resourceUri: string, contextValue?: string): ISourceControlResourceStateDto {
  return { resourceUri, ...(contextValue !== undefined ? { contextValue } : {}) }
}

function scmGroup(resources: readonly ISourceControlResourceStateDto[]) {
  return { resources: { get: () => resources } }
}

function makeScmProvider(
  sourceControls: readonly {
    rootUri: string | undefined
    groups: readonly ReturnType<typeof scmGroup>[]
  }[],
) {
  const scm = {
    sourceControls: {
      get: () =>
        sourceControls.map((sc) => ({ rootUri: sc.rootUri, groups: { get: () => sc.groups } })),
    },
  }
  const uriIdentity = {
    relativePathUnder: (root: string, child: string) =>
      child.startsWith(root) ? child.slice(root.length + 1) : null,
  }
  return new ScmChangeContextProvider(scm as never, uriIdentity as never)
}

describe('ScmChangeContextProvider', () => {
  it('normalizes a resource into ContextSuggestionItem with relPath label and status-letter description', async () => {
    const provider = makeScmProvider([
      { rootUri: '/workspace', groups: [scmGroup([scmResource('/workspace/src/a.ts', 'M')])] },
    ])
    const items = await provider.query('')
    expect(items).toEqual([
      {
        kind: 'scmChange',
        label: 'src/a.ts',
        uri: URI.file('/workspace/src/a.ts').toString(),
        description: 'M',
        iconId: resourceIconId(URI.file('/workspace/src/a.ts')),
        meta: { scmStatus: 'M' },
      },
    ])
  })

  it('maps untracked ("?") to the "U" badge letter, matching ScmDecorationsService', async () => {
    const provider = makeScmProvider([
      { rootUri: '/workspace', groups: [scmGroup([scmResource('/workspace/new.ts', '?')])] },
    ])
    const items = await provider.query('')
    expect(items.map((i) => i.description)).toEqual(['U'])
  })

  it('defaults to "M" when a resource omits contextValue', async () => {
    const provider = makeScmProvider([
      { rootUri: '/workspace', groups: [scmGroup([scmResource('/workspace/a.ts')])] },
    ])
    const items = await provider.query('')
    expect(items.map((i) => i.description)).toEqual(['M'])
  })

  it('dedups the same path across groups, keeping the later group (working tree over staged)', async () => {
    const provider = makeScmProvider([
      {
        rootUri: '/workspace',
        groups: [
          scmGroup([scmResource('/workspace/a.ts', 'A')]), // staged
          scmGroup([scmResource('/workspace/a.ts', 'M')]), // working tree
        ],
      },
    ])
    const items = await provider.query('')
    expect(items).toHaveLength(1)
    expect(items[0]?.description).toBe('M')
  })

  it('folds resources from multiple source controls (multi-repo/submodule) into one list', async () => {
    const provider = makeScmProvider([
      { rootUri: '/workspace', groups: [scmGroup([scmResource('/workspace/a.ts', 'M')])] },
      {
        rootUri: '/workspace/sub',
        groups: [scmGroup([scmResource('/workspace/sub/b.ts', 'A')])],
      },
    ])
    const items = await provider.query('')
    expect(items.map((i) => i.label).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('sorts an empty query alphabetically by label', async () => {
    const provider = makeScmProvider([
      {
        rootUri: '/workspace',
        groups: [
          scmGroup([
            scmResource('/workspace/zeta.ts', 'M'),
            scmResource('/workspace/alpha.ts', 'M'),
          ]),
        ],
      },
    ])
    const items = await provider.query('')
    expect(items.map((i) => i.label)).toEqual(['alpha.ts', 'zeta.ts'])
  })

  it('ranks a non-empty query by fuzzy score and drops non-matches', async () => {
    const provider = makeScmProvider([
      {
        rootUri: '/workspace',
        groups: [
          scmGroup([
            scmResource('/workspace/barFoo.ts', 'M'),
            scmResource('/workspace/foo.ts', 'M'),
            scmResource('/workspace/unrelated.ts', 'M'),
          ]),
        ],
      },
    ])
    const items = await provider.query('foo')
    expect(items.map((i) => i.label)).toEqual(['foo.ts', 'barFoo.ts'])
  })
})

function makeOpenEditorProvider(groups: readonly { editors: readonly unknown[] }[]) {
  const editorGroups = { groups }
  const workspace = { current: { folder: URI.file('/workspace') } }
  const uriIdentity = {
    relativePathUnder: (root: string, child: string) =>
      child.startsWith(root) ? child.slice(root.length + 1) : null,
    getComparisonKey: (uri: URI) => uri.toString(),
  }
  return new OpenEditorContextProvider(
    editorGroups as never,
    workspace as never,
    uriIdentity as never,
  )
}

describe('OpenEditorContextProvider', () => {
  it('normalizes a FileEditorInput into ContextSuggestionItem with relPath label', async () => {
    const provider = makeOpenEditorProvider([{ editors: [fileEditor('/workspace/src/a.ts')] }])
    const items = await provider.query('')
    expect(items).toEqual([
      {
        kind: 'openEditor',
        label: 'src/a.ts',
        uri: URI.file('/workspace/src/a.ts').toString(),
        description: 'src/a.ts',
        iconId: `resource:${URI.file('/workspace/src/a.ts').toString()}`,
      },
    ])
  })

  it('ignores non-FileEditorInput editors', async () => {
    const provider = makeOpenEditorProvider([{ editors: [{ resource: URI.file('/x.ts') }] }])
    const items = await provider.query('')
    expect(items).toEqual([])
  })

  it('dedups the same resource opened in multiple groups', async () => {
    const provider = makeOpenEditorProvider([
      { editors: [fileEditor('/workspace/a.ts')] },
      { editors: [fileEditor('/workspace/a.ts')] },
    ])
    const items = await provider.query('')
    expect(items).toHaveLength(1)
  })

  it('folds editors from every group into one list', async () => {
    const provider = makeOpenEditorProvider([
      { editors: [fileEditor('/workspace/a.ts')] },
      { editors: [fileEditor('/workspace/b.ts')] },
    ])
    const items = await provider.query('')
    expect(items.map((i) => i.label).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('sorts an empty query alphabetically by label', async () => {
    const provider = makeOpenEditorProvider([
      { editors: [fileEditor('/workspace/zeta.ts'), fileEditor('/workspace/alpha.ts')] },
    ])
    const items = await provider.query('')
    expect(items.map((i) => i.label)).toEqual(['alpha.ts', 'zeta.ts'])
  })

  it('ranks a non-empty query by fuzzy score and drops non-matches', async () => {
    const provider = makeOpenEditorProvider([
      {
        editors: [
          fileEditor('/workspace/barFoo.ts'),
          fileEditor('/workspace/foo.ts'),
          fileEditor('/workspace/unrelated.ts'),
        ],
      },
    ])
    const items = await provider.query('foo')
    expect(items.map((i) => i.label)).toEqual(['foo.ts', 'barFoo.ts'])
  })
})

function makeDocsProvider(root: string) {
  const docs = { getDocsRoot: async () => root }
  return new DocsContextProvider(docs as never)
}

describe('DocsContextProvider', () => {
  afterEach(() => initDocRegistry({ 'zh-CN': {}, 'en-US': {} }))

  it('points at the current locale subdirectory when it has docs', async () => {
    setCurrentLocale('en-US')
    initDocRegistry({ 'en-US': { index: '# Guide' }, 'zh-CN': { index: '# 指南' } })
    const provider = makeDocsProvider('/repo/docs/user')
    const items = await provider.query('')
    const expected = URI.joinPath(URI.file('/repo/docs/user'), 'en-US')
    expect(items[0]).toMatchObject({ kind: 'docs', uri: expected.toString(), iconId: 'docs' })
    expect(items[0]?.description).toContain(expected.fsPath)
  })

  it('falls back to the translated locale when the active locale has no docs', async () => {
    setCurrentLocale('en-US')
    // Only zh-CN is translated (mirrors the current repo state): an English UI
    // must still be pointed at docs/user/zh-CN, not docs/user/en-US.
    initDocRegistry({ 'en-US': {}, 'zh-CN': { index: '# 指南' } })
    const provider = makeDocsProvider('/repo/docs/user')
    const items = await provider.query('')
    const expected = URI.joinPath(URI.file('/repo/docs/user'), 'zh-CN')
    expect(items[0]?.uri).toBe(expected.toString())
    expect(items[0]?.description).toContain(expected.fsPath)
  })

  it('returns a single entry pointing at the docs locale dir for an empty query', async () => {
    setCurrentLocale('zh-CN')
    initDocRegistry({ 'zh-CN': { index: '# 指南' }, 'en-US': {} })
    const provider = makeDocsProvider('/repo/docs/user')
    const items = await provider.query('')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'docs', iconId: 'docs' })
  })

  it('matches docs/help-related keywords', async () => {
    const provider = makeDocsProvider('/repo/docs/user')
    for (const query of ['doc', 'docs', '文档', '帮助', '使用', '编辑器']) {
      expect(await provider.query(query)).toHaveLength(1)
    }
  })

  it('returns [] for an unrelated query', async () => {
    const provider = makeDocsProvider('/repo/docs/user')
    expect(await provider.query('zzz')).toEqual([])
  })
})

function makeCommitProvider(sourceControls: readonly { rootUri: string | undefined }[]) {
  const scm = { sourceControls: { get: () => sourceControls } }
  return new CommitContextProvider(scm as never)
}

describe('CommitContextProvider', () => {
  it('returns [] when there is no source control (no git repo open)', async () => {
    const provider = makeCommitProvider([])
    expect(await provider.query('')).toEqual([])
  })

  it('returns a single picker-entry item for an empty query', async () => {
    const provider = makeCommitProvider([{ rootUri: '/workspace' }])
    const items = await provider.query('')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'commit', iconId: 'git-commit' })
  })

  it('matches commit/history-related keywords', async () => {
    const provider = makeCommitProvider([{ rootUri: '/workspace' }])
    for (const query of ['commit', 'commits', 'git log', '提交', '历史']) {
      expect(await provider.query(query)).toHaveLength(1)
    }
  })

  it('returns [] for an unrelated query', async () => {
    const provider = makeCommitProvider([{ rootUri: '/workspace' }])
    expect(await provider.query('zzz')).toEqual([])
  })
})
