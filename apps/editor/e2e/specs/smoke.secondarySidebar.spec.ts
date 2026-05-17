/*---------------------------------------------------------------------------------------------
 *  Secondary sidebar layout stability smoke test (@p1).
 *
 *  验证 show → hide 二级侧边栏后，主侧边栏宽度不被 Allotment 的错误空间分配污染。
 *
 *  Bug: proportionalLayout=false 下，隐藏 pane2 时 Allotment 将释放的空间
 *  分给 pane0（SideBar）而非 pane1（EditorArea），导致侧边栏意外变宽。
 *  Fix: WorkbenchLayout 在 visibility 变化时快照尺寸，useEffect 后显式 resize。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

const TOGGLE_CMD = 'workbench.action.toggleSecondarySidebarVisibility'

test.describe('@p1 secondary sidebar layout', () => {
  test('sidebar width is unchanged after show → hide secondary sidebar', async ({ workbench }) => {
    const { page } = workbench

    // Ensure probe is ready.
    await page.evaluate(() => window.__E2E__!.whenReady())

    // 1. Capture the initial sidebar size from LayoutService.
    const before = await page.evaluate(() => window.__E2E__!.getLayoutSizes())

    // 2. Show secondary sidebar.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)

    // Wait until secondary sidebar size settles (editor should shrink by ~secondarySidebar px).
    await expect
      .poll(
        () => page.evaluate(() => window.__E2E__!.getLayoutSizes()),
        { timeout: 3000 },
      )
      .toMatchObject({ secondarySidebar: before.secondarySidebar })

    // 3. Hide secondary sidebar.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)

    // 4. After hiding, sidebar must return to its original width.
    //    We poll to let the useEffect correction resize settle.
    await expect
      .poll(
        () =>
          page.evaluate(() => window.__E2E__!.getLayoutSizes().sidebar),
        { timeout: 3000, message: 'sidebar width should be unchanged after hide' },
      )
      .toBe(before.sidebar)
  })

  test('secondary sidebar restores its size after hide → show', async ({ workbench }) => {
    const { page } = workbench

    await page.evaluate(() => window.__E2E__!.whenReady())

    // Show secondary sidebar and wait for its size to settle.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)
    await expect
      .poll(
        () => page.evaluate(() => window.__E2E__!.getLayoutSizes().secondarySidebar),
        { timeout: 3000 },
      )
      .toBeGreaterThan(0)

    const sizeAfterShow = await page.evaluate(() =>
      window.__E2E__!.getLayoutSizes().secondarySidebar,
    )

    // Hide secondary sidebar.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)
    await page.waitForTimeout(300)

    // Show again — must restore to the same size.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)
    await expect
      .poll(
        () => page.evaluate(() => window.__E2E__!.getLayoutSizes().secondarySidebar),
        { timeout: 3000, message: 'secondary sidebar should restore previous size after hide → show' },
      )
      .toBe(sizeAfterShow)
  })

  test('editor area recovers its width after hide secondary sidebar', async ({ workbench }) => {
    const { page } = workbench

    await page.evaluate(() => window.__E2E__!.whenReady())

    // Measure editor area via DOM (the Allotment pane wrapping it).
    const getEditorWidth = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="part-editorArea"]')
        return el ? Math.round(el.getBoundingClientRect().width) : null
      })

    const editorWidthBefore = await getEditorWidth()
    expect(editorWidthBefore).toBeGreaterThan(0)

    // Show secondary sidebar.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)
    await page.waitForTimeout(300)

    // Hide secondary sidebar.
    await page.evaluate((cmd) => { void window.__E2E__!.runCommand(cmd) }, TOGGLE_CMD)

    // Editor width should recover to within 2px of the original.
    await expect
      .poll(getEditorWidth, {
        timeout: 3000,
        message: 'editor width should recover after secondary sidebar is hidden',
      })
      .toBeGreaterThanOrEqual((editorWidthBefore ?? 0) - 2)
  })
})
