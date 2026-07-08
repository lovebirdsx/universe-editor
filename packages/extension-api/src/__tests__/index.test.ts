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
  'FileType',
  'FoldingRangeKind',
  'OverviewRulerLane',
  'StatusBarAlignment',
  'ai',
  'commands',
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
  commands: ['registerCommand', 'executeCommand'],
  window: [
    'showInformationMessage',
    'showWarningMessage',
    'showErrorMessage',
    'showQuickPick',
    'showInputBox',
    'createStatusBarItem',
    'createOutputChannel',
    'getActiveTextEditor',
    'onDidChangeActiveTextEditor',
    'createTextEditorDecorationType',
    'registerCustomEditorProvider',
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
    'createDiagnosticCollection',
  ],
  workspace: [
    'getConfiguration',
    'onDidOpenTextDocument',
    'onDidChangeTextDocument',
    'onDidCloseTextDocument',
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
  ] as const

  it.each(FS_METHODS)('exposes %s as a function', (method) => {
    const fs = api.workspace.fs as unknown as Record<string, unknown>
    expect(typeof fs[method]).toBe('function')
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
})

describe('namespace methods delegate to the host bridge', () => {
  it('throw when used outside the extension host', () => {
    // No bridge installed on globalThis → any call must fail loudly rather than
    // silently no-op. Guards the bridge-resolution contract the whole API rests on.
    expect(() => api.commands.registerCommand('x', () => {})).toThrow(/extension host/)
  })
})
