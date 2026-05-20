/*---------------------------------------------------------------------------------------------
 * Integration: WorkspaceMainService + MainStorageService
 * Unlike the unit test (which uses in-memory storage), this scenario exercises the
 * full persistence chain: real storage file on disk → hydrate on a second instance.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { createTestWorkbench, type TestWorkbench } from '../fixtures/createTestWorkbench.js'

describe('workspace.openClose (integration)', () => {
  let wb: TestWorkbench

  beforeEach(async () => {
    wb = await createTestWorkbench()
  })

  afterEach(async () => {
    await wb.dispose()
    vi.clearAllMocks()
  })

  it('openFolder sets current workspace and fires onDidChangeWorkspace', async () => {
    const events: (string | null)[] = []
    wb.workspace.onDidChangeWorkspace((w) => events.push(w?.folder.toString() ?? null))

    const folder = URI.file(wb.userDataDir + '/my-project')
    await wb.workspace.openFolder(folder)

    const current = await wb.workspace.getCurrent()
    expect(current?.folder.toString()).toBe(folder.toString())
    expect(current?.name).toBe('my-project')
    expect(events).toEqual([folder.toString()])
  })

  it('closeFolder clears current and persists null to real storage file', async () => {
    const folder = URI.file(wb.userDataDir + '/proj')
    await wb.workspace.openFolder(folder)
    await wb.workspace.closeFolder()

    // Drain all pending fire-and-forget writes so the file reflects the null current.
    await wb.storage.flush()

    expect(await wb.workspace.getCurrent()).toBeNull()
    // The storage key should have been written as null (not absent)
    const raw = await wb.storage.get('workbench.currentWorkspace')
    expect(raw).toBeNull()
  })

  it('recent list survives app restart: new service hydrates from the same storage file', async () => {
    const { app } = await import('electron')
    const { MainStorageService } =
      await import('../../src/main/services/storage/storageMainService.js')
    const { WorkspaceMainService } =
      await import('../../src/main/services/workspace/workspaceMainService.js')
    const { createStorage } = await import('../../src/main/storage.js')

    // First "session": open 3 folders
    const folderA = URI.file(wb.userDataDir + '/alpha')
    const folderB = URI.file(wb.userDataDir + '/beta')
    const folderC = URI.file(wb.userDataDir + '/gamma')
    await wb.workspace.openFolder(folderA)
    await wb.workspace.openFolder(folderB)
    await wb.workspace.openFolder(folderC)
    // Drain all pending fire-and-forget writes before the second session reads.
    await wb.storage.flush()

    // Second "session": a fresh service reading the same storage file
    vi.mocked(app.getPath).mockReturnValue(wb.userDataDir)
    const storage2 = new MainStorageService(createStorage(wb.userDataDir + '/state.json'))
    const workspace2 = new WorkspaceMainService(storage2, {
      showOpenFolderDialog: vi.fn(async () => null),
    })
    const recent = await workspace2.getRecent()
    workspace2.dispose()

    expect(recent.length).toBe(3)
    expect(recent[0]?.folder.toString()).toBe(folderC.toString())
    expect(recent[1]?.folder.toString()).toBe(folderB.toString())
    expect(recent[2]?.folder.toString()).toBe(folderA.toString())
  })
})
