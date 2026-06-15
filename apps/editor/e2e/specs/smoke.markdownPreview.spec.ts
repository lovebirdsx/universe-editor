/*---------------------------------------------------------------------------------------------
 *  S — Markdown preview (P1).
 *
 *  验证 markdown 预览命令：
 *    1. 打开一个 .md 文件 → activeEditorLanguageId == 'markdown'
 *    2. "Open Preview" → 当前组只剩 markdown.preview，源文件 tab 消失
 *    3. "Open Source" → 从预览切回，当前组只剩源文件 tab
 *    4. "Open Preview to the Side" → 分裂出新组，活动编辑器为 markdown.preview
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function writeTempMarkdown(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'note.md')
  writeFileSync(file, '# Title\n\nsome **bold** text\n\n1. Alpha\n\n2. Beta\n\n3. Gamma\n')
  return file.replace(/\\/g, '/')
}

function writeTempMarkdownWithHeadings(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'outline.md')
  writeFileSync(file, '# Alpha\n\ntext\n\n## Beta\n\nmore\n\n## Gamma\n\nend\n')
  return { dir: dir.replace(/\\/g, '/'), filePath: file.replace(/\\/g, '/') }
}

test.describe('@p1 markdown preview', () => {
  test('Open Preview replaces source tab with preview tab', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // Source tab must be gone — only the preview remains
    await expect
      .poll(() => workbench.getContextKey<number>('groupEditorsCount'), { timeout: 5000 })
      .toBe(1)
  })

  test('Open Source switches back from preview to source', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await workbench.runCommand('workbench.action.markdown.showSource')

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    // Preview tab must be gone — only the source remains
    await expect
      .poll(() => workbench.getContextKey<number>('groupEditorsCount'), { timeout: 5000 })
      .toBe(1)
  })

  test('Open Preview to the Side splits into a new group', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreviewToSide')

    await expect
      .poll(() => workbench.getContextKey<boolean>('editorPartMultipleEditorGroups'), {
        timeout: 5000,
      })
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')
  })

  test('Light theme keeps headings and ordered lists readable in preview', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(() => window.__E2E__!.updateConfigValue('workbench.colorTheme', 'light'))
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light')

    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    const styles = await page.evaluate(() => {
      const preview = document.querySelector('[data-testid="markdown-preview"]')
      const heading = preview?.querySelector('h1')
      const strong = preview?.querySelector('strong')
      const ol = preview?.querySelector('ol')
      const items = Array.from(ol?.querySelectorAll('li') ?? [])
      return {
        headingColor: heading ? getComputedStyle(heading).color : '',
        strongColor: strong ? getComputedStyle(strong).color : '',
        olDisplay: ol ? getComputedStyle(ol).display : '',
        liDisplays: items.map((item) => getComputedStyle(item).display),
        listStyleTypes: items.map((item) => getComputedStyle(item).listStyleType),
      }
    })

    expect(styles.headingColor).toBe('rgb(17, 19, 24)')
    expect(styles.strongColor).toBe('rgb(17, 19, 24)')
    expect(styles.olDisplay).toBe('block')
    expect(styles.liDisplays).toEqual(['list-item', 'list-item', 'list-item'])
    expect(styles.listStyleTypes).toEqual(['decimal', 'decimal', 'decimal'])
  })

  test('Outline stays populated after switching to preview', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeTempMarkdownWithHeadings()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)

    // Reveal + focus the Outline view so its DOM renders.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })

    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    // Outline fills in for the source editor (markdown plugin provides symbols;
    // names carry the heading markup, VSCode parity).
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 20000 })
      .toEqual(['# Alpha', '## Beta', '## Gamma'])

    await workbench.runCommand('workbench.action.markdown.openPreview')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // Same outline must remain available in preview mode.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), { timeout: 10000 })
      .toEqual(['# Alpha', '## Beta', '## Gamma'])
  })
})
