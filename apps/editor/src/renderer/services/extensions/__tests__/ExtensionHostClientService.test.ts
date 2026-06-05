/*---------------------------------------------------------------------------------------------
 *  Regression test: HostConnection must be _register-ed in ExtensionHostClientService
 *  so that service.dispose() cascades the release. A connection that is only stored in
 *  _byHandle (Map) but not in the Disposable _store would be silently leaked at shutdown.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  type ICommandService,
  type IDialogService,
  type IFileService,
  type ILoggerService,
  type INotificationService,
  type IOutputService,
  type IQuickInputService,
  type IStatusBarService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type { IExtensionHostService } from '../../../../shared/ipc/extensionHostService.js'
import type { IAcpPathPolicy } from '../../acp/acpPathPolicy.js'
import type { IScmService } from '../ScmService.js'

// Replace HostConnection with a minimal tracked fake so we can assert disposal
// without relying on prototype-chain spy interception of inherited Disposable.dispose.
const disposed: string[] = []
vi.mock('../HostConnection.js', () => {
  class FakeHostConnection {
    commands = {}
    extensions = { $getContributions: vi.fn().mockResolvedValue([]) }
    readonly dead = false
    markDead(): void {}
    dispose(): void {
      disposed.push('disposed')
    }
  }
  return { HostConnection: FakeHostConnection }
})

const { ExtensionHostClientService } = await import('../ExtensionHostClientService.js')

function fakeHost(): IExtensionHostService {
  return {
    onExit: Event.None,
    onStdout: Event.None,
    onStderr: Event.None,
    start: vi.fn().mockResolvedValue({ handle: 'h1' }),
    hasUserExtensions: vi.fn().mockResolvedValue(false),
    writeStdin: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as IExtensionHostService
}

function makeService(host: IExtensionHostService) {
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
    {} as IScmService,
    {
      onDidChangeWorkspace: Event.None,
      whenReady: Promise.resolve(),
      current: undefined,
    } as unknown as IWorkspaceService,
    {} as IFileService,
    {} as IAcpPathPolicy,
    {} as ICommandService,
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
})
