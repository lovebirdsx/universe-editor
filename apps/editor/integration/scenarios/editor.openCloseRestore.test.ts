/*---------------------------------------------------------------------------------------------
 * Integration: MainStorageService — persistence round-trip (simulated app restart)
 * Unlike unit tests that use in-memory stores, this scenario writes to a real file
 * on disk and verifies a fresh storage instance can read the data back.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStorage } from '../../src/main/storage.js'
import { MainStorageService } from '../../src/main/services/storage/storageMainService.js'
import { createTestWorkbench, type TestWorkbench } from '../fixtures/createTestWorkbench.js'

describe('editor.openCloseRestore (integration)', () => {
  let wb: TestWorkbench

  beforeEach(async () => {
    wb = await createTestWorkbench()
  })

  afterEach(async () => {
    await wb.dispose()
    vi.clearAllMocks()
  })

  it('storage write survives a simulated app restart (new service instance)', async () => {
    const editorState = {
      groups: [{ id: 1, editors: [{ typeId: 'file', uri: '/tmp/foo.ts' }] }],
      activeGroup: 1,
    }

    await wb.storage.set('workbench.editorGroups', editorState)

    // Simulate restart: new storage instance reading the same file on disk
    const storageFile = join(wb.userDataDir, 'state.json')
    const storage2 = new MainStorageService(createStorage(storageFile))
    const restored = await storage2.get<typeof editorState>('workbench.editorGroups')

    expect(restored).toEqual(editorState)
  })

  it('multiple keys coexist in the same storage file', async () => {
    await wb.storage.set('key.a', { value: 1 })
    await wb.storage.set('key.b', 'hello')
    await wb.storage.set('key.c', [1, 2, 3])

    const storageFile = join(wb.userDataDir, 'state.json')

    // Verify all three keys are in the file
    const raw = await fs.readFile(storageFile, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['key.a']).toEqual({ value: 1 })
    expect(parsed['key.b']).toBe('hello')
    expect(parsed['key.c']).toEqual([1, 2, 3])

    // And a fresh instance can read them all back
    const storage2 = new MainStorageService(createStorage(storageFile))
    expect(await storage2.get('key.a')).toEqual({ value: 1 })
    expect(await storage2.get('key.b')).toBe('hello')
    expect(await storage2.get('key.c')).toEqual([1, 2, 3])
  })
})
