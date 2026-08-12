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
  IpcChannelDisposedError,
  type IAiModelService,
  type ICommandService,
  type IConfigurationChangeEvent,
  type IConfigurationService,
  type IDialogService,
  type IEditorGroupsService,
  type IEditorService,
  type IFileDialogService,
  type IFileSearchService,
  type IFileService,
  type IFileWatcherService,
  type IHostService,
  type IInstantiationService,
  type ILayoutService,
  type ILoggerService,
  type INotificationService,
  type IOpenerService,
  type IOutputService,
  type IProgressService,
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
import type { IExcludeService } from '../../exclude/ExcludeService.js'
import type { IScmService } from '../ScmService.js'
import type { ITimelineService } from '../../timeline/TimelineService.js'
import type { IWebviewService } from '../WebviewService.js'
import type { IExtensionEnablementService } from '../ExtensionEnablementService.js'

const CONTRIBUTIONS: IExtensionDescriptionDto[] = [
  {
    id: 'universe.ai',
    name: 'ai',
    activationEvents: ['onCommand:ai.generateCommitMessage'],
    contributes: { commands: [{ command: 'ai.generateCommitMessage', title: 'Generate' }] },
    hasMain: true,
    extensionLocation: '/extensions/ai',
    extensionIsBuiltin: true,
  },
]

// Replace HostConnection with a minimal tracked fake so we can assert disposal +
// drive the restart path without prototype-chain spying on inherited Disposable.dispose.
const disposed: string[] = []
const activationCalls: string[] = []
/** Keys pushed via `$acceptConfigurationChanged`, per push, across all fakes. */
const configPushes: string[][] = []
/** Handle whose first `$activateByEvent` stays pending until released (or disposed). */
let holdActivationFor: string | undefined
const activatedOnce = new Set<string>()
const pendingActivations = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()

function releaseActivation(handle: string): void {
  const pending = pendingActivations.get(handle)
  pendingActivations.delete(handle)
  pending?.resolve()
}

vi.mock('../HostConnection.js', () => {
  class FakeHostConnection {
    readonly kind: string
    readonly handle: string
    readonly workspaceRoot: string | undefined
    dead = false
    commands = {
      $executeContributedCommand: vi.fn().mockImplementation(() => Promise.resolve(this.handle)),
    }
    extensions = {
      $getContributions: vi.fn().mockResolvedValue(CONTRIBUTIONS),
      $activateByEvent: vi.fn().mockImplementation(() => {
        activationCalls.push(this.handle)
        if (this.handle === holdActivationFor && !activatedOnce.has(this.handle)) {
          activatedOnce.add(this.handle)
          return new Promise<void>((resolve, reject) => {
            pendingActivations.set(this.handle, { resolve, reject })
          })
        }
        return Promise.resolve()
      }),
      $initializeWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
      $initializeEnvironment: vi.fn().mockResolvedValue(undefined),
      $onDidGrantWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
      $acceptConfigurationChanged: vi.fn().mockImplementation((keys: readonly string[]) => {
        configPushes.push([...keys])
        return Promise.resolve()
      }),
    }
    constructor(kind: string, handle: string, workspaceRoot?: string) {
      this.kind = kind
      this.handle = handle
      this.workspaceRoot = workspaceRoot
    }
    markDead(): void {
      this.dead = true
    }
    dispose(): void {
      disposed.push(this.handle)
      // Mirror ChannelClient.dispose: in-flight requests reject with IpcChannelDisposedError.
      const pending = pendingActivations.get(this.handle)
      if (pending) {
        pendingActivations.delete(this.handle)
        pending.reject(new IpcChannelDisposedError())
      }
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

/** Mutable workspace state a test flips before firing the change event. */
interface WorkspaceState {
  current: { folder: { fsPath: string } } | undefined
}

function makeServiceWith(
  host: IExtensionHostService,
  resetSourceControls: () => void,
  workspaceChange = Event.None,
  trustChange: Event<boolean> = Event.None,
  workspaceState: WorkspaceState = { current: undefined },
  stubs?: {
    effectiveDisabledIds?: string[]
    builtinIds?: string[]
    installedIds?: string[]
  },
  configChange: Event<IConfigurationChangeEvent> = Event.None,
) {
  const nullLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }
  const asLocal = (identifier: string) =>
    ({
      identifier,
      manifest: { name: identifier, version: '1.0.0', engines: { universe: '^0.1.0' } },
      version: '1.0.0',
      location: `/ext/${identifier}`,
      source: 'vsix',
      installedAt: 0,
    }) as const
  return new ExtensionHostClientService(
    host,
    { createChannel: vi.fn().mockReturnValue({ append: vi.fn() }) } as unknown as IOutputService,
    { createLogger: vi.fn().mockReturnValue(nullLogger) } as unknown as ILoggerService,
    {} as INotificationService,
    {} as IQuickInputService,
    {} as IStatusBarService,
    {} as IDialogService,
    { resetSourceControls } as unknown as IScmService,
    { reset: vi.fn() } as unknown as ITimelineService,
    {
      setExtHost: vi.fn(),
      createMainThread: vi.fn(),
      reset: vi.fn(),
    } as unknown as IWebviewService,
    {
      onDidChangeWorkspace: workspaceChange,
      whenReady: Promise.resolve(),
      get current() {
        return workspaceState.current
      },
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
      getInstalled: vi.fn().mockResolvedValue((stubs?.installedIds ?? []).map(asLocal)),
      listBuiltinExtensions: vi.fn().mockResolvedValue((stubs?.builtinIds ?? []).map(asLocal)),
    } as unknown as IExtensionManagementService,
    {
      onDidChangeEnablement: Event.None,
      getEffectiveDisabledIds: vi.fn().mockResolvedValue(stubs?.effectiveDisabledIds ?? []),
    } as unknown as IExtensionEnablementService,
    {
      onDidChangeTrust: trustChange,
      workspaceTrustInitialized: Promise.resolve(),
      isWorkspaceTrusted: () => true,
    } as unknown as IWorkspaceTrustManagementService,
    {
      getVersionInfo: vi
        .fn()
        .mockResolvedValue({ productName: 'Universe Editor', version: '0.0.0' }),
    } as unknown as IHostService,
    { open: vi.fn().mockResolvedValue(false) } as unknown as IOpenerService,
    {} as IProgressService,
    {} as IFileDialogService,
    {} as IEditorGroupsService,
    {} as IInstantiationService,
    { onDidChangeConfiguration: configChange } as unknown as IConfigurationService,
    {} as IFileSearchService,
    {} as IExcludeService,
    {} as IFileWatcherService,
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

  it('never forwards a dev-extension id into the spec disabledIds (owned-set intersection)', async () => {
    // Regression pin: dev extensions (--extension-development-path) are NOT in
    // listBuiltinExtensions() ∪ getInstalled(), so even if enablement reports a
    // dev id as disabled (e.g. the same-id shipped build was disabled), the
    // intersection keeps it out of UNIVERSE_DISABLED_EXTENSIONS and the dev
    // copy still activates. The host-side filter also exempts dev extensions;
    // this test guards the renderer side from future refactors folding dev
    // extensions into the owned set without thinking.
    const host = fakeHost()
    const svc = makeServiceWith(
      host,
      vi.fn(),
      Event.None,
      Event.None,
      { current: undefined },
      {
        effectiveDisabledIds: ['dev.iterating', 'shipped.disabled'],
        builtinIds: ['shipped.disabled'],
      },
    )

    await svc.start()
    const spec = vi.mocked(host.start).mock.calls[0]?.[0]
    expect(spec?.disabledIds).toEqual(['shipped.disabled'])

    svc.dispose()
  })

  it('re-emits contributions after a workspace-swap restart', async () => {
    disposed.length = 0
    const host = fakeHost()
    const workspaceChange = new Emitter<void>()
    const ws: WorkspaceState = { current: undefined }
    const svc = makeServiceWith(host, vi.fn(), workspaceChange.event, Event.None, ws)

    await svc.start()
    const seen: (readonly IExtensionDescriptionDto[])[] = []
    svc.onDidChangeContributions((c) => seen.push(c))

    ws.current = { folder: { fsPath: '/new-ws' } }
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
    const ws: WorkspaceState = { current: undefined }
    const svc = makeServiceWith(host, vi.fn(), workspaceChange.event, Event.None, ws)

    const starting = svc.start()
    // Let `_connect` pass its workspaceRoot read first so the in-flight spawn is
    // pinned to the launch-time (empty) workspace — the swap below must land as
    // "spec already settled", otherwise the new same-source skip would (rightly)
    // see the host pinned to the NEW workspace and there'd be nothing to relaunch.
    await Promise.resolve()
    workspaceChange.fire()
    ws.current = { folder: { fsPath: '/new-ws' } }
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
    const ws: WorkspaceState = { current: undefined }
    const svc = makeServiceWith(host, vi.fn(), workspaceChange.event, Event.None, ws)

    await svc.start()
    expect(host.start).toHaveBeenCalledTimes(1)

    // Swap fires (arms the barrier synchronously); the command races in immediately.
    ws.current = { folder: { fsPath: '/new-ws' } }
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

  it('does not surface an unhandled rejection when a trust flip races a workspace-swap restart', async () => {
    // Regression: the swap's restart was mid-`$activateByEvent` (in-flight RPC on
    // the freshly spawned h2) when the trust flip entered its own restart — it
    // only awaited the memoized `_starting`, which had already resolved. The
    // second restart tore h2 down, ChannelClient.dispose rejected the pending
    // activation with IpcChannelDisposedError, and the first restart's rejection
    // escaped through `_repin`'s fire-and-forget chain as an unhandled rejection:
    // "IPC channel disposed before response".
    disposed.length = 0
    activationCalls.length = 0
    activatedOnce.clear()
    pendingActivations.clear()
    holdActivationFor = undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const host = fakeHost()
      const workspaceChange = new Emitter<void>()
      const trustChange = new Emitter<boolean>()
      const ws: WorkspaceState = { current: undefined }
      const svc = makeServiceWith(host, vi.fn(), workspaceChange.event, trustChange.event, ws)

      await svc.start()
      expect(host.start).toHaveBeenCalledTimes(1)

      // Restart#1 (workspace swap) hangs inside its first startup-activation RPC on h2.
      holdActivationFor = 'h2'
      ws.current = { folder: { fsPath: '/new-ws' } }
      workspaceChange.fire()
      await vi.waitFor(() => expect(activationCalls).toContain('h2'))

      // Restart#2 (trust revoked) arrives while h2's activation is still in flight.
      trustChange.fire(false)
      await new Promise((r) => setTimeout(r, 0))

      // Unblock h2's activation; both restarts can now run to completion.
      releaseActivation('h2')
      await vi.waitFor(() => expect(host.start).toHaveBeenCalledTimes(3))

      // Flush the microtask queue so any escaped rejection would have been reported.
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).toEqual([])
      expect(disposed).toContain('h1')
      expect(disposed).toContain('h2')

      svc.dispose()
    } finally {
      holdActivationFor = undefined
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('skips the re-pin restart when the live host is already pinned to the current workspace', async () => {
    // The app was launched with the folder as a positional arg, so the first host
    // spawned already pinned to it; the boot-time workspace event (hydrate
    // null → folder) must NOT kill + respawn the host — that restart is the race
    // window behind flaky LSP-provider polls and dying-host Disposable leaks in
    // e2e.
    disposed.length = 0
    const host = fakeHost()
    const workspaceChange = new Emitter<void>()
    const ws: WorkspaceState = { current: { folder: { fsPath: '/ws' } } }
    const svc = makeServiceWith(host, vi.fn(), workspaceChange.event, Event.None, ws)

    await svc.start()
    expect(host.start).toHaveBeenCalledOnce()

    workspaceChange.fire()
    await new Promise((r) => setTimeout(r, 10))
    expect(host.start).toHaveBeenCalledOnce()
    expect(host.stop).not.toHaveBeenCalled()
    expect(disposed).toHaveLength(0)

    svc.dispose()
  })

  it('forwards configuration changes to the live host only', async () => {
    // `workspace.onDidChangeConfiguration`: renderer config changes are pushed to
    // the host with the changed keys; changes before a connection exists are lost
    // (the host re-reads current values on (re)start anyway).
    configPushes.length = 0
    const host = fakeHost()
    const configChange = new Emitter<IConfigurationChangeEvent>()
    const svc = makeServiceWith(
      host,
      vi.fn(),
      Event.None,
      Event.None,
      { current: undefined },
      undefined,
      configChange.event,
    )

    // No host yet — dropped silently.
    configChange.fire({ keys: ['early.key'], affectsConfiguration: () => true })
    await new Promise((r) => setTimeout(r, 10))
    expect(configPushes).toEqual([])

    await svc.start()
    configChange.fire({
      keys: ['editor.fontSize', 'files.exclude'],
      affectsConfiguration: () => true,
    })
    await vi.waitFor(() => expect(configPushes).toEqual([['editor.fontSize', 'files.exclude']]))

    svc.dispose()
  })
})
