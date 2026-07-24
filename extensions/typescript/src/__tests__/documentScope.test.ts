/*---------------------------------------------------------------------------------------------
 *  Only real files may reach the TypeScript language server (VSCode parity: its
 *  documentSelector carries `scheme: 'file'`). Diff/peek views edit synthetic
 *  models on other schemes (diff-original/diff-modified) whose URIs the server
 *  can never resolve to a project — tsgo answers "no project found for URI
 *  diff-modified:/…" and the rejection surfaces as a renderer error.
 *
 *  These tests drive the plugin's registered providers / document-sync listeners
 *  with such a synthetic document and assert the client never sees it; the mock
 *  client's provide* methods reject with tsgo's exact error so the pre-fix shape
 *  fails the same way the production log did.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from 'vscode-uri'
import type { ExtensionContext, TextDocument } from '@universe-editor/extension-api'
import { activate, isServerBackedDocument } from '../extension.js'

/** Shared mock state (vi.mock factories are hoisted, so they can't close over locals). */
const h = vi.hoisted(() => ({
  client: undefined as unknown as {
    calls: Record<string, unknown[][]>
    record(name: string, args: unknown[]): Promise<null>
  },
  providers: {} as Record<string, Record<string, (...args: never[]) => unknown>>,
  openListeners: [] as Array<(doc: TextDocument) => void>,
  changeListeners: [] as Array<(e: { document: TextDocument }) => void>,
  closeListeners: [] as Array<(doc: TextDocument) => void>,
  preopenDocuments: [] as TextDocument[],
}))

vi.mock('../lspClient.js', () => ({
  LspClient: class MockLspClient {
    readonly spec = { kind: 'tsls', cli: 'cli', tsserver: 'tsserver', version: '1.0.0' }
    readonly state = 'ready'
    readonly onDidChangeState = () => ({ dispose() {} })
    readonly calls: Record<string, unknown[][]> = {}

    constructor() {
      h.client = this as never
    }

    /** Language requests on a project-less (synthetic-scheme) URI reject the way
     *  tsgo does; real file URIs resolve normally. */
    record(name: string, args: unknown[]): Promise<null> {
      ;(this.calls[name] ??= []).push(args)
      const uri = String(args[0])
      if (uri.startsWith('diff-')) {
        return Promise.reject(new Error(`no project found for URI ${uri}`))
      }
      return Promise.resolve(null)
    }

    onServerOOM() {}
    onCodeLensRefresh() {}
    dispose() {}
    ensureReady() {
      return Promise.resolve()
    }
    getSemanticTokensLegend() {
      return Promise.resolve({ tokenTypes: [], tokenModifiers: [] })
    }
    didOpen(...args: unknown[]) {
      ;(this.calls['didOpen'] ??= []).push(args)
      return Promise.resolve()
    }
    didChange(...args: unknown[]) {
      ;(this.calls['didChange'] ??= []).push(args)
      return Promise.resolve()
    }
    didClose(...args: unknown[]) {
      ;(this.calls['didClose'] ??= []).push(args)
      return Promise.resolve()
    }
    pinProject() {
      return Promise.resolve()
    }

    provideDefinition(...args: unknown[]) {
      return this.record('provideDefinition', args)
    }
    provideReferences(...args: unknown[]) {
      return this.record('provideReferences', args)
    }
    provideImplementation(...args: unknown[]) {
      return this.record('provideImplementation', args)
    }
    provideTypeDefinition(...args: unknown[]) {
      return this.record('provideTypeDefinition', args)
    }
    provideHover(...args: unknown[]) {
      return this.record('provideHover', args)
    }
    provideCompletion(...args: unknown[]) {
      return this.record('provideCompletion', args)
    }
    resolveCompletion(...args: unknown[]) {
      return this.record('resolveCompletion', args)
    }
    provideSignatureHelp(...args: unknown[]) {
      return this.record('provideSignatureHelp', args)
    }
    provideDocumentSymbols(...args: unknown[]) {
      return this.record('provideDocumentSymbols', args)
    }
    provideRenameEdits(...args: unknown[]) {
      return this.record('provideRenameEdits', args)
    }
    provideDocumentSemanticTokens(...args: unknown[]) {
      return this.record('provideDocumentSemanticTokens', args)
    }
    provideCodeLenses(...args: unknown[]) {
      return this.record('provideCodeLenses', args)
    }
    resolveCodeLens(...args: unknown[]) {
      return this.record('resolveCodeLens', args)
    }
    provideWorkspaceSymbols() {
      return Promise.resolve([])
    }
  },
}))

vi.mock('@universe-editor/extension-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@universe-editor/extension-api')>()
  const capture =
    (name: string) =>
    (_selector: unknown, provider: Record<string, (...args: never[]) => unknown>) => {
      h.providers[name] = provider
      return { dispose() {} }
    }
  return {
    ...actual,
    languages: {
      createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
      setLanguageServerStatus: () => {},
      registerDefinitionProvider: capture('definition'),
      registerReferenceProvider: capture('references'),
      registerImplementationProvider: capture('implementation'),
      registerTypeDefinitionProvider: capture('typeDefinition'),
      registerHoverProvider: capture('hover'),
      registerCompletionItemProvider: capture('completion'),
      registerSignatureHelpProvider: capture('signatureHelp'),
      registerDocumentSymbolProvider: capture('documentSymbol'),
      registerRenameProvider: capture('rename'),
      registerWorkspaceSymbolProvider: (provider: unknown) => {
        h.providers['workspaceSymbol'] = provider as never
        return { dispose() {} }
      },
      registerCodeLensProvider: capture('codeLens'),
      registerDocumentSemanticTokensProvider: capture('semanticTokens'),
    },
    window: {
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        showProgress: false,
        show() {},
        hide() {},
        dispose() {},
      }),
      showWarningMessage: () => Promise.resolve(undefined),
    },
    workspace: {
      rootPath: undefined, // prewarm bails out before touching the fs
      get textDocuments() {
        return h.preopenDocuments
      },
      onDidOpenTextDocument: (l: (doc: TextDocument) => void) => {
        h.openListeners.push(l)
        return { dispose() {} }
      },
      onDidChangeTextDocument: (l: (e: { document: TextDocument }) => void) => {
        h.changeListeners.push(l)
        return { dispose() {} }
      },
      onDidCloseTextDocument: (l: (doc: TextDocument) => void) => {
        h.closeListeners.push(l)
        return { dispose() {} }
      },
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      fs: {
        readDirectory: () => Promise.resolve([]),
        readFile: () => Promise.resolve(new Uint8Array()),
      },
    },
  }
})

/** The URI shape from the production log: a diff view over a Windows file keeps
 *  the original path and only swaps the scheme (see diffModelUri.ts). */
const DIFF_URI =
  'diff-modified:/d%3A/git_project/universe-editor.worktrees/task3/apps/editor/src/shared/deepLink.ts'
const FILE_URI =
  'file:///d%3A/git_project/universe-editor.worktrees/task3/apps/editor/src/shared/deepLink.ts'

function makeDoc(uri: string, languageId = 'typescript'): TextDocument {
  return {
    uri: URI.parse(uri),
    languageId,
    version: 1,
    getText: () => 'export const a = 1\n',
  } as TextDocument
}

const POSITION = { line: 0, character: 10 }

function activatePlugin(): void {
  const context = { subscriptions: [] as Array<{ dispose(): void }> }
  activate(context as unknown as ExtensionContext)
}

beforeEach(() => {
  process.env.UNIVERSE_TSLS_CLI = 'cli.js'
  process.env.UNIVERSE_TSLS_TSSERVER = 'tsserver.js'
  h.providers = {}
  h.openListeners = []
  h.changeListeners = []
  h.closeListeners = []
  h.preopenDocuments = []
})

describe('isServerBackedDocument', () => {
  it('accepts real TS/JS files only', () => {
    expect(isServerBackedDocument(makeDoc(FILE_URI))).toBe(true)
    expect(isServerBackedDocument(makeDoc(FILE_URI, 'typescriptreact'))).toBe(true)
    expect(isServerBackedDocument(makeDoc(DIFF_URI))).toBe(false)
    expect(isServerBackedDocument(makeDoc('diff-original:/d%3A/w/a.ts'))).toBe(false)
    expect(isServerBackedDocument(makeDoc(FILE_URI, 'markdown'))).toBe(false)
  })
})

describe('document sync gates non-file schemes', () => {
  it('opens real files but never diff-view models', () => {
    activatePlugin()
    for (const l of h.openListeners) l(makeDoc(DIFF_URI))
    expect(h.client.calls['didOpen']).toBeUndefined()

    for (const l of h.openListeners) l(makeDoc(FILE_URI))
    expect(h.client.calls['didOpen']).toHaveLength(1)
    expect(h.client.calls['didOpen']?.[0]?.[0]).toBe(FILE_URI)
  })

  it('ignores documents already open at activation when they are synthetic', () => {
    h.preopenDocuments = [makeDoc(DIFF_URI), makeDoc(FILE_URI)]
    activatePlugin()
    expect(h.client.calls['didOpen']).toHaveLength(1)
    expect(h.client.calls['didOpen']?.[0]?.[0]).toBe(FILE_URI)
  })

  it('gates change and close events for synthetic documents', () => {
    activatePlugin()
    for (const l of h.changeListeners) l({ document: makeDoc(DIFF_URI) })
    for (const l of h.closeListeners) l(makeDoc(DIFF_URI))
    expect(h.client.calls['didChange']).toBeUndefined()
    expect(h.client.calls['didClose']).toBeUndefined()
  })
})

describe('language providers gate non-file schemes', () => {
  it('hover on a diff-view model resolves null without hitting the server', async () => {
    activatePlugin()
    const hover = h.providers['hover']?.['provideHover']
    expect(hover).toBeDefined()
    await expect(
      Promise.resolve(hover?.(makeDoc(DIFF_URI) as never, POSITION as never)),
    ).resolves.toBeNull()
    expect(h.client.calls['provideHover']).toBeUndefined()

    await hover?.(makeDoc(FILE_URI) as never, POSITION as never)
    expect(h.client.calls['provideHover']).toHaveLength(1)
    expect(h.client.calls['provideHover']?.[0]?.[0]).toBe(FILE_URI)
  })

  it.each([
    ['definition', 'provideDefinition', (doc: TextDocument) => [doc, POSITION]],
    [
      'references',
      'provideReferences',
      (doc: TextDocument) => [doc, POSITION, { includeDeclaration: true }],
    ],
    ['implementation', 'provideImplementation', (doc: TextDocument) => [doc, POSITION]],
    ['typeDefinition', 'provideTypeDefinition', (doc: TextDocument) => [doc, POSITION]],
    [
      'completion',
      'provideCompletionItems',
      (doc: TextDocument) => [doc, POSITION, { triggerKind: 1 }],
    ],
    [
      'signatureHelp',
      'provideSignatureHelp',
      (doc: TextDocument) => [doc, POSITION, { triggerKind: 1, isRetrigger: false }],
    ],
    ['documentSymbol', 'provideDocumentSymbols', (doc: TextDocument) => [doc]],
    ['rename', 'provideRenameEdits', (doc: TextDocument) => [doc, POSITION, 'renamed']],
    ['codeLens', 'provideCodeLenses', (doc: TextDocument) => [doc]],
  ])('%s never forwards a synthetic document', async (registration, method, args) => {
    activatePlugin()
    const provide = h.providers[registration]?.[method]
    expect(provide).toBeDefined()
    await expect(
      Promise.resolve(provide?.(...(args(makeDoc(DIFF_URI)) as never[]))),
    ).resolves.toBeNull()
  })

  it('semantic tokens on a diff-view model resolve null without hitting the server', async () => {
    activatePlugin()
    // Registered asynchronously once the legend arrives (see registerProviders).
    await vi.waitFor(() => expect(h.providers['semanticTokens']).toBeDefined())
    const provide = h.providers['semanticTokens']?.['provideDocumentSemanticTokens']
    await expect(Promise.resolve(provide?.(makeDoc(DIFF_URI) as never))).resolves.toBeNull()
    expect(h.client.calls['provideDocumentSemanticTokens']).toBeUndefined()
  })
})
