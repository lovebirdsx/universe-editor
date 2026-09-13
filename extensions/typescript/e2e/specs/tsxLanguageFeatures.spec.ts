/*---------------------------------------------------------------------------------------------
 *  TypeScript `.tsx` language-service smoke (P1).
 *
 *  `.tsx` carries its own Monaco language id (`typescriptreact`) so the tsx
 *  TextMate grammar can bind to it — a collapsed id silently lost the grammar and
 *  left JSX tag names uncolored. That split has to leave the LSP side intact: the
 *  document mirror must report `typescriptreact`, which is what activates the
 *  plugin and what every provider selector matches on. A regression here shows up
 *  as a .tsx file with zero language features while .ts works fine, so probe the
 *  chain end to end (provider registered + tsserver actually answered).
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/typescriptApp.js'

// `Label` is an uppercase interface field — the shape the grammar mis-colors as a
// type and semantic tokens must recolor as a property. It sits on line 2, col 3.
const SOURCE = [
  'interface PanelProps {',
  '  Label: string',
  '}',
  '',
  'export function Panel({ Label }: PanelProps) {',
  '  return <span title={Label}>{Label}</span>',
  '}',
  '',
].join('\n')

test.describe('@p1 typescript tsx', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'component.tsx'), SOURCE)
        writeFileSync(
          join(dir, 'tsconfig.json'),
          // `jsx: preserve` keeps tsserver JSX-aware without needing a react
          // runtime in the seeded workspace.
          JSON.stringify(
            { compilerOptions: { strict: true, jsx: 'preserve' }, include: ['*.tsx'] },
            null,
            2,
          ),
        )
      },
    },
  })

  test('serves language features for .tsx under the typescriptreact language id @p1', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
    await workbench.waitForRestored()

    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('component.tsx'),
    )

    // The model id itself — this is what regressed the coloring and what the
    // provider selectors key on.
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20000 })
      .toBe('typescriptreact')

    const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
    expect(uri).toContain('component.tsx')

    // Provider registered for the new id AND tsserver answered for a .tsx file
    // (the plugin activated, the document mirror carried `typescriptreact`, and
    // the file was accepted into a project).
    await expect
      .poll(
        async () => {
          const d = await page.evaluate((u) => window.__E2E__!.getSemanticTokenDebug(u, 2, 3), uri)
          return {
            providerCount: d.providerCount ?? 0,
            hasTokens: (d.directTokenCount ?? 0) > 0,
          }
        },
        { timeout: 30000, intervals: [250, 500, 1000, 1000, 2000] },
      )
      .toEqual({ providerCount: 1, hasTokens: true })
  })
})
