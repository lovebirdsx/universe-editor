/*---------------------------------------------------------------------------------------------
 *  Background-mode end-to-end (@p1): closing the last window hides it instead of
 *  quitting, the phone gateway stays online, recent-only workspaces open hidden,
 *  and a `--background` cold launch starts windowless until asked to show.
 *
 *  Uses the cold-launch gateway fixture (same env/port setup as mobile.gateway) and
 *  the main-process `__E2E_MAIN__` probe for assertions that are impossible from a
 *  renderer once every window is hidden or absent.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication } from '@playwright/test'
import {
  ENABLED_EXTENSIONS_ENV,
  launchElectron,
  seedBaselineUserData,
} from '@universe-editor/e2e-harness'
import type { MobileWorkspaceCandidate } from '@universe-editor/mobile-protocol'
import {
  MOBILE_ASSETS_DIR,
  MOBILE_E2E_CODE,
  MOBILE_GATEWAY_PORT,
  closeApp,
  expect,
  findFreePort,
  test,
} from '../fixtures/mobileApp.js'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'
import {
  createMobileGatewayPageHelpers,
  sendCommand,
  subscribeInbox,
  subscribeSession,
} from './helpers/mobileGateway.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const FIXED_CODE_DISPLAY = '1234-ABCD'
const EXPECTED_ORIGIN = `http://127.0.0.1:${MOBILE_GATEWAY_PORT}`

const { connectRawPhone, gatewayStatus } = createMobileGatewayPageHelpers({
  e2eCode: MOBILE_E2E_CODE,
  pairingCodeDisplay: FIXED_CODE_DISPLAY,
  expectedOrigin: EXPECTED_ORIGIN,
})

interface MainProbeSnapshot {
  readonly active: boolean
  readonly hiddenWindowIds: readonly number[]
}

/**
 * Main-process `__E2E_MAIN__.backgroundMode` accessors. Everything here runs in
 * the Electron main process, which has no renderer (and therefore no
 * `window.__E2E__`) once background mode has hidden every window.
 */
function mainProbe(app: ElectronApplication) {
  return {
    read: () =>
      app.evaluate((): MainProbeSnapshot => {
        const probe = (
          globalThis as unknown as {
            __E2E_MAIN__?: {
              backgroundMode: {
                isActive(): boolean
                hiddenWindowIds(): readonly number[]
              }
            }
          }
        ).__E2E_MAIN__
        return {
          active: probe?.backgroundMode.isActive() ?? false,
          hiddenWindowIds: probe === undefined ? [] : [...probe.backgroundMode.hiddenWindowIds()],
        }
      }),
    show: () =>
      app.evaluate(async () => {
        const probe = (
          globalThis as unknown as {
            __E2E_MAIN__?: { backgroundMode: { show(): Promise<void> } }
          }
        ).__E2E_MAIN__
        if (probe !== undefined) await probe.backgroundMode.show()
      }),
    exit: () =>
      app.evaluate(() => {
        const probe = (
          globalThis as unknown as { __E2E_MAIN__?: { backgroundMode: { exit(): void } } }
        ).__E2E_MAIN__
        probe?.backgroundMode.exit()
      }),
  }
}

interface WindowSnapshot {
  readonly id: number
  readonly visible: boolean
  readonly destroyed: boolean
}

function windowSnapshot(app: ElectronApplication): Promise<WindowSnapshot[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      id: win.id,
      visible: win.isVisible(),
      destroyed: win.isDestroyed(),
    })),
  )
}

/** Ask the main app to quit and wait for the process (bounded, so teardown never hangs). */
async function quitInBackground(
  app: ElectronApplication,
  probe: ReturnType<typeof mainProbe>,
): Promise<void> {
  const closed = app.waitForEvent('close').catch(() => undefined)
  await probe.exit().catch(() => undefined)
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 15_000))])
}

test.describe('@p1 mobile background mode', () => {
  test('@p1 hides the last window instead of quitting and keeps the phone online', async ({
    page,
    workbench,
    electronApp,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    const probe = mainProbe(electronApp)

    const { ws } = await connectRawPhone(page, workbench)
    try {
      const updated = await page.evaluate(() =>
        window.__E2E__!.updateMobileGatewayConfig({ keepRunningInBackground: true }),
      )
      expect(updated).toMatchObject({ ok: true })
      await expect.poll(async () => (await probe.read()).active).toBe(true)

      const before = await windowSnapshot(electronApp)
      expect(before).toHaveLength(1)
      const windowId = before[0]!.id
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close()
      })

      // The window object survives, is hidden, and was not destroyed: the
      // process (and its renderer sessions) keep running.
      await expect
        .poll(async () => {
          const snapshot = await windowSnapshot(electronApp)
          return (
            snapshot.length === 1 &&
            snapshot[0]!.id === windowId &&
            snapshot[0]!.visible === false &&
            snapshot[0]!.destroyed === false
          )
        })
        .toBe(true)

      await expect.poll(async () => (await gatewayStatus(page)).state).toBe('running')
      expect(await probe.read()).toEqual({ active: true, hiddenWindowIds: [windowId] })

      // The already-paired raw phone connection must still work with no visible
      // window: the gateway only went offline if the process had quit.
      const inbox = await subscribeInbox(ws)
      expect(inbox.sessions).toEqual([])
      const listed = await sendCommand(ws, 'listWorkspaces', {})
      expect(listed).toMatchObject({ ok: true })
    } finally {
      ws.close()
      await quitInBackground(electronApp, probe)
    }
  })

  test('@p1 creates a hidden window for a recent-only workspace from the phone', async ({
    page,
    workbench,
    electronApp,
    scratchDir,
  }) => {
    test.setTimeout(150_000)
    const probe = mainProbe(electronApp)
    await workbench.waitForRestored()

    // The window the gateway opens for the recent workspace reads its agent
    // config from USER settings at startup (Memory scope is per-window).
    await page.evaluate(
      ([agentPath]) =>
        window.__E2E__!.runCommand('_workbench.updateConfiguration', 'acp.agents', [
          { id: 'echo', name: 'Echo Agent', command: 'node', args: [agentPath] },
        ]),
      [ECHO_AGENT_PATH] as const,
    )
    await page.evaluate(() =>
      window.__E2E__!.runCommand('_workbench.updateConfiguration', 'acp.defaultAgentId', 'echo'),
    )
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    await expect
      .poll(
        () => {
          try {
            const parsed = JSON.parse(
              readFileSync(join(userDataDir, 'settings.json'), 'utf8'),
            ) as Record<string, unknown>
            const agents = parsed['acp.agents'] as Array<{ id?: string }> | undefined
            return (
              parsed['acp.defaultAgentId'] === 'echo' &&
              Boolean(agents?.some((agent) => agent.id === 'echo'))
            )
          } catch {
            return false
          }
        },
        { timeout: 10_000, message: 'echo agent config should be flushed to settings.json' },
      )
      .toBe(true)

    // Make the folder recent-only: opening it adds it to the recents; closing
    // it leaves no window holding the folder, so the gateway opens a new one.
    const dir = realpathSync.native(scratchDir('universe-editor-e2e-mobile-bg-recent-'))
    const posixDir = dir.replace(/\\/g, '/')
    await workbench.openWorkspace(dir)
    await expect.poll(() => workbench.getCurrentWorkspacePath()).toBe(posixDir)
    await page.evaluate(() => window.__E2E__!.closeWorkspace())
    await expect.poll(() => workbench.getCurrentWorkspacePath()).toBeUndefined()
    await expect.poll(() => workbench.getRecentWorkspacePaths()).toContain(posixDir)

    const { ws } = await connectRawPhone(page, workbench)
    try {
      // Subscribe before the new window exists, exactly like the PWA does.
      await subscribeInbox(ws)
      const updated = await page.evaluate(() =>
        window.__E2E__!.updateMobileGatewayConfig({ keepRunningInBackground: true }),
      )
      expect(updated).toMatchObject({ ok: true })
      await expect.poll(async () => (await probe.read()).active).toBe(true)

      const before = await windowSnapshot(electronApp)
      expect(before).toHaveLength(1)
      const hiddenWindowId = before[0]!.id
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close()
      })
      await expect
        .poll(async () => {
          const snapshot = await windowSnapshot(electronApp)
          return snapshot.length === 1 && snapshot[0]!.visible === false
        })
        .toBe(true)

      const name = basename(posixDir)
      let candidate: MobileWorkspaceCandidate | undefined
      await expect
        .poll(
          async () => {
            const result = await sendCommand(ws, 'listWorkspaces', {})
            candidate = result.ok
              ? (result.result as MobileWorkspaceCandidate[]).find(
                  (workspace) => !workspace.isOpen && workspace.name === name,
                )
              : undefined
            return candidate !== undefined
          },
          { timeout: 15_000 },
        )
        .toBe(true)

      const created = await sendCommand(
        ws,
        'newSession',
        { agentId: 'echo', workspace: { folder: candidate!.folder } },
        undefined,
        30_000,
      )
      expect(created).toMatchObject({ ok: true })
      const ref = (created.result as { ref: { windowId: number; localId: string } }).ref
      expect(typeof ref.windowId).toBe('number')

      // The new window was created hidden and the previously hidden window
      // stayed hidden (no restore/focus).
      await expect
        .poll(
          async () => {
            const snapshot = await windowSnapshot(electronApp)
            return (
              snapshot.length === 2 &&
              snapshot.every((win) => win.destroyed === false && win.visible === false) &&
              snapshot.some((win) => win.id === hiddenWindowId)
            )
          },
          { timeout: 20_000 },
        )
        .toBe(true)

      // The phone sees the workspace as open (i.e. the hidden window really
      // hosts it, not a phantom session).
      await expect
        .poll(
          async () => {
            const result = await sendCommand(ws, 'listWorkspaces', {})
            const row = result.ok
              ? (result.result as MobileWorkspaceCandidate[]).find((workspace) =>
                  workspacesMatch(workspace, candidate!.folder),
                )
              : undefined
            return row?.isOpen ?? false
          },
          { timeout: 15_000 },
        )
        .toBe(true)

      const snapshot = await subscribeSession(ws, ref)
      expect(snapshot.session.summary.agentId).toBe('echo')
    } finally {
      ws.close()
      await quitInBackground(electronApp, probe)
    }
  })

  test('@p1 exits the app through the background-mode probe', async ({
    page,
    workbench,
    electronApp,
  }) => {
    test.setTimeout(120_000)
    await workbench.waitForRestored()
    const probe = mainProbe(electronApp)

    const updated = await page.evaluate(() =>
      window.__E2E__!.updateMobileGatewayConfig({ keepRunningInBackground: true }),
    )
    expect(updated).toMatchObject({ ok: true })
    await expect.poll(async () => (await probe.read()).active).toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect
      .poll(async () => {
        const snapshot = await windowSnapshot(electronApp)
        return snapshot.length === 1 && snapshot[0]!.visible === false
      })
      .toBe(true)

    // Exit goes through `app.quit()`; the process ends even though the only
    // window is hidden (the background-mode window-all-closed guard lets a
    // confirmed quit through).
    const closed = electronApp.waitForEvent('close')
    await probe.exit().catch(() => undefined)
    await closed
  })

  test('@p1 starts windowless with --background and shows a window on demand', async ({
    scratchDir,
  }) => {
    test.setTimeout(120_000)
    const userDataDir = scratchDir('universe-editor-e2e-mobile-bg-')
    seedBaselineUserData(userDataDir)
    const port = await findFreePort()
    mkdirSync(join(userDataDir, 'mobile'), { recursive: true })
    writeFileSync(
      join(userDataDir, 'mobile', 'gateway.json'),
      JSON.stringify({ enabled: true, bind: 'loopback', port, keepRunningInBackground: true }),
      'utf8',
    )

    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, '--background'],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
        [ENABLED_EXTENSIONS_ENV]: '',
        UNIVERSE_MOBILE_ASSETS_DIR: MOBILE_ASSETS_DIR,
      },
    })
    try {
      const probe = mainProbe(app)
      await expect.poll(async () => (await probe.read()).active, { timeout: 30_000 }).toBe(true)
      expect(await windowSnapshot(app)).toEqual([])

      const windowPromise = app.waitForEvent('window')
      await probe.show()
      const page = await windowPromise
      await page.waitForLoadState('domcontentloaded')
      await expect
        .poll(async () => (await windowSnapshot(app)).some((win) => win.visible), {
          timeout: 15_000,
        })
        .toBe(true)
      await expect.poll(() => page.evaluate(() => Boolean(window.__E2E__))).toBe(true)
    } finally {
      await closeApp(app)
    }
  })
})

/** Compare workspace folders without assuming the URI string form is identical. */
function workspacesMatch(
  workspace: MobileWorkspaceCandidate,
  folder: MobileWorkspaceCandidate['folder'],
): boolean {
  return workspace.folder === folder || workspace.folder.endsWith(folder)
}
