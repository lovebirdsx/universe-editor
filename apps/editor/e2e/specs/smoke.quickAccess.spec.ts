/*---------------------------------------------------------------------------------------------
 *  S? — Unified QuickAccess prefix routing (P0).
 *
 *  workbench.action.quickOpen 是统一入口, 按输入框前缀路由 provider:
 *  空 = 文件, '@' = 当前文件符号, '>' = 命令, '#' = 工作区符号. 切换前缀时
 *  placeholder 随之变化. gotoSymbol / showAllSymbols 命令直接 prefill 对应前缀.
 *  长任务命令均 fire-and-forget, 避免 await-on-pick 死锁.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { URI } from '@universe-editor/platform'
import { expect, test } from '../fixtures/sharedApp.js'

async function placeholderOf(input: import('@playwright/test').Locator): Promise<string | null> {
  return input.getAttribute('placeholder')
}

test.describe('@p0 quick access', () => {
  // Same bootstrap-focus-restore gate as smoke.commandPalette: typing/focus
  // assertions below must not race the late Explorer focus steal.
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test('quickOpen opens in file mode (empty value) and closes via Escape', async ({
    page,
    workbench,
  }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toBeFocused()
    await expect(workbench.quickInput.input).toHaveValue('')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('lists open non-text editors and activates them on accept', async ({ page, workbench }) => {
    // Settings is a virtual (non-text) editor; the untitled file opened second
    // becomes active so accepting the Settings pick observably switches back.
    await workbench.runCommand('workbench.action.openSettings')
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()

    // Empty query: open editors are listed, including non-text ones.
    const settingsOption = workbench.quickInput.dialog.getByRole('option', { name: /Settings/ })
    await expect(settingsOption).toBeVisible()

    // Typing matches the open editor; Enter activates its tab.
    await workbench.quickInput.input.fill('Settings')
    await expect(settingsOption).toBeVisible()
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getActiveEditorUri()).toBe('universe:/settings')
  })

  test('switches placeholder as the leading prefix changes', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    const filePlaceholder = await placeholderOf(workbench.quickInput.input)

    await page.keyboard.type('@')
    await expect(workbench.quickInput.input).toHaveValue('@')
    await expect.poll(() => placeholderOf(workbench.quickInput.input)).not.toBe(filePlaceholder)
    const symbolPlaceholder = await placeholderOf(workbench.quickInput.input)

    // Replace '@' with '>' → command mode, a distinct placeholder again.
    await workbench.quickInput.input.fill('>')
    await expect(workbench.quickInput.input).toHaveValue('>')
    await expect.poll(() => placeholderOf(workbench.quickInput.input)).not.toBe(symbolPlaceholder)

    // Delete back to empty → file mode placeholder restored.
    await workbench.quickInput.input.fill('')
    await expect.poll(() => placeholderOf(workbench.quickInput.input)).toBe(filePlaceholder)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('gotoSymbol prefills the @ prefix', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.gotoSymbol')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('@')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('showAllSymbols prefills the # prefix', async ({ page, workbench }) => {
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showAllSymbols')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('#')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('typing after the prefilled filter appends instead of replacing @regression', async ({
    page,
    workbench,
  }) => {
    // The '#' picker prefills the filter with the editor selection / word under
    // the cursor and selects it. Regression: after the first keystroke replaced
    // the selection, the provider's busy/items state updates re-broadcast the
    // stale valueSelection and the panel re-applied it over the just-typed
    // text — so every further keystroke replaced again ('#Test' → i → '#i' →
    // n → '#n' instead of '#in').
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-quickaccess-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const TestValue = 1\n')
    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)
    await page.evaluate(
      ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
      [path.join(tmpDir, 'a.ts')],
    )
    await expect(workbench.editor.monacoEditor).toBeVisible()
    // Select 'TestValue' (columns 7–15) so the prefill uses the selection.
    await workbench.setActiveEditorSelection(1, 7, 1, 16)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.showAllSymbols')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('#TestValue')
    // The prefilled filter text is selected, so the first keystroke replaces it.
    const selection = await workbench.quickInput.input.evaluate((el) => [
      (el as HTMLInputElement).selectionStart,
      (el as HTMLInputElement).selectionEnd,
    ])
    expect(selection).toEqual([1, 10])

    await page.keyboard.type('a')
    await expect(workbench.quickInput.input).toHaveValue('#a')
    // Wait past the provider debounce (150ms) so its busy/items state updates
    // land — the stale-selection re-apply rode those pushes.
    await page.waitForTimeout(400)
    await page.keyboard.type('b')
    await expect(workbench.quickInput.input).toHaveValue('#ab')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('ctrl+enter opens the picked file to the side', async ({ page, workbench }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-quickside-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export const a = 1\n')
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'export const b = 2\n')
    try {
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await page.evaluate(
        ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
        [path.join(tmpDir, 'a.ts')],
      )
      await expect(workbench.editor.monacoEditor).toBeVisible()
      await expect.poll(() => workbench.getEditorGroupCount()).toBe(1)

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpen')
      })
      await workbench.quickInput.waitForVisible()
      await workbench.quickInput.input.fill('b.ts')
      const bOption = workbench.quickInput.dialog.getByRole('option', { name: /b\.ts/ })
      await expect(bOption).toBeVisible()

      await page.keyboard.press('Control+Enter')
      await workbench.quickInput.waitForHidden()

      // A second group opened to the side and became active, showing b.ts.
      await expect.poll(() => workbench.getEditorGroupCount()).toBe(2)
      await expect
        .poll(() => workbench.getActiveEditorUri())
        .toBe(URI.file(path.join(tmpDir, 'b.ts')).toString())
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test('reopening a just-closed file restores the exact editor type @regression', async ({
    page,
    workbench,
  }) => {
    // Regression: closing a non-default editor type and reopening the file via
    // quick open re-guessed the type through the resolver (priority 100 dummy
    // editor wins back) instead of restoring the "Reopen With" choice.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-quickrestore-'))
    await fs.writeFile(path.join(tmpDir, 'chart.dummy'), '')
    try {
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await page.evaluate(() => {
        window.__E2E__!.registerDummyEditor('**/*.dummy', 'dummyEditor')
      })
      const dummyFsPath = path.join(tmpDir, 'chart.dummy').replace(/\\/g, '/')
      await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), dummyFsPath)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 5000,
        })
        .toBe('dummyEditor')

      // "Reopen With..." → switch to the plain file editor (explicit choice).
      // The resource must be canonical UriComponents (URI.toJSON): a hand-built
      // `{ path: 'C:/...' }` without the leading slash stringifies to the
      // parse-unstable `file://C:/...`, which breaks resource identity downstream.
      await page.evaluate((fsPath) => {
        const path = '/' + fsPath.replace(/\\/g, '/')
        const uri = { scheme: 'file', path, authority: '', query: '', fragment: '' }
        void window.__E2E__!.runCommand('workbench.action.reopenWith', { resource: uri })
      }, dummyFsPath)
      await workbench.quickInput.waitForVisible()
      await page.keyboard.type('File')
      const fileOption = page.getByRole('option', { name: 'File Editor' })
      await expect(fileOption).toBeVisible()
      await page.keyboard.press('Enter')
      await workbench.quickInput.waitForHidden()
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 5000,
        })
        .toBe('file')

      // Close the tab, then reopen through quick open.
      await workbench.runCommand('workbench.action.closeActiveEditor')
      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpen')
      })
      await workbench.quickInput.waitForVisible()
      await workbench.quickInput.input.fill('chart.dummy')
      // The just-closed file entry and its closed-editor entry share one
      // resource, so two same-named picks can appear; accepting the first
      // restores the exact closed type ('file'), not re-resolve to dummyEditor.
      const chartOption = workbench.quickInput.dialog
        .getByRole('option', { name: /chart\.dummy/ })
        .first()
      await expect(chartOption).toBeVisible()
      await page.keyboard.press('Enter')
      await workbench.quickInput.waitForHidden()

      // Must restore the exact closed type ('file'), not re-resolve to dummyEditor.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 5000,
        })
        .toBe('file')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test('a closed markdown preview stays listed in quick open and restores on accept @regression', async ({
    page,
    workbench,
  }) => {
    // Regression: closing a virtual-scheme editor (markdown-preview:) removed it
    // from quick open entirely; reopening the .md file went through the resolver
    // and could never bring the preview back.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-quickclosed-'))
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Hello\n')
    try {
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await page.evaluate(
        ([fsPath]) => window.__E2E__!.openFileUri(fsPath!, { pinned: true }),
        [path.join(tmpDir, 'a.md')],
      )
      await workbench.runCommand('workbench.action.markdown.openPreviewToSide')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 5000,
        })
        .toBe('markdown.preview')

      // Close the preview tab — the source .md tab stays open.
      await workbench.runCommand('workbench.action.closeActiveEditor')

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.quickOpen')
      })
      await workbench.quickInput.waitForVisible()
      await workbench.quickInput.input.fill('Preview')
      const previewOption = workbench.quickInput.dialog.getByRole('option', {
        name: /Preview a\.md/,
      })
      await expect(previewOption).toBeVisible()
      // Closed virtual-scheme entries carry the same resource icon as the open
      // editor pick (regression: the icon slot used to render empty).
      await expect(previewOption.getByTestId('quick-input-item-icon-slot')).toHaveAttribute(
        'data-icon-id',
        /^resource:markdown-preview:/,
      )
      await page.keyboard.press('Enter')
      await workbench.quickInput.waitForHidden()

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 5000,
        })
        .toBe('markdown.preview')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  test('restores editor focus after closing with Escape', async ({ page, workbench }) => {
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await workbench.runCommand('workbench.action.focusActiveEditorGroup')
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(false)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => workbench.getContextKey<boolean>('editorFocus')).toBe(true)
  })
})
