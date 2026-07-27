/*---------------------------------------------------------------------------------------------
 *  Agent deep link smoke (@p1).
 *
 *  Covers the `universe-editor://agent/new?prompt=…&cwd=…` entry point, driven
 *  through the real main→renderer push (`webContents.send('ue:open-uri', …)` →
 *  preload listener → DeepLinkContribution), same as a live-window OS protocol
 *  launch:
 *
 *    1. acp.deepLink.allowAutoSubmit off: the prompt only lands in the input
 *       box for review, nothing is sent;
 *    2. default (allowAutoSubmit on): the prompt is sent end-to-end (echo agent
 *       replies), and the session runs in the link's `cwd` (echo agent
 *       `report-cwd`);
 *    3. default (allowAutoSubmit on) + link-level autoSubmit=false: the link
 *       opt-out still wins over the setting;
 *
 *  Every link carries `cwd` = the window's workspace, so main-process routing
 *  (`routeDeepLink` → openWindowForFolder) resolves back to this same window;
 *  the cross-window "no match → open a new workspace window" shape lives in
 *  smoke.deepLinkAgentWorkspace.spec.ts.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

/** Push an agent deep-link opener target exactly the way the main process does. */
async function sendAgentDeepLink(electronApp: ElectronApplication, target: string): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, t) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('[E2E] no window to receive the deep link')
    win.webContents.send('ue:open-uri', t)
  }, target)
}

async function installEchoAgent(page: Page): Promise<void> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
}

async function waitForSession(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
}

test.describe('@p1 deep link — agent', () => {
  let wsFs = ''

  test.beforeEach(async ({ page, workbench }) => {
    await workbench.waitForRestored()
    // Agent deep links route by workspace, so each test opens one first and
    // points the link's `cwd` at it (forward slashes, like an external caller).
    const wsDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-deeplink-'))
    wsFs = wsDir.replace(/\\/g, '/')
    await workbench.openWorkspace(wsDir)
    await installEchoAgent(page)
  })

  test('allowAutoSubmit off: prompt only fills the input box, nothing is sent', async ({
    page,
    electronApp,
  }) => {
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('acp.deepLink.allowAutoSubmit', false),
    )

    await sendAgentDeepLink(
      electronApp,
      `agent:new?prompt=review%20the%20quest&cwd=${encodeURIComponent(wsFs)}`,
    )
    await waitForSession(page)

    // The prompt must be reviewable in the input box…
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()), { timeout: 10000 })
      .toBe('review the quest')
    // …and never sent on its own.
    expect(await page.evaluate(() => window.__E2E__!.getAcpMessages())).toEqual([])
  })

  test('default (allowAutoSubmit on): prompt is sent end-to-end in the link cwd', async ({
    page,
    electronApp,
  }) => {
    // Default is allowAutoSubmit=on — no config write here, this test guards the
    // out-of-the-box behavior.
    // The echo agent reports the cwd it received on session/new, so this one
    // reply proves both the send and the working-directory plumbing.
    await sendAgentDeepLink(
      electronApp,
      `agent:new?prompt=report-cwd&cwd=${encodeURIComponent(wsFs)}`,
    )
    await waitForSession(page)

    await expect
      .poll(
        async () => {
          const messages = await page.evaluate(() => window.__E2E__!.getAcpMessages())
          return messages.find((m) => m.role === 'agent')?.text ?? ''
        },
        { timeout: 10000 },
      )
      .toBe(wsFs)
  })

  test('link autoSubmit=false: the link opt-out wins over the default on', async ({
    page,
    electronApp,
  }) => {
    await sendAgentDeepLink(
      electronApp,
      `agent:new?prompt=review%20the%20quest&autoSubmit=false&cwd=${encodeURIComponent(wsFs)}`,
    )
    await waitForSession(page)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()), { timeout: 10000 })
      .toBe('review the quest')
    expect(await page.evaluate(() => window.__E2E__!.getAcpMessages())).toEqual([])
  })
})
