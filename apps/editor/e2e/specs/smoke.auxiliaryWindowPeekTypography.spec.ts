/*---------------------------------------------------------------------------------------------
 *  Peek References typography in auxiliary editor windows (P1).
 *
 *  Auxiliary windows are `about:blank` popups hosted by the main renderer through
 *  a React portal; their document chrome is mirrored from the main document. The
 *  peek widget's reference tree inherits the document's font size, while the
 *  embedded preview editor copies the host editor's font through
 *  `parentEditor.getRawOptions()` and writes it as an inline style on `.view-lines`.
 *
 *  This spec drives a real Peek References in both windows and compares the
 *  observable typography / token colours / mirrored Monaco style sheets. It is a
 *  narrow exception to "don't assert Monaco internals": the defect is rendering
 *  style, the probe contract carries no computed styles, and the assertions only
 *  compare the two windows against each other (never token text or pixel values),
 *  following the visual-guard precedent of smoke.peekPreview.spec.ts.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreTypescriptApp.js'
import type { ElectronApplication, Page } from '@playwright/test'

const CHANNELS = [
  'export interface IRenderChannel {',
  '  readonly name: string',
  '  dispose(): void',
  '}',
  '',
  'export class RenderChannel implements IRenderChannel {',
  "  readonly name = 'channel'",
  '  dispose(): void {}',
  '}',
  '',
  'export const channel: IRenderChannel = new RenderChannel()',
  '',
].join('\n')

/** `IRenderChannel` starts at column 18 (`export interface ` is 17 chars). */
const SYMBOL_POSITION = { line: 1, column: 18 } as const

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

/**
 * Runs inside the window under test (`page.evaluate` / `child.evaluate`), so
 * `document` and `getComputedStyle` resolve against that window's realm.
 */
function readPeekFingerprint() {
  const doc = document
  const query = (selector: string) => doc.querySelector(selector) as HTMLElement | null
  const styleOf = (element: HTMLElement | null) => {
    if (!element) return null
    const computed = getComputedStyle(element)
    return {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
    }
  }

  const viewLines = query('.reference-zone-widget .preview .monaco-editor .view-lines')
  const title = query('.reference-zone-widget .peekview-title')
  const tree = query('.reference-zone-widget .ref-tree')
  const row = query('.reference-zone-widget .ref-tree .monaco-list-row')

  const tokenColors: Record<string, string> = {}
  const tokenSpans = doc.querySelectorAll<HTMLElement>(
    '.reference-zone-widget .preview .view-line span[class*="mtk"]',
  )
  for (const span of Array.from(tokenSpans)) {
    const key = span.className
    if (!(key in tokenColors)) tokenColors[key] = getComputedStyle(span).color
  }

  // Drive-by note: the mirror clones `<style>` nodes without their `className`,
  // so `style.monaco-colors` only exists in the main window. Count `.mtk*` rules
  // across every sheet instead; the largest sheet is the token stylesheet.
  const tokenRuleCounts = Array.from(doc.styleSheets).map((sheet) => {
    try {
      return Array.from(sheet.cssRules).filter((rule) => rule.cssText.startsWith('.mtk')).length
    } catch {
      // Cross-origin sheets cannot be inspected.
      return 0
    }
  })

  let peekRulePresent = false
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      if (Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('.peekview-title'))) {
        peekRulePresent = true
        break
      }
    } catch {
      // Cross-origin sheets cannot be inspected.
    }
  }

  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'))
  const viewRect = viewLines?.getBoundingClientRect()

  return {
    viewInline: viewLines
      ? {
          fontFamily: viewLines.style.fontFamily,
          fontSize: viewLines.style.fontSize,
          lineHeight: viewLines.style.lineHeight,
          letterSpacing: viewLines.style.letterSpacing,
          cssText: viewLines.getAttribute('style') ?? '',
        }
      : null,
    viewComputed: styleOf(viewLines),
    title: styleOf(title),
    tree: styleOf(tree),
    row: styleOf(row),
    tokenColors,
    tokenSpanCount: tokenSpans.length,
    tokenRules: {
      perSheet: tokenRuleCounts,
      maxPerSheet: Math.max(0, ...tokenRuleCounts),
      sheetCount: tokenRuleCounts.filter((count) => count > 0).length,
    },
    viewRect: viewRect ? { width: viewRect.width, height: viewRect.height } : null,
    styles: {
      links: links.length,
      loadedLinks: links.filter((link) => link.sheet !== null).length,
      peekRulePresent,
    },
    zoom: {
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    },
  }
}

async function openPeek(
  windowPage: Page,
  workbench: { runCommand(id: string, ...args: unknown[]): Promise<unknown> },
  probePage: Page,
): Promise<void> {
  await windowPage.locator('.monaco-editor').first().click()
  expect(
    await probePage.evaluate(
      ([line, column]) => window.__E2E__!.setActiveEditorSelection(line, column, line, column),
      [SYMBOL_POSITION.line, SYMBOL_POSITION.column] as const,
    ),
  ).toBe(true)
  await workbench.runCommand('editor.action.referenceSearch.trigger')
  await expect(windowPage.locator('.reference-zone-widget')).toBeVisible({ timeout: 30_000 })
  await expect(
    windowPage.locator('.reference-zone-widget .preview .monaco-editor .view-lines'),
  ).toBeVisible({ timeout: 15_000 })
}

test.describe('@p1 auxiliary window peek typography', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'channels.ts'), CHANNELS)
        writeFileSync(
          join(dir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
        )
      },
    },
  })

  test('peek typography matches the main window @regression', async ({
    electronApp,
    workbench,
    page,
    launchWorkspace,
  }, testInfo) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()

    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('channels.ts'),
    )
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20_000 })
      .toBe('typescript')

    // Warm tsserver so the peek resolves on its first request.
    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    await expect
      .poll(() => page.evaluate((u) => window.__E2E__!.getHover(u, 1, 18), uri), {
        timeout: 45_000,
      })
      .toContain('IRenderChannel')

    await openPeek(page, workbench, page)
    const main = await page.evaluate(readPeekFingerprint)

    await page.keyboard.press('Escape')
    await expect(page.locator('.reference-zone-widget')).toBeHidden({ timeout: 15_000 })

    const child = await waitForAuxWindow(
      electronApp,
      workbench,
      'workbench.action.moveEditorToNewWindow',
    )
    await expect(child.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 })

    await openPeek(child, workbench, page)
    // The widget must live in the auxiliary document only.
    await expect(page.locator('.reference-zone-widget')).toBeHidden()
    const auxiliary = await child.evaluate(readPeekFingerprint)

    await testInfo.attach('peek-style-fingerprint.json', {
      body: JSON.stringify({ main, auxiliary }, null, 2),
      contentType: 'application/json',
    })

    // Main window baseline: without it the parity assertions below are vacuous.
    expect(main.viewInline?.fontFamily, 'main peek preview must have an inline font').toBeTruthy()
    expect(main.tokenSpanCount, 'main peek preview must render token spans').toBeGreaterThan(0)

    // Both windows must resolve the same window metrics (zoom/DPR would scale
    // everything and masquerade as a font regression).
    expect(auxiliary.zoom.devicePixelRatio).toBeCloseTo(main.zoom.devicePixelRatio, 2)

    // Embedded preview editor: inline font copied from the host editor.
    expect(auxiliary.viewInline).toEqual(main.viewInline)
    expect(auxiliary.viewComputed).toEqual(main.viewComputed)

    // Peek chrome inherits the workbench font context (13px in the main window).
    expect(auxiliary.title).toEqual(main.title)
    expect(auxiliary.tree).toEqual(main.tree)
    expect(auxiliary.row).toEqual(main.row)

    // Monaco's token stylesheet must be mirrored into the auxiliary document.
    expect(auxiliary.tokenRules.maxPerSheet).toBe(main.tokenRules.maxPerSheet)
    expect(auxiliary.tokenRules.maxPerSheet).toBeGreaterThan(0)
    expect(auxiliary.styles).toEqual(main.styles)

    // Token colours: compare the classes visible in the auxiliary preview, which
    // is a subset of the main window's (narrower window -> fewer visible lines).
    expect(auxiliary.tokenSpanCount).toBeGreaterThan(0)
    for (const [className, color] of Object.entries(auxiliary.tokenColors)) {
      if (className in main.tokenColors) {
        expect(color, `token class ${className}`).toBe(main.tokenColors[className])
      }
    }
  })
})
