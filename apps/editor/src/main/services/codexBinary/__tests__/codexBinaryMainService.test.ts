/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/codexBinary/codexBinaryMainService.ts
 *  Focused on the resolve() dispatch + custom-path validation + inflight de-dup,
 *  which exercise no network/spawn. (forceDownload/download mirror the
 *  claudeBinary suite and need the npm registry, so are out of scope here.)
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/fake/app',
    getPath: () => userData,
  },
}))

const { CodexBinaryMainService } = await import('../codexBinaryMainService.js')

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'universe-editor-codex-bin-'))
  tempDirs.push(dir)
  return dir
}

describe('CodexBinaryMainService.resolve', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('resolves an existing custom path verbatim', async () => {
    const dir = await makeTempDir()
    const customPath = path.join(dir, 'codex.exe')
    await writeFile(customPath, 'MZ')

    const svc = new CodexBinaryMainService()
    try {
      await expect(svc.resolve({ source: 'custom', customPath })).resolves.toEqual({
        path: customPath,
      })
    } finally {
      svc.dispose()
    }
  })

  it('rejects a custom source with no configured path', async () => {
    const svc = new CodexBinaryMainService()
    try {
      await expect(svc.resolve({ source: 'custom' })).rejects.toThrow(/no path is configured/)
    } finally {
      svc.dispose()
    }
  })

  it('rejects a custom path that does not exist', async () => {
    const dir = await makeTempDir()
    const missing = path.join(dir, 'nope.exe')
    const svc = new CodexBinaryMainService()
    try {
      await expect(svc.resolve({ source: 'custom', customPath: missing })).rejects.toThrow(
        /not found at configured path/,
      )
    } finally {
      svc.dispose()
    }
  })

  it('de-dupes concurrent resolves for the same options', async () => {
    const dir = await makeTempDir()
    const customPath = path.join(dir, 'codex.exe')
    await writeFile(customPath, 'MZ')

    const svc = new CodexBinaryMainService()
    try {
      const [a, b] = await Promise.all([
        svc.resolve({ source: 'custom', customPath }),
        svc.resolve({ source: 'custom', customPath }),
      ])
      expect(a).toEqual(b)
    } finally {
      svc.dispose()
    }
  })

  it('does not cache failed resolves — a later valid attempt succeeds', async () => {
    const dir = await makeTempDir()
    const customPath = path.join(dir, 'codex.exe')
    const svc = new CodexBinaryMainService()
    try {
      await expect(svc.resolve({ source: 'custom', customPath })).rejects.toThrow()
      // Now create the file and retry the same options — must not return a cached rejection.
      await writeFile(customPath, 'MZ')
      await expect(svc.resolve({ source: 'custom', customPath })).resolves.toEqual({
        path: customPath,
      })
    } finally {
      svc.dispose()
    }
  })

  it('fails fast on a download cache miss when allowDownload is false, without touching the network', async () => {
    const svc = new CodexBinaryMainService()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(svc.resolve({ source: 'download', allowDownload: false })).rejects.toThrow(
        /not downloaded yet/,
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      svc.dispose()
    }
  })
})
