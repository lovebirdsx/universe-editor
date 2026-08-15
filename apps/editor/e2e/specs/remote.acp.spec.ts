/*---------------------------------------------------------------------------------------------
 *  Remote ACP agent (@regression).
 *
 *  Opens a remote-ssh folder as the workspace, then creates an ACP agent session
 *  (the echo agent fixture, a `node <script>` command — no built-in binary, no
 *  credential path involved) and proves the agent process spawned on the remote
 *  host:
 *
 *    - the session's durable history row carries the `remote-ssh` authority, so
 *      the spawn was routed through the server's AcpHost channel (not the local
 *      one);
 *    - the agent reports the `session/new` cwd it was spawned with, which must be
 *      the remote workspace root (the same cwd the renderer derived from the
 *      remote-ssh folder).
 *
 *  Direct mode, same as remote.workspaceUi / remote.terminal:
 *  UNIVERSE_REMOTE_SERVER_CMD runs the local daemon against the Playwright tmp
 *  dir with authority `e2e-local`.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

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

test.describe('remote acp agent', () => {
  test('spawns the agent on the remote host with the remote workspace cwd @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-acp-')

    const rootUri = remoteUri(tmpDir)

    // Open the remote folder as the workspace (dialog bypassed).
    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // Inject the echo agent (a plain `node <script>` launch) and make it the default.
    await workbench.page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // New session — fire-and-forget: spawn + initialize run in the background.
    await workbench.page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getAcpSessionCount()), {
        timeout: 10_000,
      })
      .toBe(1)

    // The durable history row records the remote authority once `session/new`
    // lands — proof the agent spawn was routed to the remote host, not the
    // local AcpHost. A local (authority-untracked) session would report undefined.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveAcpSessionAuthority()), {
        timeout: 10_000,
      })
      .toBe(AUTHORITY)

    // Ask the agent for its `session/new` cwd; it echoes the remote workspace
    // root back, proving the cwd flowed through the tunnel to the remote spawn.
    await workbench.page.evaluate(() => window.__E2E__!.sendAcpPrompt('report-cwd'))
    const agentEchoesCwd = (): Promise<boolean> =>
      workbench.page.evaluate((base) => {
        const messages = window.__E2E__!.getAcpMessages()
        return messages.some((m) => m.role === 'agent' && m.text.includes(base))
      }, path.basename(tmpDir))
    await expect.poll(agentEchoesCwd, { timeout: 10_000 }).toBe(true)
  })
})
