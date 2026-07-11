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
    commands = { $executeContributedCommand: vi.fn().mockResolvedValue(undefined) }
    extensions = {
      $getContributions: vi.fn().mockResolvedValue(CONTRIBUTIONS),
      $activateByEvent: vi.fn().mockResolvedValue(undefined),
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
    // The old trusted connection was torn down and a fresh one launched.
    expect(disposed).toContain('h1')
    expect(host.stop).toHaveBeenCalledWith('h1')
    expect(host.start).toHaveBeenCalledTimes(2)

    svc.dispose()
  })

  it('does not wipe SCM providers when the restricted host tears down', async () => {
    // Regression: git + p4 register their SCM providers ONLY on the trusted host
    // (restricted `createSourceControl` throws). `_teardownConnection` reset SCM
    // unconditionally, so tearing down the RESTRICTED tier (its crash, or the
    // restricted leg of a workspace-swap restart that runs after trusted already
    // re-registered) wiped the trusted host's providers — the intermittent
    // "No source control providers registered". Reset must be trusted-only,
    // mirroring the per-tier `webview.reset(kind)`.
    disposed.length = 0
    const resetSourceControls = vi.fn()
    const onExit = new Emitter<{ handle: string; code: number | null; signal: string | null }>()
    const kindByHandle = new Map<string, string>()
    let n = 0
    const host = {
      onExit: onExit.event,
      onStdout: Event.None,
      onStderr: Event.None,
      start: vi.fn().mockImplementation((spec: { kind: string }) => {
        const handle = `h${++n}`
        kindByHandle.set(handle, spec.kind)
        return Promise.resolve({ handle })
      }),
      hasUserExtensions: vi.fn().mockResolvedValue(true),
      writeStdin: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionHostService

    const svc = makeServiceWith(host, resetSourceControls)
    await svc.start()

    const restrictedHandle = [...kindByHandle].find(([, k]) => k === 'restricted')?.[0]
    expect(restrictedHandle).toBeDefined()

    // The restricted host dies (teardown runs the same for a crash or a planned
    // restart leg); a clean code keeps the assertion off the crash-notify path.
    onExit.fire({ handle: restrictedHandle!, code: 0, signal: null })

    // Trusted-owned SCM providers must survive a restricted teardown.
    expect(resetSourceControls).not.toHaveBeenCalled()

    svc.dispose()
  })

  it('relaunches the tier when a workspace swap races the initial spawn', async () => {
    // Regression: a swap fired while the first `host.start` is still pending must
    // not be dropped. Before the fix `_onWorkspaceChanged` read `this._trusted`
    // (still undefined mid-spawn), saw no live tier, and silently skipped the
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
})
