import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CancellationError, URI } from '@universe-editor/platform'
import {
  CancellationTokenSource as ApiCancellationTokenSource,
  RelativePattern,
  Uri,
} from '@universe-editor/extension-api'
import type {
  TextEditor,
  TextEditorSelectionChangeEvent,
  UriComponents,
} from '@universe-editor/extension-api'
import type {
  IActiveTextEditorDto,
  IMainThreadEditor,
  IMainThreadCommands,
  IMainThreadFileEvents,
  IMainThreadFs,
  IMainThreadLanguages,
  IMainThreadScm,
  IMainThreadTimeline,
  IMainThreadWindow,
  IRelativePatternDto,
} from '@universe-editor/extensions-common'
import { ExtensionService } from '../extensionService.js'
import type { IScannedExtension } from '../extensionScanner.js'

// A standalone ESM extension module that registers a command through the global
// host bridge — exactly what the bundled extension-api shim does at runtime.
const EXT_SOURCE = `
export function activate(context) {
  const bridge = globalThis.__universeExtensionHostBridge__
  context.subscriptions.push(
    bridge.registerCommand('test.cmd', (...args) => 'ran:' + args.join('|')),
  )
}
export function deactivate() {}
`

let dir: string
let mainPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ue-svc-'))
  mainPath = join(dir, 'extension.mjs')
  await writeFile(mainPath, EXT_SOURCE, 'utf8')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function recordingMainThread(): {
  impl: IMainThreadCommands
  registered: string[]
  unregistered: string[]
  executed: Array<{ id: string; args: unknown[] }>
} {
  const registered: string[] = []
  const unregistered: string[] = []
  const executed: Array<{ id: string; args: unknown[] }> = []
  return {
    registered,
    unregistered,
    executed,
    impl: {
      $registerCommand: (id) => {
        registered.push(id)
        return Promise.resolve()
      },
      $unregisterCommand: (id) => {
        unregistered.push(id)
        return Promise.resolve()
      },
      $getCommands: () => Promise.resolve([]),
      $executeCommand: (id, args) => {
        executed.push({ id, args })
        return Promise.resolve(`forwarded:${id}`)
      },
    },
  }
}

const noopWindow: IMainThreadWindow = {
  $showMessage: () => Promise.resolve(undefined),
  $showQuickPick: () => Promise.resolve(undefined),
  $showInputBox: () => Promise.resolve(undefined),
  $setStatusBarEntry: () => Promise.resolve(),
  $disposeStatusBarEntry: () => Promise.resolve(),
  $clipboardReadText: () => Promise.resolve(''),
  $clipboardWriteText: () => Promise.resolve(),
  $openExternal: () => Promise.resolve(false),
  $startProgress: () => Promise.resolve(),
  $reportProgress: () => Promise.resolve(),
  $endProgress: () => Promise.resolve(),
  $showOpenDialog: () => Promise.resolve(undefined),
  $showSaveDialog: () => Promise.resolve(undefined),
}

const noopScm: IMainThreadScm = {
  $registerSourceControl: () => Promise.resolve(),
  $updateSourceControl: () => Promise.resolve(),
  $unregisterSourceControl: () => Promise.resolve(),
  $registerGroup: () => Promise.resolve(),
  $updateGroup: () => Promise.resolve(),
  $updateGroupResourceStates: () => Promise.resolve(),
  $unregisterGroup: () => Promise.resolve(),
  $setInputBoxValue: () => Promise.resolve(),
  $setInputBoxPlaceholder: () => Promise.resolve(),
}

const noopTimeline: IMainThreadTimeline = {
  $registerTimelineProvider: () => Promise.resolve(),
  $unregisterTimelineProvider: () => Promise.resolve(),
  $emitTimelineChangeEvent: () => undefined,
}

function scanned(activationEvents: string[]): IScannedExtension {
  return {
    id: 'test.ext',
    extensionPath: dir,
    builtin: true,
    mainPath,
    manifest: {
      name: 'ext',
      version: '0.0.0',
      main: 'extension.mjs',
      engines: { universe: '^0.1.0' },
      activationEvents,
      contributes: {
        commands: [{ command: 'test.cmd', title: 'Test Command' }],
      },
    },
  }
}

describe('ExtensionService', () => {
  it('installs itself as the global API bridge', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    expect((globalThis as Record<string, unknown>).__universeExtensionHostBridge__).toBe(service)
  })

  it('exposes static contributions as DTOs', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['onCommand:test.cmd'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    const dtos = service.getContributions()
    expect(dtos).toHaveLength(1)
    expect(dtos[0]?.activationEvents).toEqual(['onCommand:test.cmd'])
    expect(dtos[0]?.contributes.commands?.[0]?.command).toBe('test.cmd')
  })

  it('emits extensionLocation as a file UriComponents, not a bare path string', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    const dto = service.getContributions()[0]!
    expect(typeof dto.extensionLocation).toBe('object')
    expect(dto.extensionLocation).toEqual(URI.file(dir).toJSON())
  })

  it('maps isUnderDevelopment onto the DTO only for dev extensions', () => {
    const mt = recordingMainThread()
    const dev = { ...scanned(['*']), id: 'dev.ext', isUnderDevelopment: true }
    const service = new ExtensionService(
      [scanned(['*']), dev],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    const dtos = service.getContributions()
    expect(dtos.find((d) => d.id === 'test.ext')?.extensionIsUnderDevelopment).toBeUndefined()
    expect(dtos.find((d) => d.id === 'dev.ext')?.extensionIsUnderDevelopment).toBe(true)
  })

  it('does not activate until a matching event fires', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['onCommand:test.cmd'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )

    await service.activateByEvent('onCommand:unrelated')
    expect(mt.registered).toEqual([])
    // Before activation the host doesn't own the command, so it forwards to the
    // renderer rather than running a handler locally.
    await service.executeContributedCommand('test.cmd', [])
    expect(mt.executed).toEqual([{ id: 'test.cmd', args: [] }])
  })

  it('activates lazily, registering the command and routing execution', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['onCommand:test.cmd'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )

    await service.activateByEvent('onCommand:test.cmd')
    expect(mt.registered).toEqual(['test.cmd'])

    await expect(service.executeContributedCommand('test.cmd', ['a', 'b'])).resolves.toBe('ran:a|b')
  })

  it('activates each extension at most once', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['onCommand:test.cmd'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )

    await service.activateByEvent('onCommand:test.cmd')
    await service.activateByEvent('onCommand:test.cmd')
    expect(mt.registered).toEqual(['test.cmd'])
  })

  it('a wildcard extension activates on any event', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )

    await service.activateByEvent('onStartupFinished')
    expect(mt.registered).toEqual(['test.cmd'])
  })

  it('dispose() deactivates activated extensions and disposes their subscriptions', async () => {
    // An extension that records both its deactivate call and a subscription's
    // dispose into a global sink so the test can observe host shutdown teardown.
    const source = `
      export function activate(context) {
        const sink = globalThis.__ueTestSink__
        context.subscriptions.push({ dispose: () => sink.push('sub-dispose') })
      }
      export function deactivate() {
        globalThis.__ueTestSink__.push('deactivate')
      }
    `
    const disposingMain = join(dir, 'disposing.mjs')
    await writeFile(disposingMain, source, 'utf8')
    const sink: string[] = []
    ;(globalThis as Record<string, unknown>).__ueTestSink__ = sink

    const ext: IScannedExtension = {
      id: 'test.disposing',
      extensionPath: dir,
      builtin: true,
      mainPath: disposingMain,
      manifest: {
        name: 'disposing',
        version: '0.0.0',
        main: 'disposing.mjs',
        engines: { universe: '^0.1.0' },
        activationEvents: ['*'],
      },
    }
    const mt = recordingMainThread()
    const service = new ExtensionService([ext], mt.impl, noopWindow, noopScm, noopTimeline)
    await service.activateByEvent('*')

    service.dispose()
    // deactivate hook runs first, then subscriptions are disposed.
    expect(sink).toEqual(['deactivate', 'sub-dispose'])

    // Idempotent: a second dispose is a no-op (activated set cleared).
    service.dispose()
    expect(sink).toEqual(['deactivate', 'sub-dispose'])

    delete (globalThis as Record<string, unknown>).__ueTestSink__
  })

  it('forwards an unknown command to the renderer', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    await expect(service.executeCommand('_workbench.openDiff', [{ x: 1 }])).resolves.toBe(
      'forwarded:_workbench.openDiff',
    )
    expect(mt.executed).toEqual([{ id: '_workbench.openDiff', args: [{ x: 1 }] }])
  })

  it('exposes the workspace root through the API bridge', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/repo/root',
    )
    expect(service.getWorkspaceRoot()).toBe('/repo/root')
  })

  it('reports no workspace root when none was provided', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    expect(service.getWorkspaceRoot()).toBeUndefined()
  })
})

describe('ExtensionService env / extensions namespaces', () => {
  it('environment info defaults to empty strings until the renderer seeds it', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    expect(service.getEnvironmentInfo()).toEqual({
      appName: '',
      appVersion: '',
      sessionId: '',
      uriScheme: '',
      language: '',
      machineId: '',
      appRoot: '',
    })

    service.initializeEnvironment({
      appName: 'Universe Editor',
      appVersion: '1.2.3',
      sessionId: 'session-1',
      uriScheme: 'universe-editor',
      language: 'zh-CN',
      machineId: 'machine-1',
      appRoot: '/apps/universe',
    })
    expect(service.getEnvironmentInfo().appName).toBe('Universe Editor')
    expect(service.getEnvironmentInfo().language).toBe('zh-CN')
    expect(service.getEnvironmentInfo().machineId).toBe('machine-1')
    expect(service.getEnvironmentInfo().appRoot).toBe('/apps/universe')
  })

  it('clipboard and openExternal delegate to mainThreadWindow', async () => {
    const written: string[] = []
    const opened: string[] = []
    const window: IMainThreadWindow = {
      ...noopWindow,
      $clipboardReadText: () => Promise.resolve('clip'),
      $clipboardWriteText: (value) => {
        written.push(value)
        return Promise.resolve()
      },
      $openExternal: (target) => {
        opened.push(target)
        return Promise.resolve(true)
      },
    }
    const mt = recordingMainThread()
    const service = new ExtensionService([scanned(['*'])], mt.impl, window, noopScm, noopTimeline)
    await expect(service.clipboardReadText()).resolves.toBe('clip')
    await service.clipboardWriteText('hello')
    expect(written).toEqual(['hello'])
    await expect(service.openExternal('https://example.com')).resolves.toBe(true)
    expect(opened).toEqual(['https://example.com'])
  })

  it('getCommands returns the renderer registry ids', async () => {
    const mt = recordingMainThread()
    const window: IMainThreadWindow = { ...noopWindow }
    const commands: IMainThreadCommands = {
      ...mt.impl,
      $getCommands: () => Promise.resolve(['a.cmd', '_internal.cmd']),
    }
    const service = new ExtensionService([scanned(['*'])], commands, window, noopScm, noopTimeline)
    await expect(service.getCommands()).resolves.toEqual(['a.cmd', '_internal.cmd'])
  })

  it('extensions handles expose scanned metadata and live activation state', async () => {
    const exportsMain = join(dir, 'withExports.mjs')
    await writeFile(exportsMain, `export function activate() { return { ok: true } }`, 'utf8')
    const ext: IScannedExtension = {
      ...scanned(['onCommand:test.cmd']),
      mainPath: exportsMain,
    }
    const mt = recordingMainThread()
    const service = new ExtensionService([ext], mt.impl, noopWindow, noopScm, noopTimeline)

    expect(service.getExtensions()).toHaveLength(1)
    const handle = service.getExtension('test.ext')
    expect(handle).toBeDefined()
    expect(service.getExtension('no.such')).toBeUndefined()
    expect(handle?.id).toBe('test.ext')
    expect(handle?.extensionPath).toBe(dir)
    expect(handle?.packageJSON.name).toBe('ext')
    // Live getters: inactive until activated through the handle.
    expect(handle?.isActive).toBe(false)
    expect(handle?.exports).toBeUndefined()

    await handle?.activate()
    expect(handle?.isActive).toBe(true)
    expect(handle?.exports).toEqual({ ok: true })
  })
})

/**
 * Active-editor mirror: the wire DTO carries no document text (a 15MB buffer
 * re-crossing the wire per tab switch froze the renderer); the document must be
 * resolved from the ExtHostDocuments mirror, deferring the event when the
 * mirror's didOpen has not landed yet.
 */
describe('ExtensionService active editor mirror', () => {
  const noopEditor: IMainThreadEditor = {
    $getActiveTextEditor: () => Promise.resolve(null),
    $applyEdits: () => Promise.resolve(true),
    $setSelections: () => Promise.resolve(),
    $createDecorationType: () => Promise.resolve(),
    $disposeDecorationType: () => Promise.resolve(),
    $setDecorations: () => Promise.resolve(),
    $openTextDocument: () => Promise.resolve(),
    $openUntitledDocument: () => Promise.resolve(Uri.parse('untitled:/Untitled-1').toJSON()),
    $showTextDocument: () => Promise.resolve(null),
    $applyWorkspaceEdit: () => Promise.resolve(true),
  }

  function editorService(): ExtensionService {
    const mt = recordingMainThread()
    return new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      undefined,
      undefined,
      undefined,
      undefined,
      noopEditor,
    )
  }

  const docUri = URI.file('/ws/big.d.ts')
  const snapshot: IActiveTextEditorDto = {
    uri: docUri.toJSON() as UriComponents,
    languageId: 'typescript',
    version: 3,
    selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }],
  }

  it('fires with the mirrored document when it is already open', () => {
    const service = editorService()
    service.acceptDocumentOpen(docUri, 'typescript', 3, 'declare const x: number')
    const fired: (TextEditor | undefined)[] = []
    service.onDidChangeActiveTextEditor((e) => fired.push(e))
    service.acceptActiveEditorChange(snapshot)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.document.getText()).toBe('declare const x: number')
    // Live mirror, not a frozen copy — later deltas are visible to the editor handle.
    expect(fired[0]?.document).toBe(service.getTextDocuments()[0])
  })

  it('defers the event until the document mirror opens', async () => {
    const service = editorService()
    const fired: (TextEditor | undefined)[] = []
    service.onDidChangeActiveTextEditor((e) => fired.push(e))
    service.acceptActiveEditorChange(snapshot)
    expect(fired).toHaveLength(0)
    service.acceptDocumentOpen(docUri, 'typescript', 3, 'late text')
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.document.getText()).toBe('late text')
  })

  it('drops a deferred event superseded by a newer editor change', async () => {
    const service = editorService()
    const fired: (TextEditor | undefined)[] = []
    service.onDidChangeActiveTextEditor((e) => fired.push(e))
    service.acceptActiveEditorChange(snapshot)
    service.acceptActiveEditorChange(null) // user moved on before the doc arrived
    service.acceptDocumentOpen(docUri, 'typescript', 3, 'too late')
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toEqual([undefined])
  })
})

/**
 * Visible-editors mirror: the renderer pushes the whole per-group set. The
 * getter always reflects the mirrored members of the latest push; the event
 * waits out a short grace for cold (not-yet-mirrored) documents so a layout
 * change normally reports the complete set, then reports the best-known subset
 * rather than stalling — a mirror landing later merges in and fires a follow-up.
 */
describe('ExtensionService visible editors mirror', () => {
  const noopEditor: IMainThreadEditor = {
    $getActiveTextEditor: () => Promise.resolve(null),
    $applyEdits: () => Promise.resolve(true),
    $setSelections: () => Promise.resolve(),
    $createDecorationType: () => Promise.resolve(),
    $disposeDecorationType: () => Promise.resolve(),
    $setDecorations: () => Promise.resolve(),
    $openTextDocument: () => Promise.resolve(),
    $openUntitledDocument: () => Promise.resolve(Uri.parse('untitled:/Untitled-1').toJSON()),
    $showTextDocument: () => Promise.resolve(null),
    $applyWorkspaceEdit: () => Promise.resolve(true),
  }

  function editorService(): ExtensionService {
    const mt = recordingMainThread()
    return new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      undefined,
      undefined,
      undefined,
      undefined,
      noopEditor,
    )
  }

  const uriA = URI.file('/ws/a.txt')
  const uriB = URI.file('/ws/b.txt')
  const snap = (uri: URI): IActiveTextEditorDto => ({
    uri: uri.toJSON() as UriComponents,
    languageId: 'plaintext',
    version: 1,
    selections: [],
  })

  it('getter returns the latest pushed set backed by the mirrored documents', () => {
    const service = editorService()
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
    service.acceptDocumentOpen(uriB, 'plaintext', 1, 'bbb')
    service.acceptVisibleEditorsChange([snap(uriA), snap(uriB)])
    expect(service.visibleTextEditors).toHaveLength(2)
    expect(service.visibleTextEditors.map((e) => e.document.uri.path)).toEqual([
      '/ws/a.txt',
      '/ws/b.txt',
    ])
    expect(service.visibleTextEditors[0]?.document.getText()).toBe('aaa')
  })

  it('fires onDidChangeVisibleTextEditors with the fresh set, including the empty set', () => {
    const service = editorService()
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
    const fired: (readonly TextEditor[])[] = []
    service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))
    service.acceptVisibleEditorsChange([snap(uriA)])
    service.acceptVisibleEditorsChange([])
    expect(fired.map((set) => set.length)).toEqual([1, 0])
  })

  it('drops an unmirrored document from the getter until its didOpen lands', async () => {
    const service = editorService()
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
    const fired: (readonly TextEditor[])[] = []
    service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))
    service.acceptVisibleEditorsChange([snap(uriA), snap(uriB)])
    expect(service.visibleTextEditors.map((e) => e.document.uri.path)).toEqual(['/ws/a.txt'])
    expect(fired).toHaveLength(0)

    service.acceptDocumentOpen(uriB, 'plaintext', 1, 'bbb')
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.map((e) => e.document.uri.path)).toEqual(['/ws/a.txt', '/ws/b.txt'])
    expect(service.visibleTextEditors).toHaveLength(2)
  })

  it('a doc-pending push is superseded by a newer push', async () => {
    const service = editorService()
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
    const fired: (readonly TextEditor[])[] = []
    service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))
    service.acceptVisibleEditorsChange([snap(uriB)]) // B's doc never lands in time
    service.acceptVisibleEditorsChange([snap(uriA)]) // user moved on
    service.acceptDocumentOpen(uriB, 'plaintext', 1, 'too late')
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.map((e) => e.document.uri.path)).toEqual(['/ws/a.txt'])
    expect(service.visibleTextEditors).toHaveLength(1)
  })

  it('reports a layout change within a grace window instead of waiting for a cold mirror', () => {
    vi.useFakeTimers()
    try {
      const service = editorService()
      service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
      const fired: (readonly TextEditor[])[] = []
      service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))
      service.acceptVisibleEditorsChange([snap(uriA)])
      expect(fired).toHaveLength(1)

      // Tab switch to a cold document whose mirror never lands: the layout
      // change must reach extensions within a short grace, not a 15s wait.
      service.acceptVisibleEditorsChange([snap(uriB)])
      expect(service.visibleTextEditors).toHaveLength(0)
      expect(fired).toHaveLength(1)

      vi.advanceTimersByTime(1_000)
      expect(fired).toHaveLength(2)
      expect(fired[1]).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges a late-mirrored document into the latest set after a push race', () => {
    vi.useFakeTimers()
    try {
      const service = editorService()
      service.acceptDocumentOpen(uriB, 'plaintext', 1, 'bbb')
      const fired: (readonly TextEditor[])[] = []
      service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))

      service.acceptVisibleEditorsChange([snap(uriA)]) // A's mirror is still cold…
      service.acceptVisibleEditorsChange([snap(uriA), snap(uriB)]) // …and a race push arrives
      vi.advanceTimersByTime(1_000)
      // Grace elapsed: the best-known subset is reported; A is not yet a member.
      expect(fired.map((set) => set.map((e) => e.document.uri.path))).toEqual([['/ws/b.txt']])

      vi.advanceTimersByTime(20_000) // well past the old 15s whole-batch drop window
      service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
      expect(service.visibleTextEditors.map((e) => e.document.uri.path)).toEqual([
        '/ws/a.txt',
        '/ws/b.txt',
      ])
      expect(fired).toHaveLength(2)
      expect(fired[1]?.map((e) => e.document.uri.path)).toEqual(['/ws/a.txt', '/ws/b.txt'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the getter honest inside the cold-mirror window and converges on didOpen', () => {
    const service = editorService()
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
    const fired: (readonly TextEditor[])[] = []
    service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))
    service.acceptVisibleEditorsChange([snap(uriA)])
    service.acceptVisibleEditorsChange([snap(uriB)])
    // The cold-mirror window: the getter serves only the mirrored members of the
    // latest push — never the stale set B already left.
    expect(service.visibleTextEditors).toHaveLength(0)
    service.acceptDocumentOpen(uriB, 'plaintext', 1, 'bbb')
    expect(service.visibleTextEditors.map((e) => e.document.uri.path)).toEqual(['/ws/b.txt'])
    expect(fired.at(-1)?.map((e) => e.document.uri.path)).toEqual(['/ws/b.txt'])
  })

  it('fires once when every straggler lands inside the grace window', () => {
    const service = editorService()
    const fired: (readonly TextEditor[])[] = []
    service.onDidChangeVisibleTextEditors((editors) => fired.push(editors))
    service.acceptVisibleEditorsChange([snap(uriA), snap(uriB)])
    service.acceptDocumentOpen(uriB, 'plaintext', 1, 'bbb') // partial: stays silent
    expect(fired).toHaveLength(0)
    expect(service.visibleTextEditors.map((e) => e.document.uri.path)).toEqual(['/ws/b.txt'])
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa') // complete → one event
    expect(fired).toHaveLength(1)
    expect(fired[0]?.map((e) => e.document.uri.path)).toEqual(['/ws/a.txt', '/ws/b.txt'])
  })

  it('lists the same document once per group showing it (split on the same file)', () => {
    const service = editorService()
    service.acceptDocumentOpen(uriA, 'plaintext', 1, 'aaa')
    service.acceptVisibleEditorsChange([snap(uriA), snap(uriA)])
    expect(service.visibleTextEditors).toHaveLength(2)
  })
})

describe('ExtensionService window additions', () => {
  const docUri = URI.file('/ws/doc.md')
  const docComponents = docUri.toJSON() as UriComponents

  function serviceWith(
    window: Partial<IMainThreadWindow> = {},
    editor: Partial<IMainThreadEditor> = {},
  ): ExtensionService {
    const mt = recordingMainThread()
    return new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      { ...noopWindow, ...window },
      noopScm,
      noopTimeline,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        $getActiveTextEditor: () => Promise.resolve(null),
        $applyEdits: () => Promise.resolve(true),
        $setSelections: () => Promise.resolve(),
        $createDecorationType: () => Promise.resolve(),
        $disposeDecorationType: () => Promise.resolve(),
        $setDecorations: () => Promise.resolve(),
        $openTextDocument: () => Promise.resolve(),
        $openUntitledDocument: () => Promise.resolve(Uri.parse('untitled:/Untitled-1').toJSON()),
        $showTextDocument: () => Promise.resolve(null),
        $applyWorkspaceEdit: () => Promise.resolve(true),
        ...editor,
      },
    )
  }

  it('withProgress starts, reports and ends the renderer progress', async () => {
    const events: string[] = []
    const service = serviceWith({
      $startProgress: (handle, options) => {
        events.push(`start:${handle}:${options.location}:${options.title ?? ''}`)
        return Promise.resolve()
      },
      $reportProgress: (handle, value) => {
        events.push(`report:${handle}:${value.message ?? ''}:${value.increment ?? ''}`)
        return Promise.resolve()
      },
      $endProgress: (handle) => {
        events.push(`end:${handle}`)
        return Promise.resolve()
      },
    })
    const result = await service.withProgress(
      { location: 15, title: 'Working', cancellable: true },
      (progress, token) => {
        progress.report({ message: 'half', increment: 50 })
        expect(token.isCancellationRequested).toBe(false)
        return Promise.resolve('done')
      },
    )
    expect(result).toBe('done')
    expect(events).toEqual(['start:0:15:Working', 'report:0:half:50', 'end:0'])
  })

  it('withProgress ends the progress even when the task throws', async () => {
    const ended: number[] = []
    const service = serviceWith({
      $endProgress: (handle) => {
        ended.push(handle)
        return Promise.resolve()
      },
    })
    await expect(
      service.withProgress({ location: 10 }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    expect(ended).toEqual([0])
  })

  it('acceptProgressCanceled flips the task token', async () => {
    const service = serviceWith()
    let observed: boolean | undefined
    const run = service.withProgress({ location: 15, cancellable: true }, (_progress, token) => {
      return new Promise<string>((resolve) => {
        token.onCancellationRequested(() => {
          observed = token.isCancellationRequested
          resolve('cancelled')
        })
      })
    })
    // Let $startProgress land so the cancel source is registered.
    await new Promise((r) => setTimeout(r, 0))
    service.acceptProgressCanceled(0)
    await expect(run).resolves.toBe('cancelled')
    expect(observed).toBe(true)
  })

  it('setStatusBarMessage hides after the timeout', () => {
    vi.useFakeTimers()
    try {
      const entries = new Map<number, { text: string; alignment: number; priority: number }>()
      const service = serviceWith({
        $setStatusBarEntry: (handle, entry) => {
          entries.set(handle, entry)
          return Promise.resolve()
        },
        $disposeStatusBarEntry: (handle) => {
          entries.delete(handle)
          return Promise.resolve()
        },
      })
      const disposable = service.setStatusBarMessage('saved', 1000)
      expect(entries.size).toBe(1)
      expect([...entries.values()][0]).toMatchObject({ text: 'saved', alignment: 0 })
      vi.advanceTimersByTime(1000)
      expect(entries.size).toBe(0)
      disposable.dispose() // idempotent after auto-hide
    } finally {
      vi.useRealTimers()
    }
  })

  it('setStatusBarMessage hides when the promise settles', async () => {
    const entries = new Map<number, unknown>()
    const service = serviceWith({
      $setStatusBarEntry: (handle, entry) => {
        entries.set(handle, entry)
        return Promise.resolve()
      },
      $disposeStatusBarEntry: (handle) => {
        entries.delete(handle)
        return Promise.resolve()
      },
    })
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    service.setStatusBarMessage('building', done)
    expect(entries.size).toBe(1)
    resolveDone()
    await new Promise((r) => setTimeout(r, 0))
    expect(entries.size).toBe(0)
  })

  it('showOpenDialog maps wire fsPaths back to Uri components', async () => {
    let captured: { defaultUri?: string; title?: string } | undefined
    const service = serviceWith({
      $showOpenDialog: (options) => {
        captured = options
        return Promise.resolve(['/ws/a.ts', '/ws/b.ts'])
      },
    })
    const uris = await service.showOpenDialog({
      defaultUri: URI.file('/ws').toJSON(),
      title: 'Open',
    })
    // The wire form is the extension-api fsPath (backslash-normalized on win32).
    expect(captured?.defaultUri).toBe(Uri.file('/ws').fsPath)
    expect(captured?.title).toBe('Open')
    expect(uris).toEqual([Uri.file('/ws/a.ts').toJSON(), Uri.file('/ws/b.ts').toJSON()])
  })

  it('showSaveDialog returns undefined when cancelled', async () => {
    const service = serviceWith({ $showSaveDialog: () => Promise.resolve(undefined) })
    await expect(service.showSaveDialog()).resolves.toBeUndefined()
  })

  it('openTextDocument reuses an already-mirrored document (no RPC)', async () => {
    const openRpc = vi.fn().mockResolvedValue(undefined)
    const service = serviceWith({}, { $openTextDocument: openRpc })
    service.acceptDocumentOpen(docComponents, 'markdown', 1, 'live')
    const doc = await service.openTextDocument(docComponents)
    expect(doc.getText()).toBe('live')
    expect(openRpc).not.toHaveBeenCalled()
  })

  it('openTextDocument asks the renderer and waits for the mirror push', async () => {
    const openRpc = vi.fn().mockResolvedValue(undefined)
    const service = serviceWith({}, { $openTextDocument: openRpc })
    const pending = service.openTextDocument(docComponents)
    // The renderer's mirror push lands a tick after the RPC resolves.
    setTimeout(() => service.acceptDocumentOpen(docComponents, 'markdown', 1, 'from disk'), 0)
    const doc = await pending
    expect(openRpc).toHaveBeenCalledOnce()
    expect(doc.getText()).toBe('from disk')
  })

  it('openTextDocument(options) creates an untitled document via the renderer', async () => {
    const untitledComponents = Uri.parse('untitled:/Untitled-7').toJSON()
    const openUntitledRpc = vi.fn().mockResolvedValue(untitledComponents)
    const openRpc = vi.fn().mockResolvedValue(undefined)
    const service = serviceWith(
      {},
      { $openUntitledDocument: openUntitledRpc, $openTextDocument: openRpc },
    )
    const pending = service.openTextDocument({ language: 'typescript', content: 'let x = 1' })
    setTimeout(
      () => service.acceptDocumentOpen(untitledComponents, 'typescript', 1, 'let x = 1'),
      0,
    )
    const doc = await pending
    expect(openUntitledRpc).toHaveBeenCalledWith({ language: 'typescript', content: 'let x = 1' })
    expect(openRpc).not.toHaveBeenCalled()
    expect(doc.isUntitled).toBe(true)
    expect(doc.languageId).toBe('typescript')
    expect(doc.getText()).toBe('let x = 1')
  })

  it('openTextDocument() with no argument creates an empty untitled document', async () => {
    const untitledComponents = Uri.parse('untitled:/Untitled-8').toJSON()
    const openUntitledRpc = vi.fn().mockResolvedValue(untitledComponents)
    const service = serviceWith({}, { $openUntitledDocument: openUntitledRpc })
    const pending = service.openTextDocument()
    setTimeout(() => service.acceptDocumentOpen(untitledComponents, 'plaintext', 1, ''), 0)
    const doc = await pending
    expect(openUntitledRpc).toHaveBeenCalledWith({})
    expect(doc.isUntitled).toBe(true)
    expect(doc.getText()).toBe('')
  })

  it('openTextDocument(untitled uri) goes through $openTextDocument, not the options channel', async () => {
    const untitledComponents = Uri.parse('untitled:/Untitled-9').toJSON()
    const openRpc = vi.fn().mockResolvedValue(undefined)
    const openUntitledRpc = vi.fn()
    const service = serviceWith(
      {},
      { $openTextDocument: openRpc, $openUntitledDocument: openUntitledRpc },
    )
    const pending = service.openTextDocument(untitledComponents)
    setTimeout(() => service.acceptDocumentOpen(untitledComponents, 'plaintext', 1, ''), 0)
    const doc = await pending
    expect(openRpc).toHaveBeenCalledOnce()
    const sentUri = openRpc.mock.calls[0]![0] as { toJSON(): unknown }
    expect(sentUri.toJSON()).toEqual({ ...untitledComponents, $mid: 1 })
    expect(openUntitledRpc).not.toHaveBeenCalled()
    expect(doc.isUntitled).toBe(true)
  })

  it('a file document reports isUntitled false', async () => {
    const fileComponents = Uri.file('/ws/a.ts').toJSON()
    const openRpc = vi.fn().mockResolvedValue(undefined)
    const service = serviceWith({}, { $openTextDocument: openRpc })
    const pending = service.openTextDocument(fileComponents)
    setTimeout(() => service.acceptDocumentOpen(fileComponents, 'typescript', 1, 'x'), 0)
    const doc = await pending
    expect(doc.isUntitled).toBe(false)
  })

  it('showTextDocument returns the editor snapshot over the mirrored document', async () => {
    const sels = [{ anchor: { line: 2, character: 1 }, active: { line: 2, character: 5 } }]
    let shownOptions: unknown
    const service = serviceWith(
      {},
      {
        $showTextDocument: (uri, options) => {
          shownOptions = options
          return Promise.resolve({ uri, languageId: 'markdown', version: 1, selections: sels })
        },
      },
    )
    const pending = service.showTextDocument(docComponents, { preview: true })
    service.acceptDocumentOpen(docComponents, 'markdown', 1, 'shown')
    const editor = await pending
    expect(shownOptions).toMatchObject({ preview: true })
    expect(editor.document.getText()).toBe('shown')
    expect(editor.selections[0]?.active.character).toBe(5)
  })

  it('fires onDidChangeTextEditorSelection with the mirrored document', () => {
    const service = serviceWith()
    service.acceptDocumentOpen(docComponents, 'markdown', 1, 'x')
    const fired: TextEditorSelectionChangeEvent[] = []
    service.onDidChangeTextEditorSelection((e) => fired.push(e))
    // Feed a null `kind` to lock the defensive normalization to undefined.
    service.acceptSelectionChange(
      docComponents,
      [{ anchor: { line: 1, character: 2 }, active: { line: 1, character: 2 } }],
      null as unknown as undefined,
    )
    expect(fired).toHaveLength(1)
    expect(fired[0]?.kind).toBeUndefined()
    expect(fired[0]?.selections[0]?.active).toEqual({ line: 1, character: 2 })
    expect(fired[0]?.textEditor.document.getText()).toBe('x')
  })

  it('drops selection changes for documents the mirror does not know', () => {
    const service = serviceWith()
    const fired: TextEditorSelectionChangeEvent[] = []
    service.onDidChangeTextEditorSelection((e) => fired.push(e))
    service.acceptSelectionChange(docComponents, [], 1)
    expect(fired).toHaveLength(0)
  })
})

describe('ExtensionService workspace additions', () => {
  it('acceptDocumentSave fans out to onDidSaveTextDocument only for mirrored documents', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    const saved: string[] = []
    service.onDidSaveTextDocument((doc) => saved.push(doc.getText()))

    service.acceptDocumentSave(URI.file('/ws/never-opened.ts'))
    expect(saved).toEqual([])

    service.acceptDocumentOpen(URI.file('/ws/a.ts'), 'typescript', 1, 'const a = 1')
    service.acceptDocumentSave(URI.file('/ws/a.ts'))
    expect(saved).toEqual(['const a = 1'])
  })

  it('applyWorkspaceEdit forwards to mainThreadEditor', async () => {
    const mt = recordingMainThread()
    let applied: unknown
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        $getActiveTextEditor: () => Promise.resolve(null),
        $applyEdits: () => Promise.resolve(true),
        $setSelections: () => Promise.resolve(),
        $createDecorationType: () => Promise.resolve(),
        $disposeDecorationType: () => Promise.resolve(),
        $setDecorations: () => Promise.resolve(),
        $openTextDocument: () => Promise.resolve(),
        $openUntitledDocument: () => Promise.resolve(Uri.parse('untitled:/Untitled-1').toJSON()),
        $showTextDocument: () => Promise.resolve(null),
        $applyWorkspaceEdit: (edit) => {
          applied = edit
          return Promise.resolve(true)
        },
      },
    )
    const edit = { changes: { 'file:///ws/a.ts': [] } }
    await expect(service.applyWorkspaceEdit(edit)).resolves.toBe(true)
    expect(applied).toBe(edit)
  })

  it('findFiles maps API exclude semantics onto the wire', async () => {
    const mt = recordingMainThread()
    const calls: Array<{
      exclude: readonly (string | IRelativePatternDto)[] | null
      maxResults: number | null
    }> = []
    const fs: IMainThreadFs = {
      $readFile: () => Promise.resolve(''),
      $writeFile: () => Promise.resolve(),
      $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
      $readDirectory: () => Promise.resolve([]),
      $createDirectory: () => Promise.resolve(),
      $delete: () => Promise.resolve(),
      $rename: () => Promise.resolve(),
      $copy: () => Promise.resolve(),
      $findFiles: (_include, exclude, maxResults) => {
        calls.push({ exclude, maxResults })
        return Promise.resolve(['/ws/a.ts'])
      },
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      fs,
    )
    await expect(service.findFiles('**/*.ts', undefined, undefined)).resolves.toEqual(['/ws/a.ts'])
    await service.findFiles('**/*.ts', null, 10)
    await service.findFiles('**/*.ts', '**/dist/**', undefined)
    expect(calls).toEqual([
      { exclude: null, maxResults: null },
      { exclude: [], maxResults: 10 },
      { exclude: ['**/dist/**'], maxResults: null },
    ])
  })

  it('findFiles serializes a RelativePattern include/exclude onto the wire', async () => {
    const mt = recordingMainThread()
    const calls: Array<{
      include: string | IRelativePatternDto
      exclude: readonly (string | IRelativePatternDto)[] | null
    }> = []
    const fs: IMainThreadFs = {
      $readFile: () => Promise.resolve(''),
      $writeFile: () => Promise.resolve(),
      $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
      $readDirectory: () => Promise.resolve([]),
      $createDirectory: () => Promise.resolve(),
      $delete: () => Promise.resolve(),
      $rename: () => Promise.resolve(),
      $copy: () => Promise.resolve(),
      $findFiles: (include, exclude) => {
        calls.push({ include, exclude })
        return Promise.resolve([])
      },
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      fs,
    )
    await service.findFiles(new RelativePattern('/ws/src', '**/*.ts'), undefined, undefined)
    await service.findFiles('**/*.ts', new RelativePattern('/ws/src/generated', '**'), undefined)
    const base = (p: string): IRelativePatternDto['base'] => Uri.file(p).toJSON()
    expect(calls).toEqual([
      { include: { base: base('/ws/src'), pattern: '**/*.ts' }, exclude: null },
      { include: '**/*.ts', exclude: [{ base: base('/ws/src/generated'), pattern: '**' }] },
    ])
  })

  it('findFiles forwards the token as the RPC trailing argument', async () => {
    const mt = recordingMainThread()
    let seenToken: unknown
    const fs: IMainThreadFs = {
      $readFile: () => Promise.resolve(''),
      $writeFile: () => Promise.resolve(),
      $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
      $readDirectory: () => Promise.resolve([]),
      $createDirectory: () => Promise.resolve(),
      $delete: () => Promise.resolve(),
      $rename: () => Promise.resolve(),
      $copy: () => Promise.resolve(),
      // The ProxyChannel envelope appends the token as the trailing argument.
      $findFiles: (...args: unknown[]) => {
        seenToken = args[3]
        return Promise.resolve([])
      },
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      fs,
    )
    const cts = new ApiCancellationTokenSource()
    await service.findFiles('**/*.ts', undefined, undefined, cts.token)
    expect(seenToken).toBe(cts.token)
  })

  it('findFiles resolves [] when the request is cancelled mid-flight', async () => {
    const mt = recordingMainThread()
    let tokenSeenByRenderer: { isCancellationRequested: boolean } | undefined
    const fs: IMainThreadFs = {
      $readFile: () => Promise.resolve(''),
      $writeFile: () => Promise.resolve(),
      $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
      $readDirectory: () => Promise.resolve([]),
      $createDirectory: () => Promise.resolve(),
      $delete: () => Promise.resolve(),
      $rename: () => Promise.resolve(),
      $copy: () => Promise.resolve(),
      // Mirror the RPC boundary: once the token fires, the channel rejects the
      // pending call with a CancellationError.
      $findFiles: (...args: unknown[]) => {
        tokenSeenByRenderer = args[3] as { isCancellationRequested: boolean }
        return new Promise((_resolve, reject) => {
          const token = args[3] as {
            onCancellationRequested: (listener: () => void) => void
          }
          token.onCancellationRequested(() => reject(new CancellationError()))
        })
      },
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      fs,
    )
    const cts = new ApiCancellationTokenSource()
    const pending = service.findFiles('**/*.ts', undefined, undefined, cts.token)
    cts.cancel()
    await expect(pending).resolves.toEqual([])
    expect(tokenSeenByRenderer?.isCancellationRequested).toBe(true)
  })

  it('findFiles warns (but still resolves []) when a real error races the cancellation', async () => {
    const mt = recordingMainThread()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fs: IMainThreadFs = {
        $readFile: () => Promise.resolve(''),
        $writeFile: () => Promise.resolve(),
        $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
        $readDirectory: () => Promise.resolve([]),
        $createDirectory: () => Promise.resolve(),
        $delete: () => Promise.resolve(),
        $rename: () => Promise.resolve(),
        $copy: () => Promise.resolve(),
        // The renderer's path policy rejected the include root at the very
        // moment the token fired — it must not be mistaken for the cancel path.
        $findFiles: () => Promise.reject(new Error('access outside the workspace is denied')),
      }
      const service = new ExtensionService(
        [scanned(['*'])],
        mt.impl,
        noopWindow,
        noopScm,
        noopTimeline,
        '/ws',
        fs,
      )
      const cts = new ApiCancellationTokenSource()
      cts.cancel()
      await expect(service.findFiles('**/*.ts', undefined, undefined, cts.token)).resolves.toEqual(
        [],
      )
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('access outside the workspace is denied'),
      )
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('findFiles does not warn when the cancelled request rejects with a cancellation', async () => {
    const mt = recordingMainThread()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fs: IMainThreadFs = {
        $readFile: () => Promise.resolve(''),
        $writeFile: () => Promise.resolve(),
        $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
        $readDirectory: () => Promise.resolve([]),
        $createDirectory: () => Promise.resolve(),
        $delete: () => Promise.resolve(),
        $rename: () => Promise.resolve(),
        $copy: () => Promise.resolve(),
        $findFiles: () => Promise.reject(new CancellationError()),
      }
      const service = new ExtensionService(
        [scanned(['*'])],
        mt.impl,
        noopWindow,
        noopScm,
        noopTimeline,
        '/ws',
        fs,
      )
      const cts = new ApiCancellationTokenSource()
      cts.cancel()
      await expect(service.findFiles('**/*.ts', undefined, undefined, cts.token)).resolves.toEqual(
        [],
      )
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('findFiles rethrows a real error when the token was not cancelled', async () => {
    const mt = recordingMainThread()
    const fs: IMainThreadFs = {
      $readFile: () => Promise.resolve(''),
      $writeFile: () => Promise.resolve(),
      $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
      $readDirectory: () => Promise.resolve([]),
      $createDirectory: () => Promise.resolve(),
      $delete: () => Promise.resolve(),
      $rename: () => Promise.resolve(),
      $copy: () => Promise.resolve(),
      $findFiles: () => Promise.reject(new Error('rg exploded')),
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      fs,
    )
    const cts = new ApiCancellationTokenSource()
    await expect(service.findFiles('**/*.ts', undefined, undefined, cts.token)).rejects.toThrow(
      'rg exploded',
    )
  })

  it('fs.rename/fs.copy forward the overwrite flag', async () => {
    const mt = recordingMainThread()
    const calls: Array<[string, string, boolean]> = []
    const fs: IMainThreadFs = {
      $readFile: () => Promise.resolve(''),
      $writeFile: () => Promise.resolve(),
      $stat: () => Promise.resolve({ type: 'file', size: 0, mtime: 0 }),
      $readDirectory: () => Promise.resolve([]),
      $createDirectory: () => Promise.resolve(),
      $delete: () => Promise.resolve(),
      $rename: (s, t, o) => {
        calls.push(['rename', `${s}->${t}`, o])
        return Promise.resolve()
      },
      $copy: (s, t, o) => {
        calls.push(['copy', `${s}->${t}`, o])
        return Promise.resolve()
      },
      $findFiles: () => Promise.resolve([]),
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      fs,
    )
    await service.fsRename('/ws/a', '/ws/b', true)
    await service.fsCopy('/ws/a', '/ws/c', false)
    expect(calls).toEqual([
      ['rename', '/ws/a->/ws/b', true],
      ['copy', '/ws/a->/ws/c', false],
    ])
  })

  it('acceptConfigurationChanged fires affectsConfiguration with prefix semantics', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
    )
    const fired: boolean[][] = []
    service.onDidChangeConfiguration((e) => {
      fired.push([
        e.affectsConfiguration('git'),
        e.affectsConfiguration('git.autofetch'),
        e.affectsConfiguration('git.autofetch.period'),
        e.affectsConfiguration('gitlab'),
        e.affectsConfiguration('other'),
      ])
    })
    // Prefix matching is bidirectional: the changed key may sit under the asked
    // section ('git') or prefix it ('git.autofetch.period').
    service.acceptConfigurationChanged(['git.autofetch'])
    expect(fired).toEqual([[true, true, true, false, false]])
    service.acceptConfigurationChanged(['git'])
    expect(fired[1]).toEqual([true, true, true, false, false])
    // An empty change set never fires.
    service.acceptConfigurationChanged([])
    expect(fired).toHaveLength(2)
  })

  it('createFileSystemWatcher wires the registry and relays matched events', () => {
    const mt = recordingMainThread()
    const subscribed: string[] = []
    const fileEvents: IMainThreadFileEvents = {
      $subscribeFileEvents: () => {
        subscribed.push('sub')
        return Promise.resolve()
      },
      $unsubscribeFileEvents: () => {
        subscribed.push('unsub')
        return Promise.resolve()
      },
    }
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fileEvents,
    )
    const watcher = service.createFileSystemWatcher('**/*.ts', false, false, false)
    expect(watcher.ignoreCreateEvents).toBe(false)
    expect(subscribed).toEqual(['sub'])

    const seen: string[] = []
    watcher.onDidChange((u) => seen.push(u.path ?? ''))
    service.acceptFileEvents([
      { type: 'changed', uri: URI.file('/ws/src/a.ts').toJSON() },
      { type: 'changed', uri: URI.file('/ws/src/a.md').toJSON() },
    ])
    expect(seen).toEqual(['/ws/src/a.ts'])

    watcher.dispose()
    expect(subscribed).toEqual(['sub', 'unsub'])
    service.dispose()
  })

  it('dispose() flips diagnostics interest back off for still-attached listeners', () => {
    const mt = recordingMainThread()
    const flips: Array<'sub' | 'unsub'> = []
    const languages = {
      $subscribeDiagnostics: () => {
        flips.push('sub')
        return Promise.resolve()
      },
      $unsubscribeDiagnostics: () => {
        flips.push('unsub')
        return Promise.resolve()
      },
    } as unknown as IMainThreadLanguages
    const service = new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
      noopTimeline,
      '/ws',
      undefined,
      undefined,
      languages,
    )
    service.onDidChangeDiagnostics(() => {})
    expect(flips).toEqual(['sub'])

    service.dispose()
    expect(flips).toEqual(['sub', 'unsub'])
  })
})
