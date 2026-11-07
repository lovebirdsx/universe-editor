/*---------------------------------------------------------------------------------------------
 *  Delete Agent Session command (@p1).
 *
 *  The command has three entry points (session tab menu, chat context menu, command
 *  palette / keybinding). Here we drive the palette path — the one that resolves its
 *  target from the active session editor / active session and is gated on the root
 *  `activeEditorTypeId` key: a `precondition` or the group-scoped `activeEditorType`
 *  would make the row vanish the moment the palette steals focus.
 *
 *  The echo agent has no `session/delete` support, so `deleteOnAgent` returns
 *  unsupported — the local row, tombstone and tab teardown still have to happen.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/sharedApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const DELETE_COMMAND = 'workbench.action.agent.deleteSession'

function sessionEditorUriCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      window.__E2E__!.getActiveGroupEditorUris().filter((uri) => uri.includes('/acp/session/'))
        .length,
  )
}

async function prepare(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.waitForBootstrapFocusSettled()
  await workbench.waitForRestored()
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
}

/**
 * Create an echo session and send one prompt so the durable history row exists
 * (the delete pipeline needs it to map local id → agent id and to tombstone).
 */
async function startEchoSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
    .toBe('acp.session')

  await page.evaluate(() => window.__E2E__!.sendAcpPrompt('delete me'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 10_000 })
    .toHaveLength(2)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpHistoryCount()), { timeout: 10_000 })
    .toBe(1)
}

test.describe('@p1 acp session delete command', () => {
  test('deletes the active session and closes its tab', async ({ page, workbench }) => {
    await prepare(page, workbench)
    await page.evaluate(() =>
      window.__E2E__!.runCommand(
        '_workbench.updateConfiguration',
        'acp.sessions.confirmDelete',
        false,
      ),
    )
    await startEchoSession(page)
    expect(await sessionEditorUriCount(page)).toBe(1)

    await page.evaluate((id) => {
      void window.__E2E__!.runCommand(id)
    }, DELETE_COMMAND)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
      .toBe(0)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpHistoryCount()), { timeout: 10_000 })
      .toBe(0)
    await expect.poll(() => sessionEditorUriCount(page)).toBe(0)
  })

  test('asks before deleting — Cancel keeps the session, Delete removes it', async ({
    page,
    workbench,
  }) => {
    await prepare(page, workbench)
    await page.evaluate(() =>
      window.__E2E__!.runCommand(
        '_workbench.updateConfiguration',
        'acp.sessions.confirmDelete',
        true,
      ),
    )
    await startEchoSession(page)

    const dialog = page.getByRole('dialog')
    await page.evaluate((id) => {
      void window.__E2E__!.runCommand(id)
    }, DELETE_COMMAND)
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog).toContainText('Delete this session?')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    // Zero side effects on cancel: the session, its history row and its tab stay.
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(1)
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpHistoryCount())).toBe(1)
    expect(await sessionEditorUriCount(page)).toBe(1)

    await page.evaluate((id) => {
      void window.__E2E__!.runCommand(id)
    }, DELETE_COMMAND)
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
      .toBe(0)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpHistoryCount()), { timeout: 10_000 })
      .toBe(0)
    await expect.poll(() => sessionEditorUriCount(page)).toBe(0)
  })

  test('lists the command only while a session editor is in front', async ({ page, workbench }) => {
    await prepare(page, workbench)
    await startEchoSession(page)

    const openPalette = async (): Promise<void> => {
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.showCommands')
      })
      await workbench.quickInput.waitForVisible()
      await expect(workbench.quickInput.input).toBeFocused()
      await page.keyboard.type(DELETE_COMMAND)
    }

    await openPalette()
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /Delete Agent Session/ }),
    ).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('acp.session')
    await openPalette()
    await expect(workbench.quickInput.dialog).toBeVisible()
    await expect(
      workbench.quickInput.dialog.getByRole('option', { name: /Delete Agent Session/ }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
