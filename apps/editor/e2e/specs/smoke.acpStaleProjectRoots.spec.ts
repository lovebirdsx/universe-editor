/*---------------------------------------------------------------------------------------------
 *  Stale `acp.projectRoots` smoke test (@regression).
 *
 *  Repro: opening a workspace whose Project settings still list a
 *  `acp.projectRoots` directory that no longer exists makes the Sessions
 *  hydrate sweep spawn every agent against that cwd. On Windows the spawn fails
 *  asynchronously with an ENOENT naming the executable, the handle disappears
 *  before `initialize`, and the renderer surfaces
 *  `Agent "<id>" failed to start: AcpHost: unknown or exited handle ...` —
 *  once per built-in agent, for a background sweep the user never triggered.
 *
 *  Guard: missing configured roots are skipped, and background handshake
 *  failures never reach the notification center.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.use({ workspaceSeeder: { seed() {} } })

test.describe('stale acp.projectRoots', () => {
  test('opening a workspace with a missing configured root does not toast agent start failures @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(
      ([echoPath]) => {
        const entry = (id: string) => ({
          id,
          name: 'Echo Agent',
          command: 'node',
          args: [echoPath],
        })
        // User entries replace the built-ins by id, dropping `runAsNode`, so the
        // sweep never needs the bundled agent dist.
        window.__E2E__!.updateConfigValue('acp.agents', [entry('claude-code'), entry('codex')])
        window.__E2E__!.updateConfigValue('acp.projectRoots', ['legacy/missing-project'])
      },
      [ECHO_AGENT_PATH] as const,
    )

    // `refreshSessions` awaits the whole sweep. Call it twice: the first may join
    // a startup sweep that began before the config above landed; the second is
    // guaranteed to read the new config.
    await workbench.runCommand('workbench.action.agent.refreshSessions')
    await workbench.runCommand('workbench.action.agent.refreshSessions')

    // Positive control: the workspace-root sweep really spawned the echo agent,
    // so a silently skipped sweep cannot make the assertion below vacuous.
    await expect
      .poll(
        () => page.evaluate(() => window.__E2E__!.getOutputChannelNames() as readonly string[]),
        { timeout: 10_000 },
      )
      .toContain('acp/protocol')

    const failures = await page.evaluate(() =>
      window
        .__E2E__!.getNotifications()
        .filter((n) => /failed to start/.test(n.message))
        .map((n) => n.message),
    )
    expect(failures).toEqual([])
  })
})
