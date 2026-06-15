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
  type ILoggerService,
  type INotificationService,
  type IOutputService,
  type IQuickInputService,
  type IStatusBarService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import type { IExtensionHostService } from '../../../../shared/ipc/extensionHostService.js'
import type { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'
import type { IAcpPathPolicy } from '../../acp/acpPathPolicy.js'
import type { IScmService } from '../ScmService.js'

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
    { resetSourceControls: vi.fn() } as unknown as IScmService,
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
})
