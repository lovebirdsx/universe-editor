/*---------------------------------------------------------------------------------------------
 *  Remote development Phase 1 roundtrip (@regression).
 *
 *  The remote server is a pure Node TCP daemon (packages/remote-server/dist/
 *  bootstrap.js) launched in direct mode: UNIVERSE_REMOTE_SERVER_CMD is the
 *  command prefix `[process.execPath, bootstrap.js]`, and the main process appends
 *  `serve --data-dir <userData>/remote-direct/e2e-local` before spawning it. The
 *  authority is `e2e-local`, so a `remote-ssh://e2e-local/<tmp>` URI tunnels to the
 *  SAME machine's filesystem — the Playwright-managed tmp dir. Each test exercises
 *  one Phase 1 surface: file read/write/stat/list/delete, remote-rooted text
 *  search, and the remote watcher's change-event round trip.
 *
 *  Not @p0 — spawning the remote server is a child process per cold launch,
 *  slower and more environment-sensitive than the core workbench smoke path.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const remoteServerEntry = path.join(repoRoot, 'packages', 'remote-server', 'dist', 'bootstrap.js')

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  extensions: [],
  env: {
    UNIVERSE_REMOTE_SERVER_CMD: JSON.stringify([process.execPath, remoteServerEntry]),
  },
})

/** `remote-ssh://<authority>/<path>` for an absolute local path (same host). */
function remoteUri(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/')
  const pathPart = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `remote-ssh://${AUTHORITY}${pathPart}`
}

test.describe('remote fs roundtrip', () => {
  // Pin a local workspace so the explorer's idle-phase watcher orchestration
  // calls `watch(localRoot)` instead of `unwatch()`. `IFileWatcherService` is a
  // single-watch service, and the empty-window `unwatch()` would tear down the
  // remote watch this spec arms directly (the remote watch is the workspace
  // watch in a real remote session, so the two never conflict there).
  test.use({
    workspaceSeeder: {
      seed(dir) {
        fs.writeFileSync(path.join(dir, '.keep'), '')
      },
    },
  })

  test('writes, reads back, stats, lists, then deletes a remote file @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-')
    const fileUri = remoteUri(path.join(tmpDir, 'hello.txt'))
    const dirUri = remoteUri(tmpDir)
    const content = 'hello remote world'

    await workbench.page.evaluate(({ uri, text }) => window.__E2E__!.writeFileText(uri, text), {
      uri: fileUri,
      text: content,
    })

    const readBack = await workbench.page.evaluate(
      (uri) => window.__E2E__!.readFileText(uri),
      fileUri,
    )
    expect(readBack).toBe(content)

    const stat = await workbench.page.evaluate((uri) => window.__E2E__!.statResource(uri), fileUri)
    expect(stat).not.toBeNull()
    expect(stat?.isFile).toBe(true)
    expect(stat?.isDirectory).toBe(false)

    const names = await workbench.page.evaluate((uri) => window.__E2E__!.listResource(uri), dirUri)
    expect(names).toContain('hello.txt')

    await workbench.page.evaluate((uri) => window.__E2E__!.deleteResource(uri), fileUri)
    await expect
      .poll(() => workbench.page.evaluate((uri) => window.__E2E__!.statResource(uri), fileUri), {
        timeout: 10_000,
      })
      .toBeNull()
  })

  test('text search over a remote root returns remote-ssh hits @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-')

    fs.writeFileSync(path.join(tmpDir, 'alpha.txt'), 'no keyword here')
    fs.writeFileSync(path.join(tmpDir, 'beta.txt'), 'needle in a haystack')

    const hits = await workbench.page.evaluate(
      ({ root, pattern }) => window.__E2E__!.searchTextInRoot(root, pattern),
      { root: remoteUri(tmpDir), pattern: 'needle' },
    )

    expect(hits).toContain(remoteUri(path.join(tmpDir, 'beta.txt')))
    expect(hits).not.toContain(remoteUri(path.join(tmpDir, 'alpha.txt')))
    for (const hit of hits) {
      expect(hit.startsWith(`remote-ssh://${AUTHORITY}/`)).toBe(true)
    }
  })

  test('watcher relays a remote change event with a remote-ssh URI @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-')

    await workbench.page.evaluate((uri) => window.__E2E__!.watchFolder(uri), remoteUri(tmpDir))

    const created = path.join(tmpDir, 'newfile.txt')
    const expectedUri = remoteUri(created)
    fs.writeFileSync(created, 'created after watch armed')

    await expect
      .poll(
        async () => {
          const seen = await workbench.page.evaluate(
            (uri) => window.__E2E__!.getWatchedChangeEvents().some((e) => e.resource === uri),
            expectedUri,
          )
          // parcel's Windows backend can miss a change landing in the
          // subscribe→ready window; touching the file re-arms a retry.
          if (!seen) fs.writeFileSync(created, `touch ${Date.now()}`)
          return seen
        },
        { timeout: 20_000, intervals: [500, 1000] },
      )
      .toBe(true)
  })
})
