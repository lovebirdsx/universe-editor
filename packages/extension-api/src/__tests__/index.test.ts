/**
 * Contract / API-surface test for `@universe-editor/extension-api`.
 *
 * This is the executable counterpart of the compatibility policy (see
 * COMPATIBILITY.md): the public surface is the contract extensions program
 * against, so any change to it must be deliberate. The frozen lists below ARE
 * the snapshot — removing or renaming an export breaks a test, forcing the
 * author to update the snapshot and bump the version accordingly.
 *
 * Namespace methods are asserted to exist and be callable shapes only; we never
 * invoke them here because every call delegates to the host bridge, which throws
 * when no host is installed (outside the extension host).
 */
import { describe, expect, it } from 'vitest'
import * as api from '../index.js'

/** Every runtime (value) export of the package. Type-only exports don't appear
 *  at runtime, so they're covered indirectly via the namespace-method checks. */
const RUNTIME_EXPORTS = [
  'AiMessageRole',
  'CancellationTokenSource',
  'Disposable',
  'EventEmitter',
  'FileType',
  'FoldingRangeKind',
  'InlayHintKind',
  'OverviewRulerLane',
  'ProgressLocation',
  'RelativePattern',
  'StatusBarAlignment',
  'TextDocumentSaveReason',
  'TextEditorSelectionChangeKind',
  'TreeItem',
  'TreeItemCollapsibleState',
  'Uri',
  'ai',
  'commands',
  'env',
  'extensions',
  'languages',
  'scm',
  'version',
  'window',
  'workspace',
] as const

describe('extension-api surface', () => {
  it('exposes exactly the frozen set of runtime exports', () => {
    const actual = Object.keys(api).sort()
    expect(actual).toEqual([...RUNTIME_EXPORTS])
  })

  it('version is a semver string', () => {
    expect(api.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })
})

/** A namespace and the methods it must expose. Adding a method here without
 *  shipping it (or vice versa) fails the test. */
const NAMESPACE_METHODS: Record<string, readonly string[]> = {
  commands: ['registerCommand', 'executeCommand', 'getCommands'],
  env: ['openExternal'],
  extensions: ['getExtension'],
  window: [
    'showInformationMessage',
    'showWarningMessage',
    'showErrorMessage',
    'showQuickPick',
    'showInputBox',
    'createStatusBarItem',
    'createOutputChannel',
    'setStatusBarMessage',
    'withProgress',
    'showOpenDialog',
    'showSaveDialog',
    'getActiveTextEditor',
    'onDidChangeActiveTextEditor',
    'onDidChangeVisibleTextEditors',
    'showTextDocument',
    'onDidChangeTextEditorSelection',
    'createTextEditorDecorationType',
    'registerCustomEditorProvider',
    'createWebviewPanel',
    'registerTreeDataProvider',
    'createTreeView',
  ],
  scm: ['createSourceControl'],
  ai: [
    'getModels',
    'selectModels',
    'computeTokenLength',
    'getActiveModelId',
    'getCommitModelId',
    'sendRequest',
  ],
  languages: [
    'registerDefinitionProvider',
    'registerReferenceProvider',
    'registerImplementationProvider',
    'registerTypeDefinitionProvider',
    'registerHoverProvider',
    'registerCompletionItemProvider',
    'registerSignatureHelpProvider',
    'registerDocumentSymbolProvider',
    'registerRenameProvider',
    'registerWorkspaceSymbolProvider',
    'registerFoldingRangeProvider',
    'registerCodeActionsProvider',
    'registerDocumentFormattingEditProvider',
    'registerDocumentRangeFormattingEditProvider',
    'registerOnTypeFormattingEditProvider',
    'registerInlayHintsProvider',
    'registerCodeLensProvider',
    'createDiagnosticCollection',
    'setLanguageServerStatus',
    'getLanguages',
    'getDiagnostics',
    'onDidChangeDiagnostics',
  ],
  workspace: [
    'getConfiguration',
    'openTextDocument',
    'onDidOpenTextDocument',
    'onDidChangeTextDocument',
    'onDidCloseTextDocument',
    'onWillSaveTextDocument',
    'onDidSaveTextDocument',
    'onDidChangeConfiguration',
    'registerTimelineProvider',
    'asRelativePath',
    'findFiles',
    'applyEdit',
    'createFileSystemWatcher',
  ],
}

describe.each(Object.entries(NAMESPACE_METHODS))('%s namespace', (name, methods) => {
  const ns = (api as Record<string, unknown>)[name] as Record<string, unknown>

  it('is an object', () => {
    expect(typeof ns).toBe('object')
    expect(ns).not.toBeNull()
  })

  it.each(methods)('exposes %s as a function', (method) => {
    expect(typeof ns[method]).toBe('function')
  })
})

describe('env properties', () => {
  // Property presence is asserted via `in` (not a read): every getter delegates
  // to the host bridge, which throws when no host is installed.
  it.each(['appName', 'appVersion', 'language', 'sessionId', 'uriScheme', 'machineId', 'appRoot'])(
    'exposes %s as a property',
    (prop) => {
      expect(prop in api.env).toBe(true)
    },
  )
})

describe('env.clipboard', () => {
  it('is an object on env', () => {
    expect(typeof api.env.clipboard).toBe('object')
  })

  const CLIPBOARD_METHODS = ['readText', 'writeText'] as const

  it.each(CLIPBOARD_METHODS)('exposes %s as a function', (method) => {
    const clipboard = api.env.clipboard as unknown as Record<string, unknown>
    expect(typeof clipboard[method]).toBe('function')
  })
})

describe('workspace.fs', () => {
  it('is an object on workspace', () => {
    expect(typeof api.workspace.fs).toBe('object')
  })

  const FS_METHODS = [
    'readFile',
    'writeFile',
    'stat',
    'readDirectory',
    'createDirectory',
    'delete',
    'rename',
    'copy',
  ] as const

  it.each(FS_METHODS)('exposes %s as a function', (method) => {
    const fs = api.workspace.fs as unknown as Record<string, unknown>
    expect(typeof fs[method]).toBe('function')
  })
})

describe('window properties', () => {
  // Property presence is asserted via `in` (not a read): every getter delegates
  // to the host bridge, which throws when no host is installed.
  it.each(['visibleTextEditors'] as const)('exposes %s as a property', (prop) => {
    expect(prop in api.window).toBe(true)
  })
})

describe('workspace properties', () => {
  // Property presence is asserted via `in` (not a read): every getter delegates
  // to the host bridge, which throws when no host is installed.
  it.each(['rootPath', 'workspaceFolders', 'name', 'isTrusted'] as const)(
    'exposes %s as a property',
    (prop) => {
      expect(prop in api.workspace).toBe(true)
    },
  )
})

describe('workspace.getConfiguration', () => {
  it('returns an object with get and update functions', () => {
    const config = api.workspace.getConfiguration('test') as unknown as Record<string, unknown>
    expect(typeof config.get).toBe('function')
    expect(typeof config.update).toBe('function')
  })
})

describe('enums hold their wire values', () => {
  it('StatusBarAlignment', () => {
    expect({ ...api.StatusBarAlignment }).toEqual({
      '0': 'Left',
      '1': 'Right',
      Left: 0,
      Right: 1,
    })
  })

  it('FileType', () => {
    expect(api.FileType.File).toBe(1)
    expect(api.FileType.Directory).toBe(2)
  })

  it('AiMessageRole', () => {
    expect(api.AiMessageRole.System).toBe(0)
    expect(api.AiMessageRole.User).toBe(1)
    expect(api.AiMessageRole.Assistant).toBe(2)
  })

  it('OverviewRulerLane', () => {
    expect(api.OverviewRulerLane.Left).toBe(1)
    expect(api.OverviewRulerLane.Center).toBe(2)
    expect(api.OverviewRulerLane.Right).toBe(4)
    expect(api.OverviewRulerLane.Full).toBe(7)
  })

  it('ProgressLocation', () => {
    expect(api.ProgressLocation.SourceControl).toBe(1)
    expect(api.ProgressLocation.Window).toBe(10)
    expect(api.ProgressLocation.Notification).toBe(15)
  })

  it('TextEditorSelectionChangeKind', () => {
    expect(api.TextEditorSelectionChangeKind.Keyboard).toBe(1)
    expect(api.TextEditorSelectionChangeKind.Mouse).toBe(2)
    expect(api.TextEditorSelectionChangeKind.Command).toBe(3)
  })
})

describe('namespace methods delegate to the host bridge', () => {
  it('throw when used outside the extension host', () => {
    // No bridge installed on globalThis → any call must fail loudly rather than
    // silently no-op. Guards the bridge-resolution contract the whole API rests on.
    expect(() => api.commands.registerCommand('x', () => {})).toThrow(/extension host/)
  })
})

describe('languages.getDiagnostics / onDidChangeDiagnostics', () => {
  const BRIDGE_KEY = '__universeExtensionHostBridge__'

  function withBridge<T>(stub: Record<string, unknown>, run: () => T): T {
    const g = globalThis as Record<string, unknown>
    const prior = g[BRIDGE_KEY]
    g[BRIDGE_KEY] = stub
    try {
      return run()
    } finally {
      if (prior === undefined) delete g[BRIDGE_KEY]
      else g[BRIDGE_KEY] = prior
    }
  }

  const sampleEntries = (): Array<[ReturnType<api.Uri['toJSON']>, api.Diagnostic[]]> => [
    [
      api.Uri.file('/test/a.ts').toJSON(),
      [
        {
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
          message: 'boom',
          severity: 1,
        },
      ],
    ],
  ]

  it('getDiagnostics() forwards undefined and re-wraps result uris into Uri', async () => {
    const calls: unknown[] = []
    const result = await withBridge(
      {
        getDiagnostics: (uri: unknown) => {
          calls.push(uri)
          return Promise.resolve(sampleEntries())
        },
      },
      () => api.languages.getDiagnostics(),
    )
    expect(calls).toEqual([undefined])
    expect(result).toHaveLength(1)
    expect(result[0]![0]).toBeInstanceOf(api.Uri)
    expect(result[0]![0].path).toBe('/test/a.ts')
    expect(result[0]![1][0]!.message).toBe('boom')
    expect(result[0]![1][0]!.severity).toBe(1)
  })

  it('getDiagnostics(resource) serializes the uri to components', async () => {
    const calls: unknown[] = []
    await withBridge(
      {
        getDiagnostics: (uri: unknown) => {
          calls.push(uri)
          return Promise.resolve([])
        },
      },
      () => api.languages.getDiagnostics(api.Uri.file('/test/b.ts')),
    )
    expect(calls).toEqual([api.Uri.file('/test/b.ts').toJSON()])
  })

  it('onDidChangeDiagnostics re-wraps event uris into Uri', () => {
    let captured: ((e: { uris: Array<ReturnType<api.Uri['toJSON']>> }) => void) | undefined
    const seen: api.DiagnosticChangeEvent[] = []
    withBridge(
      {
        onDidChangeDiagnostics: (listener: typeof captured) => {
          captured = listener ?? undefined
          return { dispose: () => {} }
        },
      },
      () => api.languages.onDidChangeDiagnostics((e) => seen.push(e)),
    )

    captured!({ uris: [api.Uri.file('/test/a.ts').toJSON()] })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.uris[0]).toBeInstanceOf(api.Uri)
    expect(seen[0]!.uris[0]!.path).toBe('/test/a.ts')
  })
})
