import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  UriIdentityService,
  URI,
  registerAction2,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { CopyFileRelativePathAction } from '../fileCopyActions.js'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'

const noExplorerSelection = {
  selection: [] as readonly URI[],
  isRoot: () => false,
} as unknown as import('../../services/explorer/ExplorerTreeService.js').ExplorerTreeService

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

async function runCopyRelativePath(workspace: IWorkspaceServiceType, target: URI): Promise<void> {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IUriIdentityService, new UriIdentityService('win32'))
  services.set(IExplorerTreeService, noExplorerSelection)
  const inst = new InstantiationService(services)
  const cmd = CommandsRegistry.getCommand(CopyFileRelativePathAction.ID)
  if (!cmd) throw new Error(`${CopyFileRelativePathAction.ID} is not registered`)
  await inst.invokeFunction((accessor) => cmd.handler(accessor, { target }))
}

describe('fileCopyActions', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
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
    } as unknown as import('../../services/explorer/ExplorerTreeService.js').ExplorerTreeService

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
})
