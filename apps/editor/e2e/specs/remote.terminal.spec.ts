/*---------------------------------------------------------------------------------------------
 *  Remote terminal (@regression).
 *
 *  Opens a remote-ssh folder as the workspace, then creates an integrated
 *  terminal through the renderer terminal manager (the real user path, so the
 *  cwd is resolved from the current workspace). The terminal must route to the
 *  remote host: the returned id carries the `remote:<authority>:` prefix, `echo`
 *  round-trips through the server's PTY, and the shell reports the remote
 *  workspace root. Direct mode, same as remote.workspaceUi:
 *  UNIVERSE_REMOTE_SERVER_CMD runs the local daemon against the Playwright tmp
 *  dir with authority `e2e-local`.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'
const MARKER = '__E2E_REMOTE_TERMINAL_OK__'

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

/** Per-test remote workspace root on the local tmp filesystem. */
function makeTmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ue2-remote-term-')))
}

/** Delete `dir`, retrying while a live process (the remote shell) releases its cwd. */
async function rmDirRetry(dir: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

test.describe('remote terminal', () => {
  test('routes the terminal to the remote host and round-trips output @regression', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = makeTmpDir()

    try {
      const rootUri = remoteUri(tmpDir)

      await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
      await expect
        .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
          timeout: 15_000,
        })
        .toBe(rootUri)

      const id = await workbench.page.evaluate(() => window.__E2E__!.terminalCreateInWorkspace())
      expect(id).not.toBeNull()
      const tid = id!
      expect(tid).toContain(`remote:${AUTHORITY}:`)

      await workbench.page.evaluate(
        ({ t, marker }) => window.__E2E__!.terminalInput(t, `echo ${marker}\r`),
        { t: tid, marker: MARKER },
      )
      await expect
        .poll(() => workbench.page.evaluate((t) => window.__E2E__!.terminalReadBuffer(t), tid), {
          timeout: 15_000,
        })
        .toContain(MARKER)

      await workbench.page.evaluate((t) => window.__E2E__!.terminalInput(t, 'pwd\r'), tid)
      await expect
        .poll(() => workbench.page.evaluate((t) => window.__E2E__!.terminalReadBuffer(t), tid), {
          timeout: 15_000,
        })
        .toContain(path.basename(tmpDir))

      // Exit the shell and wait for the terminal to leave the manager via the
      // natural exit path, so its process releases the tmp dir cwd handle before
      // cleanup (Windows refuses to delete a live process's cwd directory).
      await workbench.page.evaluate((t) => window.__E2E__!.terminalInput(t, 'exit\r'), tid)
      await expect
        .poll(() => workbench.page.evaluate(() => window.__E2E__!.getPanelTerminalCount()), {
          timeout: 15_000,
        })
        .toBe(0)
      await workbench.page.evaluate((t) => window.__E2E__!.terminalClose(t), tid)
    } finally {
      await rmDirRetry(tmpDir)
    }
  })
})
