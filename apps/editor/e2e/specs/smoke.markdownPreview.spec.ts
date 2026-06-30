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

function writeLinkedMarkdown(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'index.md')
  // A single markdown→markdown link so exactly one link hint is generated,
  // making the typed label deterministic ('a', the first home-row char).
  writeFileSync(file, '# Index\n\n[go to target](target.md)\n')
  writeFileSync(join(dir, 'target.md'), '# Target\n\nbody\n')
  return { dir: dir.replace(/\\/g, '/'), filePath: file.replace(/\\/g, '/') }
}

function writeLongMarkdown(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'long.md')
  // Many paragraphs so the preview scrolls well beyond one viewport.
  const body = Array.from({ length: 200 }, (_, i) => `paragraph ${i} lorem ipsum dolor sit amet`)
  writeFileSync(file, `# Long\n\n${body.join('\n\n')}\n`)
  return file.replace(/\\/g, '/')
}

/**
 * Press the real `f` key until link hints render. This deliberately drives the
 * full keybinding path (global keydown handler → keybinding service → action →
 * controller → hook), because that path regressed once: a stuck `editorTextFocus`
 * made the handler treat the preview as a text surface and swallow `f`. Using a
 * real key (not the command) is what guards that regression. A lone synthetic
 * keypress can still be dropped while the window settles focus, and once hints
 * are up a second `f` would be consumed as a filter char — so re-press ONLY while
 * still hidden. The window must own OS focus first or keys are dropped entirely.
 */
async function showLinkHints(
  page: import('@playwright/test').Page,
  workbench: { getContextKey<T>(k: string): Promise<T> },
): Promise<void> {
  await page.bringToFront()
  await expect
    .poll(
      async () => {
        if (await workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible')) return true
        await page.keyboard.press('f')
        return workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible')
      },
      { timeout: 8000 },
    )
    .toBe(true)
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

  test('Link hints (f) appear without a prior click and navigate to the target', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeLinkedMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await page.bringToFront()

    // The rendered link must be present before we drive the keyboard.
    await expect(page.locator('[data-testid="markdown-preview"] a').first()).toBeVisible()

    // Regression: the preview auto-focuses on open, so `markdownPreviewFocused`
    // is true WITHOUT any manual click. (Before the focus-reconcile fix this
    // stayed false until the user clicked, so `f` did nothing.)
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()

    // Single link → label 'a'. Typing it (a real key, routed through the hints'
    // own capture-phase keyboard handler) follows the link, opening target.md as
    // a preview in place (markdown→markdown preview navigation).
    const label = await page.evaluate(
      () =>
        document.querySelector('[data-testid="md-link-hint"]')?.getAttribute('data-link-label') ??
        '',
    )
    expect(label).toBe('a')

    // Re-press while hints are still up (a lone synthetic key can be dropped);
    // activation hides them, so this stops as soon as it lands.
    await expect
      .poll(
        async () => {
          if (await workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible')) {
            await page.keyboard.press('a')
          }
          return page.evaluate(() => window.__E2E__!.getActiveEditorUri())
        },
        { timeout: 5000 },
      )
      .toEqual(expect.stringContaining('target.md'))
    // Hints must be gone after activation.
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible'))
      .toBe(false)
  })

  test('Link hints dismiss on Escape', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeLinkedMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await expect(page.locator('[data-testid="markdown-preview"] a').first()).toBeVisible()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    await page.bringToFront()
    await showLinkHints(page, workbench)

    // Escape (a real key through the hints' capture handler) dismisses them.
    // Re-press while still visible so a dropped synthetic key self-heals.
    await expect
      .poll(
        async () => {
          await page.keyboard.press('Escape')
          return workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible')
        },
        { timeout: 5000 },
      )
      .toBe(false)
    // Escape must not have navigated away from the index preview.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()))
      .toEqual(expect.stringContaining('index.md'))
  })

  test('Vim keys scroll the preview (j / gg)', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const mdFsPath = writeLongMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await expect(page.locator('[data-testid="markdown-preview"] h1').first()).toBeVisible()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)
    await page.bringToFront()

    const scrollTop = () =>
      page.evaluate(
        () => document.querySelector('[data-testid="markdown-preview"]')?.scrollTop ?? 0,
      )

    // Pressing `j` scrolls down. Re-press while still at the top so a dropped
    // synthetic key self-heals; smooth scrolling settles asynchronously.
    await expect
      .poll(
        async () => {
          if ((await scrollTop()) <= 0) await page.keyboard.press('j')
          return scrollTop()
        },
        { timeout: 5000 },
      )
      .toBeGreaterThan(0)

    // `gg` returns to the very top.
    await expect
      .poll(
        async () => {
          if ((await scrollTop()) > 0) {
            await page.keyboard.press('g')
            await page.keyboard.press('g')
          }
          return scrollTop()
        },
        { timeout: 5000 },
      )
      .toBe(0)
  })

  test('Vim history keys (H) go back through preview navigation', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeLinkedMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await expect(page.locator('[data-testid="markdown-preview"] a').first()).toBeVisible()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    // Navigate to target.md via link hints (builds a history entry).
    await showLinkHints(page, workbench)
    await expect
      .poll(
        async () => {
          if (await workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible')) {
            await page.keyboard.press('a')
          }
          return page.evaluate(() => window.__E2E__!.getActiveEditorUri())
        },
        { timeout: 5000 },
      )
      .toEqual(expect.stringContaining('target.md'))

    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)
    await page.bringToFront()

    // `H` goes back to the index preview.
    await expect
      .poll(
        async () => {
          if ((await page.evaluate(() => window.__E2E__!.getActiveEditorUri()))?.includes('target'))
            await page.keyboard.press('H')
          return page.evaluate(() => window.__E2E__!.getActiveEditorUri())
        },
        { timeout: 5000 },
      )
      .toEqual(expect.stringContaining('index.md'))
  })

  test('? toggles the keyboard help overlay', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const mdFsPath = writeLongMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    await expect(page.locator('[data-testid="markdown-preview"] h1').first()).toBeVisible()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)
    await page.bringToFront()

    const help = page.locator('[data-testid="md-preview-help"]')
    await expect
      .poll(
        async () => {
          if ((await help.count()) === 0) await page.keyboard.press('?')
          return help.count()
        },
        { timeout: 5000 },
      )
      .toBeGreaterThan(0)
    await expect(help).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
  })
})
