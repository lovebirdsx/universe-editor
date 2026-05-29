/*---------------------------------------------------------------------------------------------
 * Integration: per-window workspace isolation (core regression for the per-window refactor).
 * Two windows share the GLOBAL state.json and the recent-workspaces singleton, but each owns
 * an independent MainStorageService (WORKSPACE backend) + WorkspaceMainService. Opening a
 * folder in one window must NOT change the other window's current workspace, yet the recent
 * list — being global — must update on both.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'
import { createStorage } from '../../src/main/storage.js'
import { MainStorageService } from '../../src/main/services/storage/storageMainService.js'
import { RecentWorkspacesMainService } from '../../src/main/services/workspace/recentWorkspacesMainService.js'
import { WorkspaceMainService } from '../../src/main/services/workspace/workspaceMainService.js'

const noopDialog = { showOpenFolderDialog: vi.fn(async () => null) }

interface TwoWindows {
  readonly userDataDir: string
  readonly recents: RecentWorkspacesMainService
  readonly storage1: MainStorageService
  readonly workspace1: WorkspaceMainService
  readonly storage2: MainStorageService
  readonly workspace2: WorkspaceMainService
  dispose(): Promise<void>
}

async function createTwoWindows(): Promise<TwoWindows> {
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'ue-perwindow-'))
  vi.mocked(app.getPath).mockReturnValue(userDataDir)

  // Single GLOBAL backend shared by both windows (mirrors getDefaultStorage()).
  const globalStorage = createStorage(join(userDataDir, 'state.json'))
  const recents = new RecentWorkspacesMainService(globalStorage)

  const storage1 = new MainStorageService(globalStorage)
  const workspace1 = new WorkspaceMainService(storage1, recents, noopDialog)
  const storage2 = new MainStorageService(globalStorage)
  const workspace2 = new WorkspaceMainService(storage2, recents, noopDialog)

  return {
    userDataDir,
    recents,
    storage1,
    workspace1,
    storage2,
    workspace2,
    async dispose() {
      workspace1.dispose()
      workspace2.dispose()
      recents.dispose()
      await storage1.flush()
      await storage2.flush()
      await fs.rm(userDataDir, { recursive: true, force: true })
    },
  }
}

describe('workspace.perWindowIsolation (integration)', () => {
  let wb: TwoWindows

  beforeEach(async () => {
    wb = await createTwoWindows()
  })

  afterEach(async () => {
    await wb.dispose()
    vi.clearAllMocks()
  })

  it('opening a folder in window1 does not change window2 current workspace', async () => {
    const folderA = URI.file(wb.userDataDir + '/alpha')
    await wb.workspace1.openFolder(folderA)

    expect((await wb.workspace1.getCurrent())?.folder.toString()).toBe(folderA.toString())
    expect(await wb.workspace2.getCurrent()).toBeNull()
  })

  it('onDidChangeWorkspace fires only on the window that opened the folder', async () => {
    const events1: (string | null)[] = []
    const events2: (string | null)[] = []
    wb.workspace1.onDidChangeWorkspace((w) => events1.push(w?.folder.toString() ?? null))
    wb.workspace2.onDidChangeWorkspace((w) => events2.push(w?.folder.toString() ?? null))

    const folderA = URI.file(wb.userDataDir + '/alpha')
    await wb.workspace1.openFolder(folderA)

    expect(events1).toEqual([folderA.toString()])
    expect(events2).toEqual([])
  })

  it('two windows can hold different current workspaces simultaneously', async () => {
    const folderA = URI.file(wb.userDataDir + '/alpha')
    const folderB = URI.file(wb.userDataDir + '/beta')
    await wb.workspace1.openFolder(folderA)
    await wb.workspace2.openFolder(folderB)

    expect((await wb.workspace1.getCurrent())?.folder.toString()).toBe(folderA.toString())
    expect((await wb.workspace2.getCurrent())?.folder.toString()).toBe(folderB.toString())
  })

  it('the recent list is shared: both windows see folders opened in either', async () => {
    const recentEvents2: number[] = []
    wb.workspace2.onDidChangeRecent((r) => recentEvents2.push(r.length))

    const folderA = URI.file(wb.userDataDir + '/alpha')
    const folderB = URI.file(wb.userDataDir + '/beta')
    await wb.workspace1.openFolder(folderA)
    await wb.workspace2.openFolder(folderB)

    const recent1 = await wb.workspace1.getRecent()
    const recent2 = await wb.workspace2.getRecent()
    expect(recent1.map((r) => r.folder.toString())).toEqual([
      folderB.toString(),
      folderA.toString(),
    ])
    expect(recent2.map((r) => r.folder.toString())).toEqual([
      folderB.toString(),
      folderA.toString(),
    ])
    // window2 relays the shared recent change for both opens.
    expect(recentEvents2).toEqual([1, 2])
  })

  it('WORKSPACE-scope writes stay isolated per window', async () => {
    const { StorageScope } = await import('@universe-editor/platform')
    const folderA = URI.file(wb.userDataDir + '/alpha')
    const folderB = URI.file(wb.userDataDir + '/beta')
    await wb.workspace1.openFolder(folderA)
    await wb.workspace2.openFolder(folderB)

    await wb.storage1.set('view.state', 'from-window-1', StorageScope.WORKSPACE)
    await wb.storage2.set('view.state', 'from-window-2', StorageScope.WORKSPACE)

    expect(await wb.storage1.get('view.state', StorageScope.WORKSPACE)).toBe('from-window-1')
    expect(await wb.storage2.get('view.state', StorageScope.WORKSPACE)).toBe('from-window-2')
  })
})
