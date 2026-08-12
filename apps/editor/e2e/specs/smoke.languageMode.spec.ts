/*---------------------------------------------------------------------------------------------
 *  Language mode 冒烟（P1）。
 *
 *  对照 VSCode 的 Change Language Mode 链路：打开 .env 应由 resourceLanguage
 *  推断为 dotenv 并被 textmate-grammars 的 grammar 工厂接管 tokenization；
 *  状态栏语言项显示显示名且挂 changeLanguageMode 命令（点击即弹语言
 *  QuickPick）；选择新语言后 model 语言与状态栏同步，Auto Detect 按文件名
 *  推断回原语言。
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../fixtures/coreTextMateApp.js'

function seedEnvFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-langmode-'))
  const filePath = join(dir, '.env')
  writeFileSync(filePath, '# comment\nAPI_KEY=secret\n', 'utf8')
  return filePath
}

/** Poll until the TextMate grammar factory owns tokenization for `languageId`
 *  (same gate as smoke.textMate.spec.ts — pre-takeover there is no grammar
 *  coloring to speak of). */
async function waitForTextMateTakeover(page: Page, languageId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .evaluate((lang) => window.__E2E__!.getTokenizationSupportInfo(lang), languageId)
          .then((info) => info?.constructorName),
      { timeout: 30000 },
    )
    .toBe('TokenizationSupportWithLineLimit')
}

async function statusBarTexts(workbench: {
  statusBar: { entriesFromProbe(): Promise<Array<{ text: string }>> }
}): Promise<string[]> {
  const entries = await workbench.statusBar.entriesFromProbe()
  return entries.map((e) => e.text)
}

test.describe('@p1 language mode', () => {
  test.beforeEach(async ({ workbench }) => {
    await workbench.waitForBootstrapFocusSettled()
  })

  test('.env opens as dotenv with TextMate highlighting and a Dotenv status entry', async ({
    page,
    workbench,
  }) => {
    test.slow()
    const filePath = seedEnvFile()
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()

    await expect.poll(() => statusBarTexts(workbench)).toContain('Dotenv')
    await waitForTextMateTakeover(page, 'dotenv')
  })

  test('clicking the status bar language entry opens the language picker', async ({
    page,
    workbench,
  }) => {
    test.slow()
    const filePath = seedEnvFile()
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await expect.poll(() => statusBarTexts(workbench)).toContain('Dotenv')

    await workbench.statusBar.root.getByText('Dotenv', { exact: true }).click()
    await workbench.quickInput.waitForVisible()

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('change language mode switches the language and Auto Detect restores it', async ({
    page,
    workbench,
  }) => {
    test.slow()
    const filePath = seedEnvFile()
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
    await expect(workbench.editor.monacoEditor).toBeVisible()
    await expect.poll(() => statusBarTexts(workbench)).toContain('Dotenv')

    // The command awaits the user's pick — fire-and-forget to avoid deadlock.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.editor.changeLanguageMode')
    })
    await workbench.quickInput.waitForVisible()
    await page.keyboard.type('Markdown')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => statusBarTexts(workbench)).toContain('Markdown')

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.editor.changeLanguageMode')
    })
    await workbench.quickInput.waitForVisible()
    await page.keyboard.type('Auto Detect')
    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => statusBarTexts(workbench)).toContain('Dotenv')
  })
})
