/*---------------------------------------------------------------------------------------------
 *  History jump navigation regression (@regression).
 *
 *  Guards the fix for same-file programmatic jumps (F12 / peek-reference Enter)
 *  recording BOTH the jump origin and the target into navigation history:
 *    - "debounce race": a GoBack issued immediately after the jump used to land
 *      on the position BEFORE the origin (the 250ms cursor-recorder debounce
 *      misordered the stack).
 *    - "threshold hole": a short jump (<= 10 lines) produced no back point at
 *      all, so GoBack skipped past the origin.
 *
 *  Both scenarios drive the REAL typescript language server (coreTypescriptApp
 *  fixture, cold launch + pinned workspace) through the __E2E__ probe. The jump
 *  to the reference line goes through the references peek with the real
 *  keyboard: the peek tree opens without a focused row and Enter follows the
 *  focused row, so the spec walks focus down to the line-25 reference exactly
 *  like a user selecting it before pressing Enter.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { LaunchWorkspace, WorkbenchPO } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/coreTypescriptApp.js'

// Exact line layout of the seeded file — line numbers are the assertions, so the
// array index + 1 is the line number. The single reference line (25) names all
// three classes, giving a >10-line jump target (AttackAction, line 1) and a
// <=10-line one (NearAction, line 20) from the same origin line.
const LINES = [
  'export class AttackAction {', // 1   AttackAction definition
  '  run() {', // 2
  "    return 'attack'", // 3
  '  }', // 4
  '}', // 5
  '', // 6
  '', // 7
  '', // 8
  '', // 9
  '', // 10
  'export class MoveAction {', // 11  MoveAction declaration
  '  run() {', // 12
  "    return 'move'", // 13
  '  }', // 14
  '}', // 15
  '', // 16
  '', // 17
  '', // 18
  '', // 19
  "export class NearAction { run() { return 'near' } }", // 20  NearAction definition
  '', // 21
  '', // 22
  '', // 23
  '', // 24
  'export const actions = [new AttackAction(), new MoveAction(), new NearAction()]', // 25
]

const DEF_ATTACK_LINE = 1
const DEF_MOVE_LINE = 11
const DEF_NEAR_LINE = 20
const USE_LINE = 25

// 1-based columns of each identifier on its line, derived from the source so a
// content tweak cannot silently shift a cursor off-symbol.
const USE_LINE_TEXT = LINES[USE_LINE - 1]!
const ATTACK_COL = USE_LINE_TEXT.indexOf('AttackAction') + 1
const NEAR_COL = USE_LINE_TEXT.indexOf('NearAction') + 1
const MOVE_DECL_COL = LINES[DEF_MOVE_LINE - 1]!.indexOf('MoveAction') + 1

/**
 * Shared warm-up for both scenarios: open the seeded file, gate on the language
 * service, then reproduce the user's keyboard-driven jump to the reference line
 * via the references peek (cursor on MoveAction line 11 -> ArrowDown to select
 * the line-25 reference -> Enter follows it and closes the peek).
 */
async function primeJumpScenario(
  page: Page,
  workbench: WorkbenchPO,
  launchWorkspace: LaunchWorkspace | undefined,
): Promise<void> {
  if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
  await workbench.waitForRestored()

  await page.evaluate(
    (fsPath) => window.__E2E__!.openFileUri(fsPath),
    launchWorkspace.file('actions.ts'),
  )
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 10000 })
    .toContain('actions.ts')

  await expect
    .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), { timeout: 20000 })
    .toBe('typescript')

  const uri = (await page.evaluate(() => window.__E2E__!.getActiveEditorUri())) as string
  expect(uri).toContain('actions.ts')

  // Language service gate: the definition of the AttackAction reference on the
  // use line must resolve before we drive any jump (lazy tsserver warmup).
  await expect
    .poll(
      () =>
        page.evaluate(
          ([u, l, c]) => window.__E2E__!.getDefinition(u, l, c).then((r) => r.length > 0),
          [uri, USE_LINE, ATTACK_COL] as const,
        ),
      { timeout: 30000, intervals: [500, 1000, 1000, 2000] },
    )
    .toBe(true)

  // Cursor on the MoveAction identifier (line 11), then open the references peek.
  await expect
    .poll(() =>
      page.evaluate(([l, c]) => window.__E2E__!.setActiveEditorCursor(l, c), [
        DEF_MOVE_LINE,
        MOVE_DECL_COL,
      ] as const),
    )
    .toBe(true)
  await page.evaluate(
    () => void window.__E2E__!.runCommand('editor.action.referenceSearch.trigger'),
  )

  // Gate the Enter press on the peek tree actually holding focus — pressing
  // Enter before the peek mounts lands in the editor and corrupts the buffer.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.isReferencePeekFocused()), {
      timeout: process.env['CI'] ? 20000 : 10000,
      intervals: [250, 250, 500, 500, 1000],
    })
    .toBe(true)
  // The tree opens without a focused row, and `openReference` (what Enter runs
  // in the peek) follows the FOCUSED row — so walk focus down to the reference
  // on line 25 exactly like a user selecting it: row 0 is the file group
  // header, rows 1/2 are the declaration (11) and the use (25). This assumes
  // tsserver counts the declaration among references and orders them by
  // position; if that shape ever changes, Enter lands on the wrong row and the
  // line-25 cursor assertion below fails loudly (timeout), not silently.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  // Enter follows the selected reference to line 25 and closes the peek.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
      timeout: 10000,
    })
    .toBe(USE_LINE)
}

test.describe('history jump navigation', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        if (LINES.length !== USE_LINE) {
          throw new Error(`seed layout drifted: ${LINES.length} lines, expected ${USE_LINE}`)
        }
        writeFileSync(join(dir, 'actions.ts'), LINES.join('\n'))
        writeFileSync(
          join(dir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }, null, 2),
        )
      },
    },
  })

  test('GoBack right after F12 lands on the jump origin, not the older position @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    // Spawns a real tsserver; cold start is slow on contended CI runners.
    test.slow()
    await primeJumpScenario(page, workbench, launchWorkspace)

    // Let the 250ms cursor debounce settle the line-25 entry, then move the
    // cursor onto the AttackAction identifier of the same line (realistic
    // keyboard pace), and settle again.
    await page.waitForTimeout(400)
    await expect
      .poll(() =>
        page.evaluate(([l, c]) => window.__E2E__!.setActiveEditorCursor(l, c), [
          USE_LINE,
          ATTACK_COL,
        ] as const),
      )
      .toBe(true)
    await page.waitForTimeout(400)

    // F12 to AttackAction's definition (line 1 — a 24-line jump, above the
    // 10-line significance threshold).
    await workbench.runCommand('editor.action.revealDefinition')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
        timeout: 10000,
        intervals: [25, 50, 100, 250],
      })
      .toBe(DEF_ATTACK_LINE)

    // GoBack IMMEDIATELY — inside the cursor recorder's debounce window. Before
    // the fix this raced the pending flush and landed on line 11.
    await workbench.runCommand('workbench.action.goBack')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
        timeout: 10000,
      })
      .toBe(USE_LINE)

    // Guard the forward stack too: GoForward must return to line 1.
    await workbench.runCommand('workbench.action.goForward')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
        timeout: 10000,
      })
      .toBe(DEF_ATTACK_LINE)
  })

  test('GoBack after a short F12 jump (within the 10-line threshold) returns to the origin @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.slow()
    await primeJumpScenario(page, workbench, launchWorkspace)

    // Same pacing as above, but the cursor ends on the NearAction identifier.
    await page.waitForTimeout(400)
    await expect
      .poll(() =>
        page.evaluate(([l, c]) => window.__E2E__!.setActiveEditorCursor(l, c), [
          USE_LINE,
          NEAR_COL,
        ] as const),
      )
      .toBe(true)
    await page.waitForTimeout(400)

    // F12 to NearAction's definition (line 20 — only 5 lines away, inside the
    // significance threshold that used to swallow the back point entirely).
    await workbench.runCommand('editor.action.revealDefinition')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
        timeout: 10000,
        intervals: [25, 50, 100, 250],
      })
      .toBe(DEF_NEAR_LINE)

    // Wait out the debounce so only the threshold defect is under test, then
    // GoBack: before the fix the jump left no back point and GoBack landed on
    // line 11.
    await page.waitForTimeout(400)
    await workbench.runCommand('workbench.action.goBack')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorCursor()?.lineNumber ?? -1), {
        timeout: 10000,
      })
      .toBe(USE_LINE)
  })
})
