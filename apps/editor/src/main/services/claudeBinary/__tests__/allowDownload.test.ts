/*---------------------------------------------------------------------------------------------
 *  Regression test for the `allowDownload:false` guard — background/speculative
 *  callers (ACP session hydrate) must never trigger a real ~226MB network
 *  download as a side effect of a passive probe. A download-mode cache miss
 *  with allowDownload:false must fail fast instead of calling fetch().
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
let appRoot = ''
let fixtureRoot = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appRoot,
    getPath: () => userData,
  },
}))

const { ClaudeBinaryMainService } = await import('../claudeBinaryMainService.js')

describe('ClaudeBinaryMainService.resolve — allowDownload', () => {
  beforeEach(async () => {
    userData = await mkdtemp(path.join(tmpdir(), 'universe-editor-claude-ad-data-'))
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'universe-editor-claude-ad-app-'))
    appRoot = path.join(fixtureRoot, 'apps', 'editor')
    await mkdir(appRoot, { recursive: true })
    // `_readSdkVersion` (dev, !isPackaged) reads `<appRoot>/../../vendor/claude-agent-acp/dist/claude-binary.json`.
    const metaDir = path.join(fixtureRoot, 'vendor', 'claude-agent-acp', 'dist')
    await mkdir(metaDir, { recursive: true })
    await writeFile(
      path.join(metaDir, 'claude-binary.json'),
      JSON.stringify({ sdkVersion: '0.3.186' }),
    )
    // Deliberately no vendored native binary — forces past the dev-reuse shortcut.
  })

  afterEach(async () => {
    await Promise.all([
      rm(userData, { recursive: true, force: true }),
      rm(fixtureRoot, { recursive: true, force: true }),
    ])
    vi.restoreAllMocks()
  })

  it('fails fast on a download cache miss when allowDownload is false, without touching the network', async () => {
    const svc = new ClaudeBinaryMainService()
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
