/*---------------------------------------------------------------------------------------------
 *  Tests for MainStorageService — scope routing, switchWorkspace flush ordering, legacy purge.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageScope } from '@universe-editor/platform'
import { createStorage } from '../../../storage.js'
import { MainStorageService } from '../storageMainService.js'

// MainStorageService → workspaceStoragePath() → app.getPath('userData'). Stub it
// at module level so the workspace files land under a temp dir.
let tmpRoot: string

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
}))

describe('MainStorageService', () => {
  let globalFile: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-mainstorage-'))
    globalFile = join(tmpRoot, 'state.json')
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function buildService(): MainStorageService {
    return new MainStorageService(createStorage(globalFile))
  }

  async function buildReadyService(): Promise<MainStorageService> {
    const svc = buildService()
    // Wait for the legacy-key purge to complete before doing any test writes;
    // otherwise concurrent readAll() inside createStorage can race and lose data.
    await svc.whenReady
    return svc
  }

  it('GLOBAL is the default scope for get/set/remove', async () => {
    const svc = await buildReadyService()
    await svc.set('k', 'v')
    expect(await svc.get('k')).toBe('v')
    await svc.remove('k')
    expect(await svc.get('k')).toBeUndefined()
  })

  it('WORKSPACE writes are no-ops while no workspace is bound', async () => {
    const svc = await buildReadyService()
    await svc.set('k', 'v', StorageScope.WORKSPACE)
    expect(await svc.get('k', StorageScope.WORKSPACE)).toBeUndefined()
  })

  it('switchWorkspace binds a workspace backend so WORKSPACE reads/writes hit a separate file', async () => {
    const svc = await buildReadyService()
    await svc.set('shared.key', 'global-value', StorageScope.GLOBAL)
    await svc.switchWorkspace('aaaa1111')
    await svc.set('shared.key', 'workspace-value', StorageScope.WORKSPACE)

    expect(await svc.get('shared.key', StorageScope.GLOBAL)).toBe('global-value')
    expect(await svc.get('shared.key', StorageScope.WORKSPACE)).toBe('workspace-value')

    // Workspace file should exist on disk under <root>/workspaces/<id>.json
    const wsFile = join(tmpRoot, 'workspaces', 'aaaa1111.json')
    const wsRaw = await fs.readFile(wsFile, 'utf8')
    expect(JSON.parse(wsRaw)).toEqual({ 'shared.key': 'workspace-value' })
  })

  it('switching to a different workspace swaps the backend', async () => {
    const svc = await buildReadyService()
    await svc.switchWorkspace('aaaa')
    await svc.set('x', 1, StorageScope.WORKSPACE)
    await svc.switchWorkspace('bbbb')
    expect(await svc.get('x', StorageScope.WORKSPACE)).toBeUndefined()
    await svc.set('x', 2, StorageScope.WORKSPACE)
    await svc.switchWorkspace('aaaa')
    expect(await svc.get('x', StorageScope.WORKSPACE)).toBe(1)
  })

  it('switchWorkspace fires onDidChangeWorkspaceScope after the swap', async () => {
    const svc = await buildReadyService()
    const events: number[] = []
    svc.onDidChangeWorkspaceScope(() => events.push(1))
    await svc.switchWorkspace('aaaa')
    await svc.switchWorkspace('bbbb')
    await svc.switchWorkspace(null)
    expect(events.length).toBe(3)
  })

  it('switchWorkspace to the same id is a no-op (no event)', async () => {
    const svc = await buildReadyService()
    await svc.switchWorkspace('aaaa')
    let count = 0
    svc.onDidChangeWorkspaceScope(() => count++)
    await svc.switchWorkspace('aaaa')
    expect(count).toBe(0)
  })

  it('switchWorkspace flushes the previous backend before swapping', async () => {
    const svc = await buildReadyService()
    await svc.switchWorkspace('aaaa')
    await svc.set('pending', 'value', StorageScope.WORKSPACE)
    await svc.switchWorkspace('bbbb')
    // Re-bind to aaaa and confirm the write made it to disk.
    await svc.switchWorkspace('aaaa')
    expect(await svc.get('pending', StorageScope.WORKSPACE)).toBe('value')
  })

  it('purges legacy workspace-scope keys from the global file on construction', async () => {
    // Seed legacy keys into the global file first.
    const seed = createStorage(globalFile)
    await seed.set('workbench.workspaceState', { groups: 'legacy' })
    await seed.set('workbench.views', { side: 'legacy' })
    await seed.set('workbench.layout', { sidebar: 999 })
    await seed.set('workbench.recentFiles', [{ uri: 'x' }])
    await seed.set('workbench.recentWorkspaces', [{ folder: 'kept' }])
    await seed.flush()

    const svc = buildService()
    await svc.whenReady
    await svc.flush()

    const after = JSON.parse(await fs.readFile(globalFile, 'utf8')) as Record<string, unknown>
    expect(after['workbench.workspaceState']).toBeUndefined()
    expect(after['workbench.views']).toBeUndefined()
    expect(after['workbench.layout']).toBeUndefined()
    expect(after['workbench.recentFiles']).toBeUndefined()
    // GLOBAL-scope keys must be left intact.
    expect(after['workbench.recentWorkspaces']).toEqual([{ folder: 'kept' }])
  })
})
