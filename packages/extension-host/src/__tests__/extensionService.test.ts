import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'
import type { TextEditor, UriComponents } from '@universe-editor/extension-api'
import type {
  IActiveTextEditorDto,
  IMainThreadEditor,
  IMainThreadCommands,
  IMainThreadScm,
  IMainThreadWindow,
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
    const service = new ExtensionService([scanned(['*'])], mt.impl, noopWindow, noopScm)
    expect((globalThis as Record<string, unknown>).__universeExtensionHostBridge__).toBe(service)
  })

  it('exposes static contributions as DTOs', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['onCommand:test.cmd'])],
      mt.impl,
      noopWindow,
      noopScm,
    )
    const dtos = service.getContributions()
    expect(dtos).toHaveLength(1)
    expect(dtos[0]?.activationEvents).toEqual(['onCommand:test.cmd'])
    expect(dtos[0]?.contributes.commands?.[0]?.command).toBe('test.cmd')
  })

  it('does not activate until a matching event fires', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService(
      [scanned(['onCommand:test.cmd'])],
      mt.impl,
      noopWindow,
      noopScm,
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
    )

    await service.activateByEvent('onCommand:test.cmd')
    await service.activateByEvent('onCommand:test.cmd')
    expect(mt.registered).toEqual(['test.cmd'])
  })

  it('a wildcard extension activates on any event', async () => {
    const mt = recordingMainThread()
    const service = new ExtensionService([scanned(['*'])], mt.impl, noopWindow, noopScm)

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
    const service = new ExtensionService([ext], mt.impl, noopWindow, noopScm)
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
    const service = new ExtensionService([scanned(['*'])], mt.impl, noopWindow, noopScm)
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
      '/repo/root',
    )
    expect(service.getWorkspaceRoot()).toBe('/repo/root')
  })

  it('reports no workspace root when none was provided', () => {
    const mt = recordingMainThread()
    const service = new ExtensionService([scanned(['*'])], mt.impl, noopWindow, noopScm)
    expect(service.getWorkspaceRoot()).toBeUndefined()
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
  }

  function editorService(): ExtensionService {
    const mt = recordingMainThread()
    return new ExtensionService(
      [scanned(['*'])],
      mt.impl,
      noopWindow,
      noopScm,
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
