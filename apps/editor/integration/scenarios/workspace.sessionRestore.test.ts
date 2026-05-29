/*---------------------------------------------------------------------------------------------
 * Integration: multi-window session restore — the "workspace half" end-to-end.
 * Two windows open different folders and write WORKSPACE-scope data, then the session is
 * serialized into the shared GLOBAL state.json. On "restart" we loadSession() and rebuild a
 * WorkspaceMainService per entry via restoreCurrent(), asserting each window recovers its own
 * current workspace and its own isolated WORKSPACE-scope data.
 *
 * The window/geometry half is covered by the windowsSession + windowMainService unit tests,
 * since the integration env has no real BrowserWindow. We pass null uiState here so loadSession
 * never touches electron `screen` (unmocked in this project).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageScope, URI } from '@universe-editor/platform'
import { createStorage } from '../../src/main/storage.js'
import { MainStorageService } from '../../src/main/services/storage/storageMainService.js'
import { RecentWorkspacesMainService } from '../../src/main/services/workspace/recentWorkspacesMainService.js'
import { WorkspaceMainService } from '../../src/main/services/workspace/workspaceMainService.js'
import { loadSession, serializeWindow } from '../../src/main/windowsSession.js'

const noopDialog = { showOpenFolderDialog: vi.fn(async () => null) }

describe('workspace.sessionRestore (integration)', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'ue-session-'))
    vi.mocked(app.getPath).mockReturnValue(userDataDir)
  })

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('restores each window to its own workspace and isolated WORKSPACE-scope data', async () => {
    const folderA = URI.file(join(userDataDir, 'alpha'))
    const folderB = URI.file(join(userDataDir, 'beta'))

    // --- First "session": two windows, two folders, per-window WORKSPACE writes ---
    {
      const globalStorage = createStorage(join(userDataDir, 'state.json'))
      const recents = new RecentWorkspacesMainService(globalStorage)

      const storage1 = new MainStorageService(globalStorage)
      const workspace1 = new WorkspaceMainService(storage1, recents, noopDialog)
      const storage2 = new MainStorageService(globalStorage)
      const workspace2 = new WorkspaceMainService(storage2, recents, noopDialog)

      await workspace1.openFolder(folderA)
      await workspace2.openFolder(folderB)
      await storage1.set('view.state', 'A-data', StorageScope.WORKSPACE)
      await storage2.set('view.state', 'B-data', StorageScope.WORKSPACE)

      // Persist the session list to the shared GLOBAL backend (what WindowMainService does).
      const session = [
        serializeWindow(workspace1.current, null, false),
        serializeWindow(workspace2.current, null, true),
      ]
      await globalStorage.set('workbench.windowsState', session)

      workspace1.dispose()
      workspace2.dispose()
      recents.dispose()
      await storage1.flush()
      await storage2.flush()
      await globalStorage.flush()
    }

    // --- "Restart": fresh backend reads the persisted session and rebuilds each window ---
    const globalStorage2 = createStorage(join(userDataDir, 'state.json'))
    const recents2 = new RecentWorkspacesMainService(globalStorage2)
    const restored = await loadSession(globalStorage2)

    expect(restored).toHaveLength(2)
    expect(restored[0]?.workspace?.folder.toString()).toBe(folderA.toString())
    expect(restored[0]?.devToolsOpen).toBe(false)
    expect(restored[1]?.workspace?.folder.toString()).toBe(folderB.toString())
    expect(restored[1]?.devToolsOpen).toBe(true)

    const rebuilt = await Promise.all(
      restored.map(async (entry) => {
        const storage = new MainStorageService(globalStorage2)
        const workspace = new WorkspaceMainService(storage, recents2, noopDialog)
        if (entry.workspace) await workspace.restoreCurrent(entry.workspace)
        return { storage, workspace }
      }),
    )

    const [win1, win2] = rebuilt

    expect((await win1?.workspace.getCurrent())?.folder.toString()).toBe(folderA.toString())
    expect((await win2?.workspace.getCurrent())?.folder.toString()).toBe(folderB.toString())

    // Each window's WORKSPACE-scope data is restored and stays isolated.
    expect(await win1?.storage.get('view.state', StorageScope.WORKSPACE)).toBe('A-data')
    expect(await win2?.storage.get('view.state', StorageScope.WORKSPACE)).toBe('B-data')

    for (const { storage, workspace } of rebuilt) {
      workspace.dispose()
      await storage.flush()
    }
    recents2.dispose()
  })
})
