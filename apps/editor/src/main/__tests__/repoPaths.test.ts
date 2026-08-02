/*---------------------------------------------------------------------------------------------
 *  resolveFromRepo — repo-relative dev-tree resolution must tolerate both
 *  `electron .` (appPath = apps/editor) and the e2e `electron out/main/index.js`
 *  layout (appPath = apps/editor/out/main). Regression guard for the naive
 *  `<appPath>/../..` resolution that pointed claude-binary.json at
 *  `apps/editor/vendor/...` under the e2e layout.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let appPath = ''

vi.mock('electron', () => ({
  app: {
    getAppPath: () => appPath,
  },
}))

const { resolveFromRepo } = await import('../repoPaths.js')

describe('resolveFromRepo', () => {
  let repoRoot = ''

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'universe-editor-repopaths-'))
    const metaDir = path.join(repoRoot, 'vendor', 'claude-agent-acp', 'dist')
    await mkdir(metaDir, { recursive: true })
    await writeFile(path.join(metaDir, 'claude-binary.json'), '{}')
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('resolves from appPath = apps/editor (electron .)', async () => {
    appPath = path.join(repoRoot, 'apps', 'editor')
    await mkdir(appPath, { recursive: true })
    expect(resolveFromRepo('vendor/claude-agent-acp/dist/claude-binary.json')).toBe(
      path.join(repoRoot, 'vendor', 'claude-agent-acp', 'dist', 'claude-binary.json'),
    )
  })

  it('resolves from appPath = apps/editor/out/main (e2e entry-file launch)', async () => {
    appPath = path.join(repoRoot, 'apps', 'editor', 'out', 'main')
    await mkdir(appPath, { recursive: true })
    expect(resolveFromRepo('vendor/claude-agent-acp/dist/claude-binary.json')).toBe(
      path.join(repoRoot, 'vendor', 'claude-agent-acp', 'dist', 'claude-binary.json'),
    )
  })

  it('falls back to <appPath>/../.. when the path exists nowhere', async () => {
    appPath = path.join(repoRoot, 'apps', 'editor')
    await mkdir(appPath, { recursive: true })
    expect(resolveFromRepo('vendor/nonexistent/thing.json')).toBe(
      path.resolve(appPath, '../..', 'vendor/nonexistent/thing.json'),
    )
  })
})
