/*---------------------------------------------------------------------------------------------
 *  Auxiliary editor windows — real cross-realm DOM guards.
 *
 *  Auxiliary windows are separate JS realms: their elements fail the main
 *  realm's `instanceof Element/HTMLElement/Node`. happy-dom cannot reproduce
 *  that (its `new Window()` shares constructors), so these tests drive the real
 *  Electron child window and assert the user-visible consequences: tooltips,
 *  Shift-drop deferral, prompt-drop overlay suppression, code-block file links
 *  and config-option popover/focus ownership.
 *
 *  Synthetic drag events are used for the same reason as in
 *  smoke.auxiliaryEditorWindow.spec.ts: CDP cannot start a native OS drag.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { ElectronApplication, Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

async function waitForAuxWindow(
  electronApp: ElectronApplication,
  workbench: { runCommand(id: string, ...args: unknown[]): Promise<unknown> },
  command: string,
): Promise<Page> {
  const pagePromise = electronApp.waitForEvent('window')
  await workbench.runCommand(command)
  const child = (await pagePromise) as Page
  await child.waitForLoadState('domcontentloaded')
  await expect(child.locator('[data-testid="part-editorArea"]')).toBeVisible()
  return child
}

async function auxWindows(page: Page) {
  return page.evaluate(() => window.__E2E__!.getAuxiliaryWindows())
}

/** Synthesize a resource dragover whose target is `selector` in `target`. */
async function dragOver(target: Page, selector: string, shiftKey: boolean): Promise<void> {
  await target.evaluate(
    ({ selector, shiftKey }) => {
      const el = document.querySelector<HTMLElement>(selector)
      if (!el) throw new Error(`drag target not found: ${selector}`)
      const rect = el.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/uri-list', 'file:///tmp/realm-drag.txt')
      el.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          composed: true,
          shiftKey,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + 20,
          dataTransfer,
        }),
      )
    },
    { selector, shiftKey },
  )
}

function overlayCount(target: Page): Promise<number> {
  return target.locator('[data-testid="editor-group-drop-overlay"]').count()
}

test.describe('@p1 auxiliary editor windows — cross-realm DOM', () => {
  test.use({
    workspaceSeeder: {
      seed(dir: string) {
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
        writeFileSync(join(dir, 'doc.md'), '# Doc\n')
      },
    },
  })

  test('tooltip follows the auxiliary document realm', async ({ electronApp, page, workbench }) => {
    test.skip(process.platform === 'darwin', 'custom window controls are hidden on macOS')
    await workbench.waitForRestored()
    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.newEmptyEditorWindow',
    )

    const titlebarButtons = child.locator('[data-testid="auxiliary-titlebar"] [data-tooltip]')
    await expect(titlebarButtons.first()).toBeVisible()
    await titlebarButtons.first().focus()

    // Before the shape check, the foreign-realm event target was not an
    // `Element` to the main realm, so no theme tooltip ever opened.
    await expect(child.locator('[role="tooltip"]')).toBeVisible({ timeout: 5000 })
    expect(await page.locator('[role="tooltip"]').count()).toBe(0)
  })

  test('markdown Shift-drop defers to Monaco in the auxiliary window', async ({
    electronApp,
    page,
    workbench,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    if (!launchWorkspace) throw new Error('workspace seeder did not run')
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), launchWorkspace.file('doc.md'))
    await expect(workbench.editor.monacoEditor).toBeVisible()

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await expect(child.locator('.monaco-editor').first()).toBeVisible()

    // Positive control: a resource drag over the body paints the "open here"
    // overlay.
    await dragOver(child, '[data-testid="editor-group-body"]', true)
    await expect.poll(() => overlayCount(child), { timeout: 3000 }).toBe(1)

    // Over the Monaco text area with Shift, Monaco owns the drop (insert link).
    // Before the shape check this was misread as an outside target and the body
    // overlay stayed up, so a Shift-drop also opened the file.
    await dragOver(child, '.monaco-editor', true)
    await expect.poll(() => overlayCount(child), { timeout: 3000 }).toBe(0)
  })

  test('chat controls in the auxiliary window use its document and realm', async ({
    electronApp,
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    await page.evaluate(([id, p, env]) => window.__E2E__!.installAcpEchoAgent(id, p, env), [
      'echo',
      ECHO_AGENT_PATH,
      { ECHO_AGENT_CONFIG_OPTIONS: '1' },
    ] as const)
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10000 })
      .toBe('idle')
    await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('acp-config-model-trigger')).toBeAttached({ timeout: 5000 })

    // The echo fixture prefixes "echo: ", so start with a newline to put the
    // fence at the beginning of a line. A path inside a comment stays one
    // Monaco token span, which CodeBlock's linkifier can split; a bare path in
    // a ts fence is tokenized across several spans and intentionally stays plain.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('\n```ts\n// see src/a.ts\n```'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), { timeout: 10000 })
      .toBe(2)
    await expect(page.getByTestId('md-codeblock-filepath').first()).toBeVisible({
      timeout: 10000,
    })

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await expect(child.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10000 })

    // The linkifier rebuilds the anchor from the child document after the move,
    // so the anchor belongs to the child realm.
    await expect(child.getByTestId('md-codeblock-filepath')).toHaveCount(1, { timeout: 10000 })

    // 1. Prompt-host dragover: the body overlay must not also glow. Before the
    //    shape check the foreign-realm target was not an HTMLElement, so the
    //    overlay stayed on.
    await dragOver(child, '[data-testid="editor-group-body"]', false)
    await expect.poll(() => overlayCount(child), { timeout: 3000 }).toBe(1)
    await dragOver(child, '[data-testid="acp-prompt-drop-host"]', false)
    await expect.poll(() => overlayCount(child), { timeout: 3000 }).toBe(0)

    // 2. Config popover: it must portal into the child document and Escape must
    //    hand focus back to the child trigger.
    const trigger = child.getByTestId('acp-config-model-trigger')
    await trigger.click()
    await expect(child.getByTestId('acp-config-model-popover')).toBeVisible()
    expect(await page.getByTestId('acp-config-model-popover').count()).toBe(0)

    await child.keyboard.press('Escape')
    await expect(child.getByTestId('acp-config-model-popover')).toHaveCount(0)
    await expect
      .poll(() => child.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null))
      .toBe('acp-config-model-trigger')

    // 3. Code-block file link: the anchor was created by the child document, so
    //    the main realm's `instanceof Element` rejects it; the shape check must
    //    still resolve the click and open the file.
    await child.getByTestId('md-codeblock-filepath').first().click()
    await expect.poll(() => workbench.getActiveEditorUri(), { timeout: 5000 }).toContain('src/a.ts')

    const token = (await auxWindows(page))[0]?.token
    if (!token) throw new Error('auxiliary window token missing')
    await page.evaluate((t) => window.__E2E__!.requestCloseAuxiliaryWindow(t), token)
    await expect.poll(async () => (await auxWindows(page)).length).toBe(0)
  })
})
