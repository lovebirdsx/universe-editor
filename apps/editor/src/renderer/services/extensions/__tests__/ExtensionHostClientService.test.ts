/*---------------------------------------------------------------------------------------------
 *  ExtensionHostClientService regressions:
 *  1. HostConnection must be _register-ed so service.dispose() cascades the release.
 *     A connection only stored in _byHandle (Map) would be silently leaked at shutdown.
 *  2. A workspace-swap restart must re-emit the merged contributions via
 *     onDidChangeContributions, so the translator can re-register contributed commands
 *     that a restart racing the initial boot would otherwise drop.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  type IAiModelService,
  type ICommandService,
  type IDialogService,
  type IEditorService,
  type IFileService,
  type ILayoutService,
  type ILoggerService,
  type INotificationService,
  type IOutputService,
  type IQuickInputService,
  type IStatusBarService,
  type IStorageService,
  type IViewsService,
  type IWorkspaceService,
  type IWorkspaceTrustManagementService,
  UriIdentityService,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import type { IExtensionHostService } from '../../../../shared/ipc/extensionHostService.js'
import type { IExtensionManagementService } from '../../../../shared/ipc/extensionManagementService.js'
import type { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'
import type { IAcpPathPolicy } from '../../acp/acpPathPolicy.js'
import type { IScmService } from '../ScmService.js'
import type { IWebviewService } from '../WebviewService.js'
import type { IExtensionEnablementService } from '../ExtensionEnablementService.js'

const CONTRIBUTIONS: IExtensionDescriptionDto[] = [
  {
    id: 'universe.ai',
    name: 'ai',
    activationEvents: ['onCommand:ai.generateCommitMessage'],
    contributes: { commands: [{ command: 'ai.generateCommitMessage', title: 'Generate' }] },
    hasMain: true,
  },
]

// Replace HostConnection with a minimal tracked fake so we can assert disposal +
// drive the restart path without prototype-chain spying on inherited Disposable.dispose.
const disposed: string[] = []
vi.mock('../HostConnection.js', () => {
  class FakeHostConnection {
    readonly kind: string
    readonly handle: string
    dead = false
    commands = {
      $executeContributedCommand: vi.fn().mockImplementation(() => Promise.resolve(this.handle)),
    }
    extensions = {
      $getContributions: vi.fn().mockResolvedValue(CONTRIBUTIONS),
      $activateByEvent: vi.fn().mockResolvedValue(undefined),
      $initializeWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
      $onDidGrantWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
    }
    constructor(kind: string, handle: string) {
      this.kind = kind
      this.handle = handle
    }
    markDead(): void {
      this.dead = true
    }
    dispose(): void {
      disposed.push(this.handle)
    }
  }
  return { HostConnection: FakeHostConnection }
})

const { ExtensionHostClientService } = await import('../ExtensionHostClientService.js')

function fakeHost(): IExtensionHostService {
  let n = 0
  return {
    onExit: Event.None,
    onStdout: Event.None,
    onStderr: Event.None,
    start: vi.fn().mockImplementation(() => Promise.resolve({ handle: `h${++n}` })),
    hasUserExtensions: vi.fn().mockResolvedValue(false),
    writeStdin: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as IExtensionHostService
}

function makeService(host: IExtensionHostService, workspaceChange = Event.None) {
  return makeServiceWith(host, vi.fn(), workspaceChange)
}

function makeServiceWith(
  host: IExtensionHostService,
  resetSourceControls: () => void,
  workspaceChange = Event.None,
) {
  const nullLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }
  return new ExtensionHostClientService(
    host,
    { createChannel: vi.fn().mockReturnValue({ append: vi.fn() }) } as unknown as IOutputService,
    { createLogger: vi.fn().mockReturnValue(nullLogger) } as unknown as ILoggerService,
    {} as INotificationService,
    {} as IQuickInputService,
    {} as IStatusBarService,
    {} as IDialogService,
    { resetSourceControls } as unknown as IScmService,
    {
      setExtHost: vi.fn(),
      createMainThread: vi.fn(),
      reset: vi.fn(),
    } as unknown as IWebviewService,
    {
      onDidChangeWorkspace: workspaceChange,
      whenReady: Promise.resolve(),
      current: undefined,
    } as unknown as IWorkspaceService,
    {} as IFileService,
    {} as IAcpPathPolicy,
    {} as ICommandService,
    {} as ILanguageFeaturesService,
    {} as IEditorService,
    {} as IAiModelService,
    {} as IStorageService,
    {} as ILayoutService,
    {} as IViewsService,
    new UriIdentityService('linux'),
    {
      getDisabledIds: vi.fn().mockResolvedValue([]),
      getInstalled: vi.fn().mockResolvedValue([]),
      listBuiltinExtensions: vi.fn().mockResolvedValue([]),
    } as unknown as IExtensionManagementService,
    {
      onDidChangeEnablement: Event.None,
      getEffectiveDisabledIds: vi.fn().mockResolvedValue([]),
    } as unknown as IExtensionEnablementService,
    {
      onDidChangeTrust: Event.None,
      workspaceTrustInitialized: Promise.resolve(),
      isWorkspaceTrusted: () => true,
    } as unknown as IWorkspaceTrustManagementService,
  )
}

describe('ExtensionHostClientService', () => {
  it('cascades dispose to HostConnection when the service is disposed', async () => {
    disposed.length = 0
    const host = fakeHost()
    const svc = makeService(host)

    await svc.start()
    expect(host.start).toHaveBeenCalledOnce()
    expect(disposed).toHaveLength(0)

    svc.dispose()
    expect(disposed).toHaveLength(1)
  })

  it('re-emits contributions after a workspace-swap restart', async () => {
    disposed.length = 0
    const host = fakeHost()
    const workspaceChange = new Emitter<void>()
    const svc = makeService(host, workspaceChange.event)

    await svc.start()
    const seen: (readonly IExtensionDescriptionDto[])[] = []
    svc.onDidChangeContributions((c) => seen.push(c))

    workspaceChange.fire()
    // Let the async restart chain (stop → relaunch → fetch → emit) settle.
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    expect(seen[0]).toEqual(CONTRIBUTIONS)
    // The old connection was torn down and a fresh one launched.
    expect(disposed).toContain('h1')
    expect(host.stop).toHaveBeenCalledWith('h1')
    expect(host.start).toHaveBeenCalledTimes(2)

    svc.dispose()
  })

  it('relaunches the host when a workspace swap races the initial spawn', async () => {
    // Regression: a swap fired while the first `host.start` is still pending must
    // not be dropped. Before the fix `_onWorkspaceChanged` read `this._conn`
    // (still undefined mid-spawn), saw no live host, and silently skipped the
    // relaunch — leaving the host pinned to the launch-time (empty) workspace, so
    // git never registered its SCM provider (Windows-CI-only flake, slow spawn).
    disposed.length = 0
    let releaseFirstStart!: () => void
    const firstStarted = new Promise<void>((r) => (releaseFirstStart = r))
    let n = 0
    const host = {
      onExit: Event.None,
      onStdout: Event.None,
      onStderr: Event.None,
      start: vi.fn().mockImplementation(() => {
        n++
        // Hold the initial trusted spawn open so the swap lands mid-flight.
        if (n === 1) return firstStarted.then(() => ({ handle: `h${n}` }))
        return Promise.resolve({ handle: `h${n}` })
      }),
      hasUserExtensions: vi.fn().mockResolvedValue(false),
      writeStdin: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionHostService
    const workspaceChange = new Emitter<void>()
    const svc = makeService(host, workspaceChange.event)

    const starting = svc.start()
    // Swap arrives before the first spawn resolves: `this._trusted` is unset.
    workspaceChange.fire()
    releaseFirstStart()
    await starting

    // The relaunch must still happen: original tier stopped, a fresh one spawned.
    await vi.waitFor(() => expect(host.start).toHaveBeenCalledTimes(2))
    expect(host.stop).toHaveBeenCalledWith('h1')

    svc.dispose()
  })

  it('blocks a command racing a workspace swap until the host is re-pinned', async () => {
    // Regression (Windows-CI-only flake): a command firing on the same turn as a
    // workspace swap — e.g. the markdown update-links-on-rename flush debounced off
    // the file-operation burst that swapped the workspace — must not execute against
    // the host still pinned to the previous (empty) workspace, whose workspace scan
    // returns nothing. `_whenReady` must drain the re-pin barrier first, so the
    // command lands on the freshly re-pinned host (h2), not the torn-down one (h1).
    disposed.length = 0
    let releaseStop!: () => void
    const stopped = new Promise<void>((r) => (releaseStop = r))
    let n = 0
    const host = {
      onExit: Event.None,
      onStdout: Event.None,
      onStderr: Event.None,
      start: vi.fn().mockImplementation(() => Promise.resolve({ handle: `h${++n}` })),
      hasUserExtensions: vi.fn().mockResolvedValue(false),
      writeStdin: vi.fn().mockResolvedValue(undefined),
      // Hold the stop open so the re-pin window is wide, mirroring a slow
      // treeKill of the Electron-as-node host on a contended CI runner.
      stop: vi.fn().mockImplementation(() => stopped),
    } as unknown as IExtensionHostService
    const workspaceChange = new Emitter<void>()
    const svc = makeService(host, workspaceChange.event)

    await svc.start()
    expect(host.start).toHaveBeenCalledTimes(1)

    // Swap fires (arms the barrier synchronously); the command races in immediately.
    workspaceChange.fire()
    const commandResult = svc.executeContributedCommand('ai.generateCommitMessage', [])

    // The stop is still pending, so the command must not have resolved against h1.
    let resolvedEarly = false
    void commandResult.then(() => (resolvedEarly = true))
    await Promise.resolve()
    expect(resolvedEarly).toBe(false)

    // Let the restart complete; the command now runs on the re-pinned host.
    releaseStop()
    await expect(commandResult).resolves.toBe('h2')

    svc.dispose()
  })
})
