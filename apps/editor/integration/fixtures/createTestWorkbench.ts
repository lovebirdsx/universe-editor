import { vi } from 'vitest'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../../src/main/storage.js'
import { LogMainService } from '../../src/main/services/log/logMainService.js'
import { LogFilesMainService } from '../../src/main/services/log/logFilesMainService.js'
import { MainStorageService } from '../../src/main/services/storage/storageMainService.js'
import { FileSystemMainService } from '../../src/main/services/files/fileSystemMainService.js'
import { FileWatcherMainService } from '../../src/main/services/fileWatcher/fileWatcherMainService.js'
import { WorkspaceMainService } from '../../src/main/services/workspace/workspaceMainService.js'
import { RecentWorkspacesMainService } from '../../src/main/services/workspace/recentWorkspacesMainService.js'
import { UserDataMainService } from '../../src/main/services/userData/userDataMainService.js'

export interface TestWorkbench {
  readonly userDataDir: string
  readonly logService: LogMainService
  readonly storage: MainStorageService
  readonly recentWorkspaces: RecentWorkspacesMainService
  readonly workspace: WorkspaceMainService
  readonly userData: UserDataMainService
  readonly logFiles: LogFilesMainService
  readonly fileSystem: FileSystemMainService
  readonly fileWatcher: FileWatcherMainService
  dispose(): Promise<void>
}

// Minimal IFolderDialog for tests — never shows a real dialog.
const noopDialog = { showOpenFolderDialog: vi.fn(async () => null) }

/**
 * Creates a fully wired set of main-process services backed by an isolated
 * temp directory. Mirrors the service instantiation in apps/editor/src/main/index.ts
 * but uses mock electron APIs so no Electron process is needed.
 *
 * Call dispose() in afterEach to clean up the temp dir and close file watchers.
 */
export async function createTestWorkbench(): Promise<TestWorkbench> {
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'ue-integration-'))

  // Point app.getPath to our isolated temp dir BEFORE creating any service
  // that calls app.getPath in its constructor (LogMainService, UserDataMainService).
  vi.mocked(app.getPath).mockReturnValue(userDataDir)

  const logService = new LogMainService()
  const logFiles = new LogFilesMainService(logService, 1)
  // Pass an explicit Storage to avoid the module-level singleton in storage.ts.
  // The GLOBAL backend is shared between MainStorageService (state.json) and the
  // recent-workspaces singleton, mirroring production wiring.
  const globalStorage = createStorage(join(userDataDir, 'state.json'))
  const storage = new MainStorageService(globalStorage)
  const recentWorkspaces = new RecentWorkspacesMainService(globalStorage)
  const workspace = new WorkspaceMainService(storage, recentWorkspaces, noopDialog)
  const userData = new UserDataMainService(workspace)
  const fileSystem = new FileSystemMainService()
  const fileWatcher = new FileWatcherMainService()

  return {
    userDataDir,
    logService,
    storage,
    recentWorkspaces,
    workspace,
    userData,
    logFiles,
    fileSystem,
    fileWatcher,
    async dispose() {
      userData.dispose()
      workspace.dispose()
      recentWorkspaces.dispose()
      logService.dispose()
      // Drain any pending fire-and-forget writes before removing the temp dir,
      // otherwise serialized writes that haven't run yet will fail with ENOENT.
      await storage.flush()
      await fs.rm(userDataDir, { recursive: true, force: true })
    },
  }
}
