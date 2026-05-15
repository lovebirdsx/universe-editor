import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../storage.js'

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

  it('preserves keys across multiple sets', async () => {
    const s = createStorage(file)
    await s.set('a', 1)
    await s.set('b', 2)
    expect(await s.get('a')).toBe(1)
    expect(await s.get('b')).toBe(2)
  })
})
