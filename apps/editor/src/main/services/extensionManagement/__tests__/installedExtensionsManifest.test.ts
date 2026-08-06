/*---------------------------------------------------------------------------------------------
 *  extensions.json atomic-write robustness: on Windows the tmp→target rename can
 *  hit a transient EPERM while the target is held open (AV scan, a concurrent
 *  manifest read from the host rescan that a setEnablement itself triggers).
 *  Guards the retry so the write survives a short-lived lock instead of
 *  surfacing EPERM to the caller (seen live in smoke.extensions e2e).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  readEnablement,
  readInstalledRecords,
  writeEnablement,
} from '../installedExtensionsManifest.js'

function erroring(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation not permitted, rename`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('installedExtensionsManifest atomic write', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ext-manifest-test-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('retries the rename through transient EPERM locks and lands the write', async () => {
    const spy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(erroring('EPERM'))
      .mockRejectedValueOnce(erroring('EBUSY'))
    // After the two mocked rejections the spy falls through to the real rename.

    await writeEnablement(dir, { 'acme.sample': false })

    expect(spy.mock.calls.length).toBe(3)
    expect(await readEnablement(dir)).toEqual({ 'acme.sample': false })
    const raw = await readFile(path.join(dir, 'extensions.json'), 'utf8')
    expect(JSON.parse(raw).enablement).toEqual({ 'acme.sample': false })
  })

  it('gives up on a non-retryable rename error', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValue(erroring('ENOENT'))

    await expect(writeEnablement(dir, { 'acme.sample': false })).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // Nothing landed: the manifest degrades to "nothing installed / all enabled".
    expect(await readEnablement(dir)).toEqual({})
    expect(await readInstalledRecords(dir)).toEqual([])
  })

  it('surfaces the error once the retry budget is exhausted', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValue(erroring('EPERM'))

    await expect(writeEnablement(dir, { 'acme.sample': false })).rejects.toMatchObject({
      code: 'EPERM',
    })
  }, 15_000)
})
