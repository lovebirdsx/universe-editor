/*---------------------------------------------------------------------------------------------
 *  Remote extension host (@regression).
 *
 *  Opens a remote-ssh folder with a `.ts` file, then proves the extension host
 *  actually runs on the remote server: typescript hover/definition resolve
 *  against the remote tsserver (the host spawns it with the remote's real paths,
 *  and the host-side URI codec transforms file:<->remote-ssh so the renderer
 *  sees remote-ssh URIs throughout). Then the extension-host tunnel socket is
 *  dropped and the RPC must survive transparently — a fresh hover still resolves
 *  once the PersistentProtocol re-attaches.
 *
 *  Direct mode, same as remote.workspaceUi: UNIVERSE_REMOTE_SERVER_CMD runs the
 *  local daemon against the Playwright tmp dir with authority `e2e-local`. The
 *  client's minimal-extension-set allowlist reaches the remote host through the
 *  daemon's inherited env, so the fixture pins exactly the typescript built-in.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const remoteServerEntry = path.join(repoRoot, 'packages', 'remote-server', 'dist', 'bootstrap.js')

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  // The typescript built-in must boot (remotely) so hover/definition resolve; the
  // client's minimal-extension-set allowlist reaches the remote host through the
  // daemon's inherited env (same seam as a local host), so pin exactly typescript.
  extensions: ['@universe-editor/typescript'],
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

/** Per-test remote workspace root on the local tmp filesystem. */
function makeTmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ue2-remote-exthost-')))
}

test.describe('remote extension host', () => {
  test('runs the host remotely: typescript hover/definition resolve and survive a tunnel reconnect @regression', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = makeTmpDir()

    try {
      fs.mkdirSync(path.join(tmpDir, '.git'))
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const value = 42\nconst copy = value\n')
      const rootUri = remoteUri(tmpDir)
      const aUri = remoteUri(path.join(tmpDir, 'a.ts'))

      // Open the remote folder as the workspace (dialog bypassed).
      await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
      await expect
        .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
          timeout: 15_000,
        })
        .toBe(rootUri)

      // Open the .ts file — this triggers the remote host's typescript activation.
      await workbench.page.evaluate((uri) => window.__E2E__!.openUri(uri), aUri)
      await expect
        .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
          timeout: 15_000,
        })
        .toBe(aUri)

      // Hover on `value` (line 2) must resolve against the remote tsserver.
      const hover = (): Promise<string> =>
        workbench.page.evaluate((uri) => window.__E2E__!.getHover(uri, 2, 15), aUri)
      await expect.poll(hover, { timeout: 30_000 }).not.toBe('')

      // Definition of `value` (line 2) resolves back into the same remote file —
      // and the result must carry the remote-ssh scheme: a bare file:/// URI
      // here means the host-side URI transform silently dropped it.
      const resolvesToAts = (): Promise<boolean> =>
        workbench.page.evaluate(
          (uri) =>
            window
              .__E2E__!.getDefinition(uri, 2, 15)
              .then((d) => d.some((u) => u.startsWith('remote-ssh://') && u.endsWith('/a.ts'))),
          aUri,
        )
      await expect.poll(resolvesToAts, { timeout: 30_000 }).toBe(true)

      // Drop the extension-host tunnel socket: the RPC must survive transparently.
      await workbench.page.evaluate(
        (authority) => window.__E2E__!.dropRemoteExtensionHostSocket(authority),
        AUTHORITY,
      )

      // A fresh hover still resolves once the PersistentProtocol re-attaches.
      await expect.poll(hover, { timeout: 30_000 }).not.toBe('')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
