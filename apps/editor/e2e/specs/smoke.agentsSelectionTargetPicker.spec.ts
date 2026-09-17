/*---------------------------------------------------------------------------------------------
 *  "Add Selection to Existing Agent Chat" target picker (@p1).
 *
 *  With several chats open the command must ask which one — and the selection
 *  must land in the chosen chat, not the active one. With a single chat it must
 *  not ask at all. The new-chat sibling always opens one. Cancelling the picker
 *  must leave every chat untouched.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { LaunchWorkspace } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const EXISTING_CHAT_COMMAND = 'workbench.action.agent.addSelectionToExistingChat'
const NEW_CHAT_COMMAND = 'workbench.action.agent.addSelectionToNewChat'

async function installEchoAgent(page: Page): Promise<void> {
  await page.evaluate(([id, path, env]) => window.__E2E__!.installAcpEchoAgent(id, path, env), [
    'echo',
    ECHO_AGENT_PATH,
    { ECHO_AGENT_LOAD_SESSION: '1' },
  ] as const)
}

function sessionCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__E2E__!.getAcpSessionCount())
}

function activeSessionId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
}

/**
 * The existing-chat command blocks on the picker, so awaiting it here would
 * deadlock — specs drive the picker with real keystrokes instead.
 */
function startCommand(page: Page, id: string): Promise<void> {
  return page.evaluate((command) => void window.__E2E__!.runCommand(command), id)
}

/** Open a chat and resolve once it is registered, returning its local id. */
async function newSession(page: Page): Promise<string> {
  const before = await sessionCount(page)
  const beforeActive = await activeSessionId(page)
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
  await expect.poll(() => sessionCount(page), { timeout: 10000 }).toBe(before + 1)
  await expect.poll(() => activeSessionId(page), { timeout: 10000 }).not.toBe(beforeActive)
  return (await activeSessionId(page))!
}

/**
 * Open the seeded file and select its second line. Must run after the chats are
 * created: opening a chat activates its tab, stealing the editor area.
 */
async function openSelectedFile(page: Page, launchWorkspace: LaunchWorkspace | undefined) {
  if (!launchWorkspace) throw new Error('workspace seeder did not run')
  await page.evaluate(
    (file) => window.__E2E__!.openFileUri(file),
    launchWorkspace.file('selection.ts'),
  )
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 5000 })
    .toContain('selection.ts')
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorSelection(2, 1, 2, 19)))
    .toBe(true)
}

test.describe('@p1 agents selection target picker', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'selection.ts'), 'const first = 1\nconst selected = 2\n')
      },
    },
  })

  test('asks which chat and delivers to the chosen one', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await installEchoAgent(page)
    const idA = await newSession(page)
    const idB = await newSession(page)
    expect(idA).not.toBe(idB)
    await openSelectedFile(page, launchWorkspace)

    await startCommand(page, EXISTING_CHAT_COMMAND)

    await workbench.quickInput.waitForVisible()
    // ArrowDown/Enter are handled by the panel, so the keys only mean anything
    // once its input owns focus — otherwise they hit the editor behind it.
    await expect(workbench.quickInput.input).toBeFocused()
    const options = workbench.quickInput.dialog.getByRole('option')
    await expect(options).toHaveCount(2)
    // The active chat leads, so A — the other one — is the second row.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()

    await expect.poll(() => activeSessionId(page), { timeout: 10000 }).toBe(idA)
    expect(await sessionCount(page)).toBe(2)
    await expect(page.getByTestId('acp-selection-context-chip')).toHaveText('selection.ts:2')
  })

  test('does not ask when a single chat is open', async ({ page, workbench, launchWorkspace }) => {
    await workbench.waitForRestored()
    await installEchoAgent(page)
    const idA = await newSession(page)
    await openSelectedFile(page, launchWorkspace)

    await startCommand(page, EXISTING_CHAT_COMMAND)

    await expect.poll(() => activeSessionId(page), { timeout: 10000 }).toBe(idA)
    await expect(page.getByTestId('acp-selection-context-chip')).toHaveText('selection.ts:2')
    await expect(workbench.quickInput.dialog).toBeHidden()
    expect(await sessionCount(page)).toBe(1)
  })

  test('opens a fresh chat instead of reusing the open one', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await installEchoAgent(page)
    const idA = await newSession(page)
    await openSelectedFile(page, launchWorkspace)

    await startCommand(page, NEW_CHAT_COMMAND)

    await expect.poll(() => sessionCount(page), { timeout: 10000 }).toBe(2)
    expect(await activeSessionId(page)).not.toBe(idA)
    await expect(page.getByTestId('acp-selection-context-chip')).toHaveText('selection.ts:2')
  })

  test('cancelling the picker leaves every chat untouched', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await installEchoAgent(page)
    await newSession(page)
    const idB = await newSession(page)
    await openSelectedFile(page, launchWorkspace)

    await startCommand(page, EXISTING_CHAT_COMMAND)
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.dialog.getByRole('option')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    expect(await sessionCount(page)).toBe(2)
    expect(await activeSessionId(page)).toBe(idB)
    await expect(page.getByTestId('acp-selection-context-chip')).toBeHidden()
  })
})
