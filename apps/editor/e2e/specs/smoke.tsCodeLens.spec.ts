/*---------------------------------------------------------------------------------------------
 *  TypeScript CodeLens smoke (P1).
 *
 *  Exercises the full CodeLens chain the TS plugin drives, END TO END through the
 *  path the user actually sees: provider registered in Monaco (host RPC round-
 *  trip), `provideCodeLenses` returning lenses, `resolveCodeLens` filling each
 *  lens's command, AND Monaco's own CodeLens controller rendering them above the
 *  symbol. The reference-count lens resolves to the built-in
 *  `editor.action.showReferences` command — the same peek the rest of the editor
 *  uses — so this also guards the LSP→Monaco command-argument conversion.
 *
 *  Why the on-screen assertion matters: the CodeLens controller is gated by the
 *  `editor.codeLens` editor option. That option is a bridged setting, so a user's
 *  VSCode `settings.json` carrying `"editor.codeLens": false` (read as a config
 *  layer) silences every lens even though the provider works fine — the exact bug
 *  a provider-only probe (`getCodeLensDebug`) reports as green. So the spec forces
 *  the option on at Memory scope (independent of the runner's VSCode settings) and
 *  asserts against `getRenderedCodeLenses`, the controller's real output.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

// `greet` is referenced once (line 6), so its references CodeLens reads
// "1 reference". The exported symbol on line 1 anchors the lens we probe.
const SOURCE = [
  'export function greet(name: string): string {',
  '  return `hello ${name}`',
  '}',
  '',
  'export function run(): void {',
  '  console.log(greet("world"))',
  '}',
  '',
].join('\n')

function writeWorkspace(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-tscl-'))
  const filePath = join(dir, 'lib.ts')
  writeFileSync(filePath, SOURCE)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
  )
  return {
    dir: dir.replace(/\\/g, '/'),
    filePath: filePath.replace(/\\/g, '/'),
  }
}

test.describe('@p1 typescript codelens', () => {
  test('renders a references CodeLens resolving to showReferences @regression', async ({
    page,
    workbench,
  }) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    await workbench.waitForRestored()

    // The CodeLens controller only renders when `editor.codeLens` is on. Force it
    // at Memory scope (highest priority) so the spec is immune to the runner's
    // own VSCode settings.json — which may carry `"editor.codeLens": false` and
    // would otherwise silence every lens even though the provider works.
    await page.evaluate(() => window.__E2E__!.updateConfigValue('editor.codeLens', true))

    const { dir, filePath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20000 })
      .toBe('typescript')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    expect(uri).toContain('lib.ts')

    // Wait until the provider is registered AND provideCodeLenses returns lenses
    // (host RPC + tsserver round-trip). `greet` is declared on line 1.
    await expect
      .poll(
        async () => {
          const d = await page.evaluate((u) => window.__E2E__!.getCodeLensDebug(u, 1), uri)
          return { providerCount: d.providerCount ?? 0, lensCount: d.lensCount ?? 0 }
        },
        { timeout: 30000, intervals: [500, 1000, 1000, 2000] },
      )
      .toEqual({ providerCount: 1, lensCount: expect.any(Number) })

    // The on-screen truth: Monaco's own CodeLens controller must have rendered a
    // lens above `greet` (line 1) resolving to the references peek command, its
    // title reporting the count. Rendering + viewport resolve are async, so poll.
    await expect
      .poll(
        async () => {
          const lenses = await page.evaluate(() => window.__E2E__!.getRenderedCodeLenses())
          const lens = lenses.find((l) => l.line === 1)
          return { commandId: lens?.commandId ?? '', title: lens?.title ?? '' }
        },
        { timeout: 20000, intervals: [500, 1000, 1000, 2000] },
      )
      .toMatchObject({
        commandId: 'editor.action.showReferences',
        title: expect.stringContaining('reference'),
      })
  })
})
