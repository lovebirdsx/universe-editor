/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/host/machineId.ts
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetForTests, getMachineId } from '../machineId.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'universe-machineid-'))
  _resetForTests()
})

afterEach(async () => {
  _resetForTests()
  await rm(dir, { recursive: true, force: true })
})

describe('getMachineId', () => {
  it('generates a UUID, persists it, and reuses it on the next read', async () => {
    const first = await getMachineId(dir)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(await readFile(join(dir, 'machineid'), 'utf8')).toBe(first)
    // Drop the module cache to prove the second read comes from disk.
    _resetForTests()
    expect(await getMachineId(dir)).toBe(first)
  })

  it('keeps a pre-existing id and trims surrounding whitespace', async () => {
    await writeFile(join(dir, 'machineid'), 'machine-xyz\n', 'utf8')
    expect(await getMachineId(dir)).toBe('machine-xyz')
  })

  it('regenerates when the persisted file is empty', async () => {
    await writeFile(join(dir, 'machineid'), '', 'utf8')
    const id = await getMachineId(dir)
    expect(id).not.toBe('')
    expect(await readFile(join(dir, 'machineid'), 'utf8')).toBe(id)
  })

  it('concurrent first calls converge on the same id', async () => {
    const [a, b] = await Promise.all([getMachineId(dir), getMachineId(dir)])
    expect(a).toBe(b)
    expect(await readFile(join(dir, 'machineid'), 'utf8')).toBe(a)
  })
})
