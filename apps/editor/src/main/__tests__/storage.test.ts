import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage, workspaceIdFromUri, workspaceStoragePath } from '../storage.js'

// Stub electron app.getPath() — workspaceStoragePath uses it. We don't import
// the real module in the test; cheap stub so the function is callable in node.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}))

describe('createStorage', () => {
  let file: string

  beforeEach(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'universe-editor-storage-'))
    file = join(dir, 'state.json')
  })

  afterEach(async () => {
    await fs.rm(file, { force: true })
  })

  it('returns undefined for unknown key when file is missing', async () => {
    const s = createStorage(file)
    expect(await s.get('missing')).toBeUndefined()
  })

  it('persists set values and reads them back', async () => {
    const s = createStorage(file)
    await s.set('workbench.layout', { sidebar: 240, panel: 200 })
    expect(await s.get('workbench.layout')).toEqual({ sidebar: 240, panel: 200 })
  })

  it('writes to disk and a fresh instance can read', async () => {
    const writer = createStorage(file)
    await writer.set('a', 1)
    await writer.set('b', { nested: true })

    const reader = createStorage(file)
    expect(await reader.get('a')).toBe(1)
    expect(await reader.get('b')).toEqual({ nested: true })
  })

  it('treats corrupt JSON as empty without throwing', async () => {
    await fs.writeFile(file, 'not-json-{', 'utf8')
    const s = createStorage(file)
    expect(await s.get('x')).toBeUndefined()
    await s.set('x', 42)
    expect(await s.get('x')).toBe(42)
  })

  it('removes a key and persists', async () => {
    const s = createStorage(file)
    await s.set('keep', 1)
    await s.set('drop', 2)
    await s.remove('drop')
    expect(await s.get('drop')).toBeUndefined()
    expect(await s.get('keep')).toBe(1)
    const reader = createStorage(file)
    expect(await reader.get('drop')).toBeUndefined()
    expect(await reader.get('keep')).toBe(1)
  })

  it('remove() on a missing key is a no-op', async () => {
    const s = createStorage(file)
    await expect(s.remove('never-set')).resolves.toBeUndefined()
  })

  it('flush() resolves after pending writes complete', async () => {
    const s = createStorage(file)
    await s.set('a', 1)
    await s.set('b', 2)
    await s.flush()
    const reader = createStorage(file)
    expect(await reader.get('a')).toBe(1)
    expect(await reader.get('b')).toBe(2)
  })
})

describe('workspaceIdFromUri', () => {
  it('is stable across calls with the same input', () => {
    expect(workspaceIdFromUri('file:///tmp/a')).toBe(workspaceIdFromUri('file:///tmp/a'))
  })

  it('produces 16 hex chars', () => {
    expect(workspaceIdFromUri('file:///tmp/foo')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for distinct inputs', () => {
    expect(workspaceIdFromUri('file:///tmp/a')).not.toBe(workspaceIdFromUri('file:///tmp/b'))
  })
})

describe('workspaceStoragePath', () => {
  it('places the file under <userData>/workspaces/<id>.json', () => {
    const p = workspaceStoragePath('abcdef0123456789')
    expect(p).toContain('workspaces')
    expect(p.endsWith('abcdef0123456789.json')).toBe(true)
  })
})
