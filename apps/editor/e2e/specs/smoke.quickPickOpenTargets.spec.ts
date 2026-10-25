/*---------------------------------------------------------------------------------------------
 *  Quick pick open targets: Ctrl+Enter opens to the side, Alt+Enter opens in a
 *  new auxiliary editor window (@p1). Covers file picks, session picks and the
 *  command palette (an editor-opening command honours the accept modifiers).
 *
 *  Geometry (which display / fullscreen) is covered by the main-process unit
 *  tests; a CI box usually has one display, so the appearance assertions here
 *  are limited to "an auxiliary window exists and owns the editor".
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import { URI } from '@universe-editor/platform'
import { expect, test } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function editorUrisInWindow(page: Page, main: boolean): Promise<string[]> {
  return page.evaluate((isMain) => {
    const probe = window.__E2E__!
    const win = probe.getWorkbenchWindows().find((w) => w.isMain === isMain)
    if (!win) return []
    return win.groupIds.flatMap((id) => probe.getEditorGroupEditorUris(String(id)))
  }, main)
}

async function startEchoSession(page: Page): Promise<string> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
    .toBe(1)
  await page.evaluate(() => window.__E2E__!.sendAcpPrompt('remember me'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 10_000 })
    .toHaveLength(2)
  // The resume picker lists durable history rows; wait for the handshake row
  // so the command doesn't take the "no previous sessions" early return.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpHistoryCount()), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1)
  const sessionId = await page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
  expect(sessionId).toBeTruthy()
  return `universe:/acp/session/${sessionId}`
}

async function openResumePicker(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.resumeSession')
  })
  await workbench.quickInput.waitForVisible()
  await expect(workbench.quickInput.dialog.getByRole('option').first()).toBeVisible()
}

const STARTUP_PERF_URI = 'startup-performance:/'

async function runFromPalette(page: Page, workbench: WorkbenchPO, keys: string): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.showCommands')
  })
  await workbench.quickInput.waitForVisible()
  await workbench.quickInput.input.fill('>Startup Performance')
  await expect(
    workbench.quickInput.dialog.getByRole('option', { name: /Startup Performance/ }).first(),
  ).toBeVisible()
  await page.keyboard.press(keys)
  await workbench.quickInput.waitForHidden()
}

test.describe('@p1 quick pick open targets', () => {
  test.describe('command palette', () => {
    test('Ctrl+Enter opens the page to the side, again moves it instead of copying', async ({
      page,
      workbench,
    }) => {
      await workbench.waitForRestored()
      await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)

      await runFromPalette(page, workbench, 'Control+Enter')

      await expect.poll(() => workbench.getEditorGroupCount(), { timeout: 10_000 }).toBe(2)
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__E2E__!.getEditorGroupEditorUris(String(window.__E2E__!.getActiveGroupId())),
          ),
        )
        .toContain(STARTUP_PERF_URI)

      await runFromPalette(page, workbench, 'Control+Enter')

      await expect
        .poll(async () =>
          (await editorUrisInWindow(page, true)).filter((uri) => uri === STARTUP_PERF_URI),
        )
        .toHaveLength(1)
      expect(await workbench.getEditorGroupCount()).toBe(2)
    })

    test('Alt+Enter opens the page in an auxiliary window', async ({ page, workbench }) => {
      await workbench.waitForRestored()

      await runFromPalette(page, workbench, 'Alt+Enter')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAuxiliaryWindows().length), {
          timeout: 10_000,
        })
        .toBe(1)
      await expect
        .poll(() =>
          page.evaluate(() =>
            window
              .__E2E__!.getAuxiliaryWindows()[0]!
              .groups.flatMap((g) => g.editorUris)
              .join('|'),
          ),
        )
        .toContain(STARTUP_PERF_URI)
      expect(await editorUrisInWindow(page, true)).not.toContain(STARTUP_PERF_URI)
    })
  })

  test.describe('file pick', () => {
    test.use({
      workspaceSeeder: {
        seed(dir) {
          writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
          writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
        },
      },
    })

    test('Alt+Enter on a file pick opens it in an auxiliary window', async ({
      page,
      workbench,
      launchWorkspace,
    }) => {
      if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
      const aPath = launchWorkspace.file('a.ts')
      const bPath = launchWorkspace.file('b.ts')
      await workbench.waitForRestored()
      await page.evaluate(
        ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
        [aPath],
      )
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpen')
      })
      await workbench.quickInput.waitForVisible()
      await workbench.quickInput.input.fill('b.ts')
      await expect(workbench.quickInput.dialog.getByRole('option', { name: /b\.ts/ })).toBeVisible()

      await page.keyboard.press('Alt+Enter')
      await workbench.quickInput.waitForHidden()

      const bUri = URI.file(bPath).toString()
      // One auxiliary window, owning b.ts; the main window keeps a.ts and its
      // single group (files are copied, so a.ts stays where it was).
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAuxiliaryWindows().length), {
          timeout: 10_000,
        })
        .toBe(1)
      await expect
        .poll(() =>
          page.evaluate(() =>
            window
              .__E2E__!.getAuxiliaryWindows()[0]!
              .groups.flatMap((g) => g.editorUris)
              .join('|'),
          ),
        )
        .toContain(bUri)
      expect(await editorUrisInWindow(page, true)).not.toContain(bUri)
      expect(await editorUrisInWindow(page, true)).toContain(URI.file(aPath).toString())
    })
  })

  test('Ctrl+Enter on a Resume pick opens the session in a side group', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const sessionUri = await startEchoSession(page)
    await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)
    const beforeGroupId = await workbench.getActiveGroupId()

    await openResumePicker(page, workbench)
    await page.keyboard.press('Control+Enter')
    await workbench.quickInput.waitForHidden()

    // The session is globally unique: the side group receives it and the
    // original tab is closed (closeDuplicateSessionEditors). It was the only
    // tab in the source group, so that group collapses — the assert is the new
    // group id, not a group count of 2.
    await expect
      .poll(() => workbench.getActiveGroupId(), { timeout: 10_000 })
      .not.toBe(beforeGroupId)
    await expect
      .poll(() =>
        page.evaluate(
          (uri) =>
            window
              .__E2E__!.getEditorGroupEditorUris(String(window.__E2E__!.getActiveGroupId()))
              .includes(uri),
          sessionUri,
        ),
      )
      .toBe(true)
    expect((await editorUrisInWindow(page, true)).filter((uri) => uri === sessionUri)).toHaveLength(
      1,
    )
  })

  test('Alt+Enter on a Resume pick moves the session into an auxiliary window', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const sessionUri = await startEchoSession(page)

    await openResumePicker(page, workbench)
    await page.keyboard.press('Alt+Enter')
    await workbench.quickInput.waitForHidden()

    // Moved, not copied: the tab leaves the main window and appears in the
    // auxiliary window.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAuxiliaryWindows().length), {
        timeout: 15_000,
      })
      .toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window
            .__E2E__!.getAuxiliaryWindows()[0]!
            .groups.flatMap((g) => g.editorUris)
            .join('|'),
        ),
      )
      .toContain(sessionUri)
    expect(await editorUrisInWindow(page, true)).not.toContain(sessionUri)
  })
})
