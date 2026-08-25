import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  REMOTE_SCHEME,
  ServiceCollection,
  UriIdentityService,
  URI,
  registerAction2,
  type HostPlatform,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  CopyFileNameAction,
  CopyFilePathAction,
  CopyFileRelativePathAction,
} from '../fileCopyActions.js'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'

const noExplorerSelection = {
  selection: [] as readonly URI[],
  isRoot: () => false,
} as unknown as ExplorerTreeService

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly IRecentWorkspace[]>().event
  readonly recent: readonly IRecentWorkspace[] = []
  readonly whenReady: Promise<void> = Promise.resolve()

  constructor(readonly current: IWorkspace | null) {}

  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

function stubClipboard() {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  return writeText
}

function remoteUri(path: string): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority: 'wsl+ubuntu-24.04', path })
}

async function runCopyAction(
  commandId: string,
  workspace: IWorkspaceServiceType,
  target: URI,
  explorer: ExplorerTreeService = noExplorerSelection,
  platform: HostPlatform = 'win32',
): Promise<void> {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IUriIdentityService, new UriIdentityService(platform))
  services.set(IExplorerTreeService, explorer)
  const inst = new InstantiationService(services)
  const cmd = CommandsRegistry.getCommand(commandId)
  if (!cmd) throw new Error(`${commandId} is not registered`)
  await inst.invokeFunction((accessor) => cmd.handler(accessor, { target }))
}

async function runCopyRelativePath(workspace: IWorkspaceServiceType, target: URI): Promise<void> {
  return runCopyAction(CopyFileRelativePathAction.ID, workspace, target)
}

describe('fileCopyActions', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(CopyFileNameAction))
    disposables.push(registerAction2(CopyFilePathAction))
    disposables.push(registerAction2(CopyFileRelativePathAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.unstubAllGlobals()
  })

  it('copies a workspace-relative path when Windows drive-letter casing differs', async () => {
    const writeText = stubClipboard()
    const workspace = new FakeWorkspaceService({
      folder: URI.from({ scheme: 'file', path: '/D:/repo' }),
      name: 'repo',
    })

    await runCopyRelativePath(
      workspace,
      URI.from({ scheme: 'file', path: '/d:/repo/src/index.ts' }),
    )

    expect(writeText).toHaveBeenCalledWith('src/index.ts')
  })

  it('copies every selected relative path (newline-joined) on multi-select', async () => {
    const writeText = stubClipboard()
    const root = URI.from({ scheme: 'file', path: '/D:/repo' })
    const a = URI.from({ scheme: 'file', path: '/D:/repo/src/a.ts' })
    const b = URI.from({ scheme: 'file', path: '/D:/repo/src/b.ts' })
    const explorer = {
      selection: [a, b] as readonly URI[],
      isRoot: (uri: URI) => uri.toString() === root.toString(),
    } as unknown as ExplorerTreeService

    const services = new ServiceCollection()
    services.set(IWorkspaceService, new FakeWorkspaceService({ folder: root, name: 'repo' }))
    services.set(IUriIdentityService, new UriIdentityService('win32'))
    services.set(IExplorerTreeService, explorer)
    const inst = new InstantiationService(services)
    const cmd = CommandsRegistry.getCommand(CopyFileRelativePathAction.ID)!
    // Invoked on `a`, which is part of the selection → acts on the whole selection.
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target: a }))

    expect(writeText).toHaveBeenCalledWith('src/a.ts\nsrc/b.ts')
  })

  it('copies the remote host path for a POSIX remote (Copy Path)', async () => {
    const writeText = stubClipboard()

    await runCopyAction(
      CopyFilePathAction.ID,
      new FakeWorkspaceService(null),
      remoteUri('/home/u/repo/a.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('/home/u/repo/a.ts')
  })

  it('renders a Windows remote canonical path natively (Copy Path)', async () => {
    const writeText = stubClipboard()

    await runCopyAction(
      CopyFilePathAction.ID,
      new FakeWorkspaceService(null),
      remoteUri('/C:/repo/a.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('C:\\repo\\a.ts')
  })

  it('copies every selected remote path (newline-joined) on multi-select', async () => {
    const writeText = stubClipboard()
    const a = remoteUri('/home/u/repo/src/a.ts')
    const b = remoteUri('/home/u/repo/src/b.ts')
    const explorer = {
      selection: [a, b] as readonly URI[],
      isRoot: () => false,
    } as unknown as ExplorerTreeService

    await runCopyAction(CopyFilePathAction.ID, new FakeWorkspaceService(null), a, explorer)

    expect(writeText).toHaveBeenCalledWith('/home/u/repo/src/a.ts\n/home/u/repo/src/b.ts')
  })

  // Default platform is the WSL-on-Windows client, where the remote scheme has no
  // renderer-side case policy (it is registered main-side only) and comparison
  // folds to the host's case-insensitive one.
  it('copies the remote path relative to the remote workspace root', async () => {
    const writeText = stubClipboard()
    const root = remoteUri('/home/u/repo')
    const workspace = new FakeWorkspaceService({ folder: root, name: 'repo' })

    await runCopyAction(
      CopyFileRelativePathAction.ID,
      workspace,
      remoteUri('/home/u/repo/src/index.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('src/index.ts')
  })

  it('copies the remote path relative to the root on a case-sensitive client', async () => {
    const writeText = stubClipboard()
    const root = remoteUri('/home/u/repo')
    const workspace = new FakeWorkspaceService({ folder: root, name: 'repo' })

    await runCopyAction(
      CopyFileRelativePathAction.ID,
      workspace,
      remoteUri('/home/u/repo/src/index.ts'),
      noExplorerSelection,
      'linux',
    )

    expect(writeText).toHaveBeenCalledWith('src/index.ts')
  })

  // A Windows client folds the comparison to case-insensitive even though the
  // remote host is POSIX. The result is still a suffix of the file's own path, so
  // the leniency never yields a path that differs from what the user clicked.
  it('matches the remote root case-insensitively on a Windows client', async () => {
    const writeText = stubClipboard()
    const workspace = new FakeWorkspaceService({ folder: remoteUri('/home/u/Repo'), name: 'Repo' })

    await runCopyAction(
      CopyFileRelativePathAction.ID,
      workspace,
      remoteUri('/home/u/repo/src/index.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('src/index.ts')
  })

  it('falls back to the display path when the workspace root is local but the file is remote', async () => {
    const writeText = stubClipboard()
    const workspace = new FakeWorkspaceService({
      folder: URI.from({ scheme: 'file', path: '/home/u/repo' }),
      name: 'repo',
    })

    await runCopyAction(
      CopyFileRelativePathAction.ID,
      workspace,
      remoteUri('/home/u/repo/src/index.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('/home/u/repo/src/index.ts')
  })

  it('falls back to the display path without a workspace', async () => {
    const writeText = stubClipboard()

    await runCopyAction(
      CopyFileRelativePathAction.ID,
      new FakeWorkspaceService(null),
      remoteUri('/home/u/repo/src/index.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('/home/u/repo/src/index.ts')
  })

  it('copies the basename of a Windows remote path (Copy Name)', async () => {
    const writeText = stubClipboard()

    await runCopyAction(
      CopyFileNameAction.ID,
      new FakeWorkspaceService(null),
      remoteUri('/C:/foo/bar.ts'),
    )

    expect(writeText).toHaveBeenCalledWith('bar.ts')
  })
})
