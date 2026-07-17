/*---------------------------------------------------------------------------------------------
 *  References peek preview layout smoke (P1).
 *
 *  Guards the fix for the blank peek-preview pane. Monaco's `.preview.inline`
 *  container is `display:inline-block` (shrinks to content) and is sized only by
 *  the embedded editor inside it; our host editor's `automaticLayout: true` is
 *  inherited by that embedded editor, whose ResizeObserver then watches the very
 *  container it is supposed to fill — a feedback deadlock that collapses the
 *  preview to ~5×5px inside a correctly-sized SplitView slot. The bug reproduces
 *  reliably when the first reference lives in another file (its model must be read
 *  from disk async, so the preview loses the layout race). The CSS fix forces the
 *  container to fill its reliable SplitView slot, breaking the loop.
 *
 *  We open the peek via the CodeLens "N references" command path (the reproducing
 *  path) on a symbol whose first reference is cross-file, and assert the preview
 *  editor fills its slot in BOTH dimensions.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

// `helper` is referenced from main.ts (cross-file) before its local use, so the
// peek's first/nearest reference resolves to a not-yet-open file — the case that
// forces the async model read and reliably reproduced the blank preview.
const LIB = [
  'export function helper(x: number): number {',
  '  return x + 1',
  '}',
  '',
  'export function useLocal(): number {',
  '  return helper(41)',
  '}',
  '',
].join('\n')

const MAIN = [
  'import { helper } from "./lib"',
  '',
  'export const a = helper(1)',
  'export const b = helper(2)',
  '',
].join('\n')

function writeWorkspace(): { dir: string; libPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-peekprev-'))
  const libPath = join(dir, 'lib.ts')
  writeFileSync(libPath, LIB)
  writeFileSync(join(dir, 'main.ts'), MAIN)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
  )
  return { dir: dir.replace(/\\/g, '/'), libPath: libPath.replace(/\\/g, '/') }
}

test.describe('@p1 references peek preview', () => {
  test('preview editor fills its slot in both dimensions @regression', async ({
    page,
    workbench,
  }) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    await workbench.waitForRestored()
    await page.evaluate(() => window.__E2E__!.updateConfigValue('editor.codeLens', true))

    const { dir, libPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), libPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20000 })
      .toBe('typescript')

    // Wait for the references CodeLens on `helper` (line 1) to render + resolve.
    await expect
      .poll(
        async () => {
          const lenses = await page.evaluate(() => window.__E2E__!.getRenderedCodeLenses())
          return lenses.find((l) => l.line === 1)?.commandId ?? ''
        },
        { timeout: 30000, intervals: [500, 1000, 1000, 2000] },
      )
      .toBe('editor.action.showReferences')

    // Open the peek by clicking the on-screen CodeLens (the path that reproduced).
    const lens = page.locator('.codelens-decoration a', { hasText: 'reference' }).first()
    await expect(lens).toBeVisible({ timeout: 15000 })
    await lens.click()

    // The embedded preview editor must fill its SplitView slot in BOTH width and
    // height — not collapse to the ~5×5px deadlock. Poll through mount + async
    // model resolve + layout settle.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const zone = document.querySelector('.reference-zone-widget')
            if (!zone) return { filled: false, previewWidth: -1, previewHeight: -1, slotWidth: -1 }
            const preview = zone.querySelector('.preview .monaco-editor') as HTMLElement | null
            const slot = zone.querySelector('.split-view-view') as HTMLElement | null
            const previewWidth = preview?.offsetWidth ?? -1
            const previewHeight = preview?.offsetHeight ?? -1
            const slotWidth = slot?.offsetWidth ?? -1
            return {
              previewWidth,
              previewHeight,
              slotWidth,
              filled: slotWidth > 200 && previewWidth >= slotWidth - 4 && previewHeight > 200,
            }
          }),
        { timeout: 15000, intervals: [250, 500, 500, 1000] },
      )
      .toMatchObject({ filled: true })
  })
})
