/*---------------------------------------------------------------------------------------------
 *  Remote development Phase 1 transparent reconnect (@regression).
 *
 *  Exercises the PersistentProtocol reconnect path end to end: after a management
 *  socket is dropped mid-session, an in-flight file read is transparently
 *  re-queued and replayed once the daemon re-attaches the socket, the connection
 *  state returns to `connected`, and the remote watcher keeps relaying change
 *  events over the reconnected socket.
 *
 *  Not @p0 — same rationale as remote.fsRoundtrip: a cold-launched remote daemon
 *  per test, slower and more environment-sensitive than the core smoke path.
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

test.describe('remote transparent reconnect', () => {
  // Same rationale as remote.fsRoundtrip: pin a local workspace so the explorer's
  // idle-phase watcher orchestration calls `watch(localRoot)` instead of
  // `unwatch()`, which would tear down the remote watch this spec arms directly.
  test.use({
    workspaceSeeder: {
      seed(dir) {
        fs.writeFileSync(path.join(dir, '.keep'), '')
      },
    },
  })

  test('reconnects transparently and keeps the watcher alive @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-')
    const fileUri = remoteUri(path.join(tmpDir, 'hello.txt'))
    const content = 'reconnect me'

    const remoteState = (): Promise<string | undefined> =>
      workbench.page.evaluate(
        (authority) =>
          window
            .__E2E__!.getRemoteConnections()
            .then((list) => list.find((c) => c.authority === authority)?.state),
        AUTHORITY,
      )

    // Establish the connection with a write + read round trip and confirm it is
    // reported connected (the first remote request drives the bring-up).
    await workbench.page.evaluate(({ uri, text }) => window.__E2E__!.writeFileText(uri, text), {
      uri: fileUri,
      text: content,
    })
    await expect
      .poll(async () =>
        workbench.page.evaluate((uri) => window.__E2E__!.readFileText(uri), fileUri),
      )
      .toBe(content)
    await expect.poll(remoteState).toBe('connected')

    // Drop the management socket, simulating a transient network failure.
    await workbench.page.evaluate(
      (authority) => window.__E2E__!.dropRemoteSocket(authority),
      AUTHORITY,
    )

    // Fire a read immediately (unawaited): it must queue in the
    // PersistentProtocol while the socket is down and replay transparently once
    // the daemon re-attaches, rather than rejecting.
    const readWhileReconnecting = workbench.page.evaluate(
      (uri) => window.__E2E__!.readFileText(uri),
      fileUri,
    )

    // The state machine flips reconnecting → connected as the reconnect lands.
    await expect.poll(remoteState, { timeout: 15_000 }).toBe('connected')

    // The replayed read resolves with the original content.
    expect(await readWhileReconnecting).toBe(content)

    // The watcher still relays change events over the reconnected socket.
    await workbench.page.evaluate((uri) => window.__E2E__!.watchFolder(uri), remoteUri(tmpDir))

    const created = path.join(tmpDir, 'newfile.txt')
    const expectedUri = remoteUri(created)
    fs.writeFileSync(created, 'created after reconnect')

    await expect
      .poll(
        async () => {
          const seen = await workbench.page.evaluate(
            (uri) => window.__E2E__!.getWatchedChangeEvents().some((e) => e.resource === uri),
            expectedUri,
          )
          if (!seen) fs.writeFileSync(created, `touch ${Date.now()}`)
          return seen
        },
        { timeout: 20_000, intervals: [500, 1000] },
      )
      .toBe(true)
  })
})
