import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IHostService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IRecentWorkspace,
  type IHostService as IHostServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { CopyFileRelativePathAction } from '../fileCopyActions.js'

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

function makeHostService(): IHostServiceType {
  return {
    _serviceBrand: undefined,
    platform: 'win32',
  } as unknown as IHostServiceType
}

async function runCopyRelativePath(workspace: IWorkspaceServiceType, target: URI): Promise<void> {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IHostService, makeHostService())
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
})
