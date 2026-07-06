/*---------------------------------------------------------------------------------------------
 *  ACP prompt Enter-leak smoke (@p1) — regression guard.
 *
 *  Repro (user report): open a folder + a .ts file, Enter inserts a newline.
 *  Bring up an agent session as an editor tab, then switch back to the .ts file —
 *  Enter silently stops working there. Markdown files are unaffected.
 *
 *  Root cause: PromptMonacoEditor used `editor.addCommand(KeyCode.Enter, …)` on a
 *  standalone Monaco editor. That registers on Monaco's SHARED standalone
 *  keybinding service with no editor scope, so it fired for Enter in EVERY Monaco
 *  editor — including file editors — running the prompt's onEnter handler
 *  (submit/no-op), swallowing the newline. Markdown has its own higher-weight
 *  `markdown.editing.onEnter` binding that claims Enter in the global handler
 *  before it ever reaches Monaco's dispatch, so it looked language-specific.
 *
 *  Fix: handle Enter in the prompt editor's own DOM keydown listener (scoped to
 *  its node), like the ArrowUp/Tab handlers already are. This spec drives the
 *  real keyboard path and asserts Enter still inserts a newline in the .ts editor
 *  after a session editor comes and goes.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 agents prompt enter leak', () => {
  test('Enter keeps inserting a newline in a .ts editor after a session editor comes and goes @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const wsDir = mkdtempSync(join(tmpdir(), 'universe-editor-enter-leak-'))
    const tsFile = join(wsDir, 'hello.ts')
    writeFileSync(tsFile, 'const a = 1\n', 'utf8')

    const focusFileEditor = async (): Promise<void> => {
      await page.evaluate(() =>
        window.__E2E__!.runCommand('workbench.action.focusActiveEditorGroup'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')), {
          timeout: 5000,
        })
        .toBe(true)
      await workbench.setActiveEditorCursor(1, 1)
    }

    try {
      await workbench.openWorkspace(wsDir)

      // 1. Open hello.ts; a real keyboard Enter inserts a newline.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), tsFile)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 10000,
        })
        .toBe('file')
      await focusFileEditor()
      await page.keyboard.press('Enter')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
        .toBe('\nconst a = 1\n')

      // 2. Bring up an agent session and open it as an editor tab, then focus its
      //    prompt input — this is where the global Enter command used to install.
      await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
        'echo',
        ECHO_AGENT_PATH,
      ] as const)
      await page.evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.agent.newSession'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
        .toBe(1)
      await page.evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.agent.openInEditor'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 10000,
        })
        .toBe('acp.session')
      await page.evaluate(
        () => void window.__E2E__!.runCommand('workbench.action.agent.focusInput'),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')), {
          timeout: 5000,
        })
        .toBe(true)

      // 3. Switch back to hello.ts and confirm Enter STILL inserts a newline.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), tsFile)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 10000,
        })
        .toBe('file')
      await focusFileEditor()
      const before = await workbench.getActiveEditorText()
      await page.keyboard.press('Enter')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()))
        .toBe(`\n${before}`)
    } finally {
      await page.evaluate(() => window.__E2E__!.closeWorkspace()).catch(() => {})
      try {
        rmSync(wsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    }
  })
})
