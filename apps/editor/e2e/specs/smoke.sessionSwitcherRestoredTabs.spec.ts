/*---------------------------------------------------------------------------------------------
 *  Alt+S across a renderer reload (@regression).
 *
 *  A reload restores every session tab, but only the active one is mounted and
 *  therefore resumed; the rest have nothing but a durable history row. They used
 *  to vanish from the cross-window switcher until the user opened them by hand.
 *
 *  The echo agent deliberately does NOT advertise `session/load`, so after the
 *  reload no session is live while both tabs stay restored — exactly the state
 *  the switcher must still list. The agent config is written to USER settings
 *  because the Memory layer dies with the reloaded renderer.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

function rowLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="quick-input"] [role="option"]'),
    ).map((el) => el.textContent ?? ''),
  )
}

function sessionEditorUris(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__E2E__!.getActiveGroupEditorUris().filter((uri) => uri.includes('/acp/session/')),
  )
}

/** Create a session in the active group and give it a locatable title via its first prompt. */
async function newEchoSession(page: Page, count: number, prompt: string): Promise<string> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
    .toBe(count)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')
  await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), prompt)
  const uri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
  if (uri === undefined) throw new Error('expected the new session to become the active editor')
  return uri
}

test.describe('Alt+S restored session tabs', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'restore-notes.txt'), 'restore notes\n')
      },
    },
  })

  test('lists restored tabs that are not live and opens the picked one @regression', async ({
    electronApp,
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // Writing configuration before UserSettingsSync finishes hydrating is lost
    // without retry; gate on the same initialize the UI waits for.
    await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())

    // User scope: Memory would be lost on the reload below, leaving the restored
    // tabs unresolvable and (worse) their history rows discarded as not-found.
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
    // `update` resolving does not mean the write reached disk; the reload must
    // read it back at startup.
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
              Boolean(agents?.some((a) => a.id === 'echo'))
            )
          } catch {
            return false
          }
        },
        { timeout: 10_000, message: 'echo agent config should be flushed to settings.json' },
      )
      .toBe(true)

    const prompts = ['RESTORE-ALPHA', 'RESTORE-BETA'] as const
    for (const [i, prompt] of prompts.entries()) {
      await newEchoSession(page, i + 1, prompt)
    }
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpHistoryCount()), { timeout: 10_000 })
      .toBe(prompts.length)
    await page.evaluate(() => window.__E2E__!.flushAcpSessionHistory())
    // The editor layout has its own debounced write; leave it room before reloading.
    await page.waitForTimeout(500)

    const betaBefore = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    await workbench.waitForRestartRestore()

    // Both tabs are back; none is live (the echo agent cannot replay history).
    await expect.poll(() => sessionEditorUris(page)).toHaveLength(2)
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
    const restoredUris = await sessionEditorUris(page)
    const betaRestored = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    expect(restoredUris).toContain(betaRestored)
    const alphaRestored = restoredUris.find((uri) => uri !== betaRestored)
    if (alphaRestored === undefined) throw new Error('expected a second restored session tab')
    expect(betaBefore).not.toBe(betaRestored) // tab ids switch to their durable form

    // Regression: the non-active restored tab used to be missing here.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.switchSession')
    })
    await workbench.quickInput.waitForVisible()
    await expect.poll(() => rowLabels(page)).toHaveLength(prompts.length)
    const labels = await rowLabels(page)
    for (const prompt of prompts) {
      expect(labels.some((label) => label.includes(prompt))).toBe(true)
    }

    // Filter down to ALPHA and open it: the tab must be re-activated, not duplicated.
    // The picker always opens quick-navigate-locked; Enter hands the field back.
    await workbench.quickInput.input.press('Enter')
    await expect(workbench.quickInput.hint).toBeHidden()
    await workbench.quickInput.input.fill('RESTORE-ALPHA')
    await expect.poll(() => workbench.quickInput.dialog.getByRole('option').count()).toBe(1)
    await workbench.quickInput.input.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
      .toBe(alphaRestored)
    expect(await sessionEditorUris(page)).toHaveLength(2)
  })
})
