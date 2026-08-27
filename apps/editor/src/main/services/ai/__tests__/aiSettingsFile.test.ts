/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  aiSettingsFile tests — the serial queue and the atomic write. The rename
 *  retry matters on Windows, where an indexer or AV briefly holding the target
 *  surfaces as EPERM; without it a burst of writes (the settings editor saving
 *  providers and a per-model config back to back) loses one at random.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renameMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: renameMock }
})

const { mutateAiSettingsFile, readAiSettingsRoot, writeAiSettingsFile } =
  await import('../aiSettingsFile.js')

let dir: string
let path: string

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  renameMock.mockImplementation(actual.rename)
  dir = await mkdtemp(join(tmpdir(), 'ue-aisettings-'))
  path = join(dir, 'aiSettings.json')
})

afterEach(async () => {
  vi.useRealTimers()
  renameMock.mockReset()
  await rm(dir, { recursive: true, force: true })
})

function transientError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
}

describe('aiSettingsFile atomic write', () => {
  it('writes and reads back the root', async () => {
    await writeAiSettingsFile(path, { providers: [{ id: 'acme' }] })
    expect(await readAiSettingsRoot(path)).toEqual({ providers: [{ id: 'acme' }] })
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient %s rename', async (code) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let attempts = 0
    renameMock.mockImplementation(async (from: string, to: string) => {
      attempts++
      if (attempts <= 3) throw transientError(code)
      return actual.rename(from, to)
    })

    await writeAiSettingsFile(path, { models: { 'deepseek-v4-pro': {} } })

    expect(attempts).toBe(4)
    expect(await readAiSettingsRoot(path)).toEqual({ models: { 'deepseek-v4-pro': {} } })
  })

  it('rethrows a non-transient rename error instead of retrying', async () => {
    renameMock.mockRejectedValue(transientError('ENOSPC'))

    await expect(writeAiSettingsFile(path, { providers: [] })).rejects.toThrow('ENOSPC')
    expect(renameMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget', async () => {
    renameMock.mockRejectedValue(transientError('EPERM'))

    await expect(writeAiSettingsFile(path, { providers: [] })).rejects.toThrow('EPERM')
    expect(renameMock).toHaveBeenCalledTimes(10)
  })

  it('serializes concurrent read-modify-writes so neither update is lost', async () => {
    await Promise.all([
      mutateAiSettingsFile(path, (root) => {
        root['a'] = 1
      }),
      mutateAiSettingsFile(path, (root) => {
        root['b'] = 2
      }),
    ])

    expect(await readAiSettingsRoot(path)).toEqual({ a: 1, b: 2 })
  })

  it('leaves no temp files behind', async () => {
    await writeAiSettingsFile(path, { providers: [] })
    const { readdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('reads an absent file as an empty root', async () => {
    expect(await readAiSettingsRoot(join(dir, 'missing.json'))).toEqual({})
  })

  it('reads a malformed file as an empty root', async () => {
    await writeAiSettingsFile(path, { providers: [] })
    const { writeFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await writeFile(path, '{ not json', 'utf8')
    expect(await readAiSettingsRoot(path)).toEqual({})
    expect(await readFile(path, 'utf8')).toBe('{ not json')
  })
})
