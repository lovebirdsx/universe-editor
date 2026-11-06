/*---------------------------------------------------------------------------------------------
 *  TypeScript Find File References smoke (P1).
 *
 *  Drives the whole chain: renderer command -> extension host command -> TSLS
 *  tsserver passthrough (`fileReferences`) -> Location[] -> Monaco references
 *  peek. The peek must actually focus and Enter must land in the importing file,
 *  so a provider-only success cannot pass this.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/typescriptApp.js'

const LIB = [
  'export function greet(name: string): string {',
  '  return `hello ${name}`',
  '}',
  '',
].join('\n')

const USE = ["import { greet } from './lib'", '', "export const message = greet('world')", ''].join(
  '\n',
)

test.describe('@p1 typescript file references', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'lib.ts'), LIB)
        writeFileSync(join(dir, 'use.ts'), USE)
        writeFileSync(
          join(dir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
        )
      },
    },
  })

  test('lists importers in the references peek and jumps to one', async ({
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
      launchWorkspace.file('lib.ts'),
    )
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20000 })
      .toBe('typescript')

    // Drive the default chord rather than runCommand so the keybinding itself
    // is covered. tsserver answers "No Project." until the project loads, so
    // the command returns nothing and the peek appears only on a later retry.
    await expect
      .poll(
        async () => {
          await page.keyboard.press('Control+K')
          await page.keyboard.press('Control+R')
          await new Promise((resolve) => setTimeout(resolve, 400))
          return page.evaluate(() => window.__E2E__!.isReferencePeekFocused())
        },
        { timeout: 30000, intervals: [500, 1000, 1000, 2000] },
      )
      .toBe(true)

    await page.keyboard.press('Enter')
    await expect.poll(() => workbench.getActiveEditorUri(), { timeout: 10000 }).toContain('use.ts')
  })
})
