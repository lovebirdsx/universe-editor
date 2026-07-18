/*---------------------------------------------------------------------------------------------
 *  TypeScript semantic-highlighting smoke (P1).
 *
 *  Reproduces the bug where uppercase-first-letter interface fields render in the
 *  same color as types (TextMate's "uppercase ⇒ type" guess) instead of being
 *  recolored as `property` by the TS language server's semantic tokens.
 *
 *  The probe surfaces every link of the chain (registered provider, server
 *  legend, tokens returned by a direct provider call, the resolved
 *  `editor.semanticHighlighting` config gate, and the foreground color id
 *  actually applied to the merged line token) so a failure pinpoints where the
 *  chain breaks. The decisive assertion: an uppercase property must NOT share the
 *  foreground color of an interface/type name — semantic highlighting overrides
 *  the grammar's type-colored guess.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/typescriptApp.js'

// An interface whose fields start with an uppercase letter — the exact shape that
// TextMate mis-colors as a type. `Target` is both a property (line 4) and, via
// `Person`, a type reference; semantic tokens must color the field as a property.
const SOURCE = [
  'interface Person {',
  '  id: string',
  '}',
  '',
  'export interface INpcLookAtConfig {',
  '  Target: Person',
  '  IsKeepOverAngle: boolean',
  '  MaxDistance: number',
  '}',
  '',
].join('\n')

function writeWorkspace(): { dir: string; filePath: string; tsconfig: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-tssem-'))
  const filePath = join(dir, 'config.ts')
  writeFileSync(filePath, SOURCE)
  const tsconfig = join(dir, 'tsconfig.json')
  writeFileSync(
    tsconfig,
    JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
  )
  return {
    dir: dir.replace(/\\/g, '/'),
    filePath: filePath.replace(/\\/g, '/'),
    tsconfig: tsconfig.replace(/\\/g, '/'),
  }
}

test.describe('@p1 typescript semantic highlighting', () => {
  test('recolors uppercase interface fields as properties, not types @p1', async ({
    page,
    workbench,
  }) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    await workbench.waitForRestored()

    const { dir, filePath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), filePath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20000 })
      .toBe('typescript')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    expect(uri).toContain('config.ts')

    // Wait until the semantic-tokens provider is registered AND a direct call
    // returns tokens (host RPC + tsserver round-trip completed). `Target` sits on
    // line 6, column 3.
    await expect
      .poll(
        async () => {
          const d = await page.evaluate((u) => window.__E2E__!.getSemanticTokenDebug(u, 6, 3), uri)
          return { providerCount: d.providerCount ?? 0, directTokenCount: d.directTokenCount ?? -1 }
        },
        { timeout: 20000, intervals: [250, 500, 1000, 1000] },
      )
      .toEqual({ providerCount: 1, directTokenCount: expect.any(Number) })

    const debug = await page.evaluate((u) => window.__E2E__!.getSemanticTokenDebug(u, 6, 3), uri)
    // The server must return tokens.
    expect(debug.directTokenCount).toBeGreaterThan(0)
    // The config gate must be enabled — the value is `{ enabled: true }`, and
    // `isSemanticColoringEnabled` reads `.enabled` off it. Without the
    // `semanticHighlighting.enabled: true` editor option this resolves to
    // `configuredByTheme`, and standalone themes hardcode it off → no recolor.
    expect(debug.semanticHighlightingSetting).toMatchObject({ enabled: true })

    // The decisive check: `Target` (property, line 6 col 3) must NOT share the
    // foreground color of `INpcLookAtConfig` (interface/type name, line 5 col 18).
    // Both share the grammar class `type.identifier.ts`, so grammar alone colors
    // them identically — only semantic tokens recolor the property. Poll because
    // the semantic tokens land after a debounce once applied.
    await expect
      .poll(
        async () => {
          const prop = await page.evaluate(
            (u) => window.__E2E__!.getSemanticTokenDebug(u, 6, 3),
            uri,
          )
          const type = await page.evaluate(
            (u) => window.__E2E__!.getSemanticTokenDebug(u, 5, 18),
            uri,
          )
          return {
            propHex: prop.foregroundHex ?? '',
            typeHex: type.foregroundHex ?? '',
            same: prop.foreground === type.foreground,
          }
        },
        { timeout: 15000, intervals: [500, 500, 1000, 1000, 2000] },
      )
      .toMatchObject({ same: false })
  })
})
