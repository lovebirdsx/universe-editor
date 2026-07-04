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
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

// A 1×1 red PNG — the smallest valid image to prove the universe-resource
// protocol actually streamed real bytes (naturalWidth > 0), not just that an
// <img> element exists.
const RED_DOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function writeMarkdownWithLocalImage(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'with-image.md')
  writeFileSync(join(dir, 'dot.png'), Buffer.from(RED_DOT_PNG_BASE64, 'base64'))
  writeFileSync(file, '# Has image\n\n![a red dot](./dot.png)\n')
  return { dir: dir.replace(/\\/g, '/'), filePath: file.replace(/\\/g, '/') }
}

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

// A markdown file inside a real workspace folder so the parcel watcher fires on
// external edits. `realPath` keeps the native (back-slash on win32) path for
// writing to disk directly; the other two are forward-slashed for the E2E probe.
function writeWorkspaceMarkdown(body: string): {
  dir: string
  filePath: string
  realPath: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-md-'))
  const file = join(dir, 'watch.md')
  writeFileSync(file, body)
  return { dir: dir.replace(/\\/g, '/'), filePath: file.replace(/\\/g, '/'), realPath: file }
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

  // Regression: scrolling the preview (Ctrl+Shift+V toggle mode) then switching
  // back to the source must land the source editor near the line the preview was
  // showing — not reset to the top. In toggle mode the source editor is detached,
  // so its own preview↔source scroll sync never runs; OpenMarkdownSourceAction
  // carries the preview's top-visible source line back as a one-shot reveal.
  test('Open Source restores the scrolled preview position onto the source', async ({
    page,
    workbench,
  }) => {
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
    await page.bringToFront()

    // Scroll the preview well past the top.
    const previewScrollTop = () =>
      page.evaluate(
        () => document.querySelector('[data-testid="markdown-preview"]')?.scrollTop ?? 0,
      )
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="markdown-preview"]')
      if (el) el.scrollTop = 4000
    })
    await expect.poll(previewScrollTop).toBeGreaterThan(1000)

    // The source line at the top of the preview now — the fix must land the source
    // editor near it (not at line 1).
    const previewTopLine = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="markdown-preview"]')
      if (!el) return 0
      const blocks = Array.from(el.querySelectorAll<HTMLElement>('[data-line]'))
      const rootTop = el.getBoundingClientRect().top
      let best = 0
      for (const b of blocks) {
        if (b.getBoundingClientRect().top - rootTop <= 1) best = Number(b.dataset['line']) + 1
      }
      return best
    })
    expect(previewTopLine).toBeGreaterThan(1)

    await workbench.runCommand('workbench.action.markdown.showSource')
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    // The source editor's first visible line must be near the preview's top line,
    // not reset to the top. Allow tolerance for scroll↔line interpolation and the
    // reveal's viewport padding.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorFirstVisibleLine()), {
        timeout: 5000,
      })
      .toBeGreaterThan(previewTopLine - 30)
    const sourceFirstLine = await page.evaluate(() =>
      window.__E2E__!.getActiveEditorFirstVisibleLine(),
    )
    expect(sourceFirstLine).toBeLessThan(previewTopLine + 10)
  })

  // Regression: scrolling the preview to the very bottom then toggling back must
  // land the source with its LAST line flush at the viewport bottom — not
  // overshoot into Monaco's scroll-beyond-last-line padding (~10+ blank lines).
  test('Open Source from the preview bottom clamps the source to the last line', async ({
    page,
    workbench,
  }) => {
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
    await page.bringToFront()

    // Scroll the preview to the very bottom.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="markdown-preview"]')
      if (el) el.scrollTop = el.scrollHeight
    })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="markdown-preview"]')
          if (!el) return 0
          return el.scrollHeight - el.clientHeight - el.scrollTop
        }),
      )
      .toBeLessThan(5)

    await workbench.runCommand('workbench.action.markdown.showSource')
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    // The source document has ~405 lines (200 paragraphs × 2 + heading). Toggling
    // back from the bottom must scroll it so the last line is at/near the bottom of
    // the viewport, i.e. the LAST line is visible — not padded far below it. Poll
    // for the text: the language-id context key flips as soon as the source input
    // is active, but the FileEditor's Monaco instance registers a beat later (more
    // visibly so now the workbench mounts before Monaco finishes loading).
    await expect
      .poll(
        () => page.evaluate(() => window.__E2E__!.getActiveEditorText()?.split('\n').length ?? 0),
        { timeout: 5000 },
      )
      .toBeGreaterThan(100)
    const lastLine = await page.evaluate(
      () => window.__E2E__!.getActiveEditorText()?.split('\n').length ?? 0,
    )
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorLastVisibleLine()), {
        timeout: 5000,
      })
      .toBeGreaterThan(lastLine - 3)
  })

  // Entering the preview must open aligned to the source file's cursor line, not
  // at the preview's own saved scroll (which defaults to the top).
  test('Open Preview aligns the preview to the source cursor line', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const mdFsPath = writeLongMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    // Move the source cursor deep into the document. The Monaco instance may
    // still be mounting right after open, so re-issue until the cursor lands.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(200, 1))
          return page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber)
        },
        { timeout: 5000 },
      )
      .toBe(200)

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')
    await expect(page.locator('[data-testid="markdown-preview"] h1').first()).toBeVisible()

    // The preview must be scrolled so the cursor line (≈200) is near the top —
    // not sitting at the very top of the document.
    const previewTopLine = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="markdown-preview"]')
        if (!el) return 0
        const blocks = Array.from(el.querySelectorAll<HTMLElement>('[data-line]'))
        const rootTop = el.getBoundingClientRect().top
        let best = 0
        for (const b of blocks) {
          if (b.getBoundingClientRect().top - rootTop <= 1) best = Number(b.dataset['line']) + 1
        }
        return best
      })
    await expect.poll(previewTopLine, { timeout: 5000 }).toBeGreaterThan(150)
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

    // Regression: the preview's title-bar buttons are gated by the group-scoped
    // `activeEditorType` key, so they must stay visible when another group becomes
    // active. Before the fix they used the global `activeEditorTypeId` and vanished
    // the moment focus left the preview group.
    const helpButton = page.locator(
      '[data-testid="view-title-action-workbench.action.markdownPreview.help"]',
    )
    await expect(helpButton).toBeVisible()

    await workbench.runCommand('workbench.action.focusLeftGroup')
    await expect
      .poll(() => workbench.getContextKey<number>('activeEditorGroupIndex'), { timeout: 5000 })
      .toBe(0)

    await expect(helpButton).toBeVisible()
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

    // Wait for the rendered body before reading computed styles: content now
    // appears after MonacoLoader.ensureInitialized() resolves, which lands after
    // the type-id flips (the workbench mounts before Monaco finishes loading).
    await expect(page.locator('[data-testid="markdown-preview"] h1').first()).toBeVisible()

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

  // Regression: pressing Esc inside the focused preview routed to
  // FocusActiveEditorGroup → focusEditorInput, which (lacking a focus() hook on
  // MarkdownPreviewInput) moved focus to the editor-group body wrapping the
  // preview, firing focusout → markdownPreviewFocused=false. Every preview
  // keybinding (f / Ctrl+F / link hints) then NO-MATCHed forever. The focus()
  // hook must keep focus inside the preview so the key stays true.
  test('Escape keeps the preview focused so keys keep working', async ({ page, workbench }) => {
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

    // Press Escape with no find bar / hints open: focus must stay in the preview.
    await page.keyboard.press('Escape')
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    // And keys must still work afterwards — `f` still summons link hints.
    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()
  })

  // Regression: closing the find bar with Esc routes through the global
  // MarkdownPreviewFindClose command → controller.closeFind(). That path used to
  // only close the widget without returning focus to the preview, so focus was
  // left on the (now-removed) find input's slot and markdownPreviewFocused went
  // false — a second Esc was needed before f / Ctrl+F worked again. closeFind()
  // must restore focus to the scroll container in one step (mirrors ChatBody).
  test('Closing find with Escape returns focus to the preview in one step', async ({
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

    await expect(page.locator('[data-testid="markdown-preview"] a').first()).toBeVisible()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    await page.bringToFront()

    // Open find via the real Ctrl+F (gated on markdownPreviewFocused). Re-press
    // while still hidden so a dropped synthetic key self-heals.
    await expect
      .poll(
        async () => {
          if (!(await workbench.getContextKey<boolean>('markdownPreviewFindVisible'))) {
            await page.keyboard.press('Control+f')
          }
          return workbench.getContextKey<boolean>('markdownPreviewFindVisible')
        },
        { timeout: 5000 },
      )
      .toBe(true)
    await expect(page.locator('[data-testid="acp-find-input"]')).toBeFocused()

    // One Escape must both close the bar AND return focus to the preview.
    await page.keyboard.press('Escape')
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFindVisible'), { timeout: 5000 })
      .toBe(false)
    // The single Escape restored focus — no second press needed.
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    // Proof the focus is real: `f` immediately summons link hints, no click.
    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()
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

  // Regression: clicking the title-bar buttons moves focus off the preview
  // (firing focusout → clearActive), so the command must resolve the active
  // preview via the editor group rather than the now-empty focus handle.
  // Before the fix the buttons silently did nothing while the shortcut worked.
  test('clicking the Help title-bar button opens the help overlay', async ({ page, workbench }) => {
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
    await page.bringToFront()

    const helpButton = page.locator(
      '[data-testid="view-title-action-workbench.action.markdownPreview.help"]',
    )
    await expect(helpButton).toBeVisible()
    // The tooltip carries the keybinding hint.
    await expect(helpButton).toHaveAttribute('title', /\?/)

    const help = page.locator('[data-testid="md-preview-help"]')
    await helpButton.click()
    await expect(help).toBeVisible()
  })

  test('clicking the Find title-bar button opens the find widget', async ({ page, workbench }) => {
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
    await page.bringToFront()

    const findButton = page.locator(
      '[data-testid="view-title-action-workbench.action.markdownPreview.find"]',
    )
    await expect(findButton).toBeVisible()
    // The tooltip carries the keybinding hint (Ctrl+F).
    await expect(findButton).toHaveAttribute('title', /Ctrl\+F/i)

    await findButton.click()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFindVisible'), { timeout: 5000 })
      .toBe(true)
  })

  // Local images (relative path) must render: the src is rewritten to the
  // universe-resource:// protocol and streamed from disk by the main process.
  // A plain file:// <img> would be blocked by the renderer's origin + webSecurity.
  test('renders a local relative-path image via the universe-app protocol', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeMarkdownWithLocalImage()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    const img = page.locator('[data-testid="markdown-preview"] img').first()
    await expect(img).toBeVisible()

    // The src must be rewritten to our protocol (not a raw file:// / relative path).
    await expect(img).toHaveAttribute('src', /^universe-app:\/\/root\/_resource_\//)

    // Proof the bytes actually loaded: a broken image has naturalWidth 0.
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 5000 })
      .toBeGreaterThan(0)
  })

  // The built-in doc center (DocEditor) is another markdown reading surface and
  // shares the preview's vimium-style keyboard navigation via useMarkdownReaderNav.
  // Opening it and pressing `f` must overlay link hints just like the file preview.
  test('doc center shares vimium link hints', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')

    // The doc index renders many links; wait for the first before driving keys.
    await expect(page.locator('[data-testid="doc-editor"] a').first()).toBeVisible()
    await page.bringToFront()

    // The doc surface auto-focuses on open, so the shared `markdownPreviewFocused`
    // key (the navigation Action2s gate on it) is true without a manual click.
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()
  })

  // Regression: pressing Escape to dismiss the hints must keep the doc surface
  // focused so `f` works again. The doc center is a plain div with no Monaco
  // registration, so unless DocEditorInput.focus() routes focus back into the
  // scroll container, the group body grabs it, fires focusout, drops
  // markdownPreviewFocused → a second `f` is silently ignored.
  test('doc center Escape keeps focus so link hints keep working', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')

    await expect(page.locator('[data-testid="doc-editor"] a').first()).toBeVisible()
    await page.bringToFront()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    // First `f` summons hints.
    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()

    // Escape dismisses the hints; focus must stay in the doc surface.
    await page.keyboard.press('Escape')
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewLinkHintsVisible'), {
        timeout: 5000,
      })
      .toBe(false)
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    // Proof the focus is real: a second `f` summons hints again, no click.
    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()
  })

  test('doc center shows the keyboard help overlay', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')

    await expect(page.locator('[data-testid="doc-editor"] h1').first()).toBeVisible()
    await page.bringToFront()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    const help = page.locator('[data-testid="md-preview-help"]')
    // Re-press while still hidden so a dropped synthetic key self-heals.
    await expect
      .poll(
        async () => {
          if (!(await help.isVisible())) await page.keyboard.press('?')
          return help.isVisible()
        },
        { timeout: 8000 },
      )
      .toBe(true)
  })

  // Regression: switching to a Monaco file editor and back left editorTextFocus
  // stuck true (its blur can lag), so the global keybinding guard swallowed the
  // bare `f`. focusEditorInput's non-Monaco branch must sync the focus context
  // keys after DocEditorInput.focus() so `f` keeps working after a round-trip.
  test('doc center keeps link hints working after switching editors and back', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')
    await expect(page.locator('[data-testid="doc-editor"] a').first()).toBeVisible()

    // Open a Monaco markdown file in the same group, then switch back to the doc.
    const mdFsPath = writeTempMarkdown()
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdFsPath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 5000 })
      .toBe('markdown')

    // Return to the doc tab by clicking it.
    await page.locator('[role="tab"]', { hasText: '文档中心' }).first().click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')

    await page.bringToFront()
    await expect
      .poll(() => workbench.getContextKey<boolean>('markdownPreviewFocused'), { timeout: 5000 })
      .toBe(true)

    // `f` must still summon link hints after the round-trip.
    await showLinkHints(page, workbench)
    await expect(page.locator('[data-testid="md-link-hint"]').first()).toBeVisible()
  })

  // A plain click on a doc-to-doc link navigates in place (reusing the tab)
  // rather than piling up a new tab each time — mirrors the markdown preview.
  test('doc center link navigates in place without opening a new tab', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')
    await expect(page.locator('[data-testid="doc-editor"] a').first()).toBeVisible()
    await page.bringToFront()

    const before = await workbench.getContextKey<number>('groupEditorsCount')

    // Click the first relative .md link in the doc index.
    await page
      .locator(
        '[data-testid="doc-editor"] a[href$=".md"], [data-testid="doc-editor"] a[href*=".md#"]',
      )
      .first()
      .click()

    // Still a doc, and the tab count did not grow — the link replaced in place.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')
    await expect
      .poll(() => workbench.getContextKey<number>('groupEditorsCount'), { timeout: 5000 })
      .toBe(before)
  })

  // After walking a doc→doc link in place, Go Back must return to the previous
  // doc in the SAME tab, not open a new one (the reported Shift+H regression).
  test('doc center go-back returns in place without opening a new tab', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')
    await expect(page.locator('[data-testid="doc-editor"] a').first()).toBeVisible()
    await page.bringToFront()

    const before = await workbench.getContextKey<number>('groupEditorsCount')

    // Walk a relative .md link in place, then go back.
    await page
      .locator(
        '[data-testid="doc-editor"] a[href$=".md"], [data-testid="doc-editor"] a[href*=".md#"]',
      )
      .first()
      .click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')

    await workbench.runCommand('workbench.action.goBack')

    // Still a doc, and the tab count never grew — go-back reused the tab.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')
    await expect
      .poll(() => workbench.getContextKey<number>('groupEditorsCount'), { timeout: 5000 })
      .toBe(before)
  })

  // The find / help title-bar buttons belong to every markdown reading surface,
  // so the built-in doc center shows them too (not just the file preview).
  test('doc center shows the Find and Help title-bar buttons', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openDocs')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('doc')
    await expect(page.locator('[data-testid="doc-editor"] h1').first()).toBeVisible()
    await page.bringToFront()

    const findButton = page.locator(
      '[data-testid="view-title-action-workbench.action.markdownPreview.find"]',
    )
    const helpButton = page.locator(
      '[data-testid="view-title-action-workbench.action.markdownPreview.help"]',
    )
    await expect(findButton).toBeVisible()
    await expect(helpButton).toBeVisible()

    await helpButton.click()
    await expect(page.locator('[data-testid="md-preview-help"]')).toBeVisible()
  })

  // Regression: a preview reached WITHOUT its source open in the group (pure
  // preview mode — Ctrl+Shift+V toggle detaches the source tab) must still track
  // external edits to the file on disk. Before the fix the ExternalChangeWatcher
  // only reconciled FileEditorInputs, so the preview's own acquired model was
  // never updated and the rendered text stayed frozen at first read.
  test('pure preview (toggle) tracks external edits to the file on disk', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath, realPath } = writeWorkspaceMarkdown('# Original heading\n\nfirst body\n')
    // Open the folder so the parcel watcher covers the file, then open it.
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    // Toggle into pure preview mode: the source tab is detached, so no
    // FileEditorInput backs this file in the group anymore.
    await workbench.runCommand('workbench.action.markdown.openPreview')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')
    await expect(page.locator('[data-testid="markdown-preview"]')).toContainText('Original heading')

    // Edit the file on disk out-of-band.
    await writeFile(realPath, '# Updated heading\n\nsecond body\n')

    // The preview must reflect the new content without any user action.
    await expect(page.locator('[data-testid="markdown-preview"]')).toContainText(
      'Updated heading',
      {
        timeout: 8000,
      },
    )
    await expect(page.locator('[data-testid="markdown-preview"]')).toContainText('second body')
  })

  // Same bug, second entry path: a preview reached by clicking a markdown→markdown
  // link (the source was never opened as a FileEditorInput at all) must also track
  // external disk edits.
  test('pure preview (via link) tracks external edits to the file on disk', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeLinkedMarkdown()
    const targetReal = `${dir}/target.md`
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
    await expect(page.locator('[data-testid="markdown-preview"] a').first()).toBeVisible()
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
    await expect(page.locator('[data-testid="markdown-preview"]')).toContainText('Target')

    // The target file's source was never opened; edit it on disk.
    await writeFile(targetReal, '# Target updated\n\nnew body\n')

    await expect(page.locator('[data-testid="markdown-preview"]')).toContainText('Target updated', {
      timeout: 8000,
    })
  })
})
