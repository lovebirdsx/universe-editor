/*---------------------------------------------------------------------------------------------
 *  File clipboard across providers (@regression).
 *
 *  The shared file clipboard keeps the original high-fidelity URIs in its
 *  in-memory snapshot — a `remote-ssh://` resource survives a copy even though
 *  the OS clipboard only receives a materialized local path. Pasting such a
 *  snapshot into a local directory (and a local copy into a remote directory)
 *  must go through FileService.copy's cross-provider fallback
 *  (`copyAcrossProviders`), not a same-provider rename/copy.
 *
 *  Same direct-mode remote scaffolding as remote.fsRoundtrip.spec.ts:
 *  UNIVERSE_REMOTE_SERVER_CMD spawns packages/remote-server/dist/bootstrap.js
 *  with authority `e2e-local`, so `remote-ssh://e2e-local/<tmp>` tunnels to the
 *  SAME machine's filesystem. Not @p0 — every cold launch spawns the remote
 *  daemon, slower and more environment-sensitive than the core smoke path.
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

/** ITargetArg-friendly UriComponents for the same remote path. */
function remoteUriComponents(fsPath: string): {
  scheme: 'remote-ssh'
  authority: string
  path: string
} {
  const normalized = fsPath.replace(/\\/g, '/')
  return {
    scheme: 'remote-ssh',
    authority: AUTHORITY,
    path: normalized.startsWith('/') ? normalized : `/${normalized}`,
  }
}

/** ITargetArg-friendly UriComponents for a local fsPath (URI paths are posix). */
function localUriComponents(fsPath: string): { scheme: 'file'; path: string } {
  const normalized = fsPath.replace(/\\/g, '/')
  // Canonical UriComponents paths start with '/': a bare 'C:/…' stringifies to
  // parse-unstable file://C:/…, which breaks resource identity downstream.
  return { scheme: 'file', path: normalized.startsWith('/') ? normalized : '/' + normalized }
}

test.describe('file clipboard across providers', () => {
  // Pin a local workspace so the explorer's idle-phase watcher orchestration
  // calls `watch(localRoot)` instead of `unwatch()` (same rationale as
  // remote.fsRoundtrip.spec.ts — the single-watch service must not tear down
  // anything the remote daemon holds).
  test.use({
    workspaceSeeder: {
      seed(dir) {
        fs.writeFileSync(path.join(dir, '.keep'), '')
      },
    },
  })

  test('pastes a remote copy locally and a local copy remotely @regression', async ({
    workbench,
    page,
    launchWorkspace,
    scratchDir,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-fc-remote-')
    const remoteFile = path.join(tmpDir, 'r.txt')
    const localFile = path.join(launchWorkspace.dir, 'l.txt')

    // -- remote → local ------------------------------------------------------
    await page.evaluate(({ uri, text }) => window.__E2E__!.writeFileText(uri, text), {
      uri: remoteUri(remoteFile),
      text: 'hello remote',
    })

    await workbench.runCommand('filesExplorer.copy', {
      resource: remoteUriComponents(remoteFile),
      isDirectory: false,
    })

    // The internal snapshot keeps the original remote-ssh URI even though the
    // OS clipboard only received a materialized local path.
    const snapshot = await page.evaluate(() => window.__E2E__!.readClipboardSnapshot())
    expect(snapshot.source).toBe('internal')
    expect(snapshot.isCut).toBe(false)
    expect(snapshot.resources).toEqual([{ resource: remoteUri(remoteFile), isDirectory: false }])

    await workbench.runCommand('filesExplorer.paste', {
      resource: localUriComponents(launchWorkspace.dir),
      isDirectory: true,
    })

    await expect
      .poll(() => fs.existsSync(path.join(launchWorkspace.dir, 'r.txt')), { timeout: 10_000 })
      .toBe(true)
    expect(fs.readFileSync(path.join(launchWorkspace.dir, 'r.txt'), 'utf8')).toBe('hello remote')

    // -- local → remote ------------------------------------------------------
    fs.writeFileSync(localFile, 'local payload')

    await workbench.runCommand('filesExplorer.copy', {
      resource: localUriComponents(localFile),
      isDirectory: false,
    })
    await workbench.runCommand('filesExplorer.paste', {
      resource: remoteUriComponents(tmpDir),
      isDirectory: true,
    })

    await expect
      .poll(() => page.evaluate((uri) => window.__E2E__!.statResource(uri), remoteUri(localFile)), {
        timeout: 10_000,
      })
      .not.toBeNull()
    expect(
      await page.evaluate((uri) => window.__E2E__!.readFileText(uri), remoteUri(localFile)),
    ).toBe('local payload')
    // The local source stays put — a copy never deletes the source.
    expect(fs.existsSync(localFile)).toBe(true)
  })
})
