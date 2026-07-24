/*---------------------------------------------------------------------------------------------
 *  Agent deep link — workspace routing (@p1).
 *
 *  A deep link whose `cwd` matches NO open window's workspace must open that
 *  directory as a NEW workspace window first, then create the session there —
 *  the originating window stays untouched. Driven through the real main-process
 *  route (`routeDeepLink` → openWindowForFolder → createWindow argv), same as
 *  an OS protocol launch.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import { expectNoLeaks, evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 deep link — agent workspace routing', () => {
  // @serial: this case cold-launches its own Electron and the deep link spawns a
  // SECOND window — two parcel watcher subscribes back-to-back on the main
  // process (windows backend cross-process native race, same root cause as
  // smoke.folderDragNewWindow). Pin to one worker.
  test(
    'cwd with no matching window opens a new workspace window and creates the session there',
    { tag: '@serial' },
    async ({ electronApp, workbench, page }) => {
      await workbench.waitForRestored()

      const rootA = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-dlws-a-'))
      const rootB = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-dlws-b-'))
      const rootAFs = rootA.replace(/\\/g, '/')
      const rootBFs = rootB.replace(/\\/g, '/')
      await workbench.openWorkspace(rootA)

      // Window B does not exist yet, so its echo-agent + autoSubmit config must
      // come from the shared USER settings (Memory scope is per-window) — written
      // before the link is sent, read by window B at startup.
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
      await page.evaluate(() =>
        window.__E2E__!.runCommand(
          '_workbench.updateConfiguration',
          'acp.deepLink.allowAutoSubmit',
          true,
        ),
      )

      const newWindow = electronApp.waitForEvent('window')
      // Drive the REAL main-process route: on Windows/Linux an OS protocol
      // launch arrives as a second instance carrying the URL as a plain argv
      // entry (second-instance → parseDeepLinkArg → routeDeepLink). Emitting
      // the event replays exactly that, exercising workspace resolution.
      await electronApp.evaluate(
        ({ app }, url) => {
          app.emit('second-instance', {}, ['universe-editor.exe', url], process.cwd())
        },
        `universe-editor://agent/new?prompt=report-cwd&cwd=${encodeURIComponent(rootBFs)}`,
      )

      const newPage = await newWindow
      await newPage.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(newPage)

      // The new window hosts the link's cwd as its workspace…
      await expect
        .poll(() => newPage.evaluate(() => window.__E2E__!.getCurrentWorkspacePath()), {
          timeout: 8000,
        })
        .toBe(rootBFs)

      // …and the session is created THERE, running in that cwd end to end
      // (echo agent reports the cwd it received on session/new).
      await expect
        .poll(() => newPage.evaluate(() => window.__E2E__!.getAcpSessionCount()), {
          timeout: 10000,
        })
        .toBe(1)
      await expect
        .poll(
          async () => {
            const messages = await newPage.evaluate(() => window.__E2E__!.getAcpMessages())
            return messages.find((m) => m.role === 'agent')?.text ?? ''
          },
          { timeout: 10000 },
        )
        .toBe(rootBFs)

      // The originating window gets no session and keeps its own workspace.
      expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
      expect(await page.evaluate(() => window.__E2E__!.getCurrentWorkspacePath())).toBe(rootAFs)

      await expectNoLeaks(newPage)
    },
  )
})
