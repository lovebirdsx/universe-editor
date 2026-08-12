/*---------------------------------------------------------------------------------------------
 *  ACP prompt selection-chip copy (@p1).
 *
 *  Repro for "a selection context chip attached to the prompt (before the first
 *  message is sent) has no right-click copy menu". Attaches an editor selection
 *  via Ctrl+K Ctrl+L's command, right-clicks the pending chip in the prompt
 *  area, and expects a Copy Text item that writes the snapshot to the clipboard.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 acp prompt selection chip copy', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(resolve(dir, 'selection.ts'), 'const first = 1\nconst selected = 2\n')
      },
    },
  })

  // @serial: verifies via the OS clipboard — a global resource shared across
  // workers.
  test(
    'right-clicking a pending selection chip offers Copy Text @regression',
    { tag: '@serial' },
    async ({ page, electronApp, workbench, launchWorkspace }) => {
      await workbench.waitForRestored()
      await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
        'echo',
        ECHO_AGENT_PATH,
      ] as const)

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
      await page.evaluate(() => window.__E2E__!.addActiveSelectionToAcpPrompt())
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
        .toBe(1)

      // The pending chip sits in the prompt area (nothing was sent yet).
      const chip = page.getByTestId('acp-selection-context-chip')
      await expect(chip).toHaveText('selection.ts:2')

      await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))

      await chip.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Copy Text' })
      await expect(item).toBeVisible({ timeout: 3000 })
      await item.click()

      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()), {
          timeout: 5000,
        })
        .toBe('const selected = 2')
    },
  )
})
