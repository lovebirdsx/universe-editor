/*---------------------------------------------------------------------------------------------
 *  Markdown editing commands smoke (P1).
 *
 *  Exercises every editing feature shipped by the markdown extension end-to-end:
 *  the command travels renderer → extension host → back through the new
 *  `mainThreadEditor` channel, which applies the edit to the live Monaco model.
 *  Each case seeds a known document + selection through the probe, runs the
 *  contributed command by id (the `when` clause only gates keybindings, not
 *  direct execution), and asserts the resulting text or cursor.
 *
 *  Keybinding registration is asserted separately against KeybindingsRegistry —
 *  the robust way to prove the `contributes.keybindings` wiring (and the
 *  Ctrl+B / Alt+S conflict resolution) without simulating physical keystrokes.
 *
 *  Spawns the real extension-host subprocess, so the first edit polls until the
 *  host has booted and the extension has activated on `onLanguage:markdown`.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'
import type { WorkbenchPO } from '../pages/WorkbenchPO.js'

function writeWorkspace(): { dir: string; mdPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-mdedit-'))
  const mdPath = join(dir, 'edit.md')
  writeFileSync(mdPath, '# Scratch\n')
  return { dir: dir.replace(/\\/g, '/'), mdPath: mdPath.replace(/\\/g, '/') }
}

interface EditCase {
  /** Seed text for the model. */
  text: string
  /** 1-based selection [startLine, startCol, endLine, endCol]; a point when collapsed. */
  selection: [number, number, number, number]
  command: string
}

/**
 * Run an editing command against a freshly-seeded document and return the
 * resulting text. Setup is idempotent (text + selection reset every call), so
 * wrapping the whole thing in expect.poll safely waits out the extension-host
 * cold start without compounding edits.
 */
async function runEdit(workbench: WorkbenchPO, c: EditCase): Promise<string | undefined> {
  await workbench.setActiveEditorText(c.text)
  await workbench.setActiveEditorSelection(
    c.selection[0],
    c.selection[1],
    c.selection[2],
    c.selection[3],
  )
  try {
    await workbench.runCommand(c.command)
  } catch (err) {
    // The extension host hasn't registered the real command handler yet: the
    // renderer forwards the contributed command to the host, and until the
    // extension has activated on `onLanguage:markdown` the command routes back
    // and is rejected ("extension host may only execute _workbench.* commands").
    // Return an unmatched value so the surrounding expect.poll keeps retrying
    // through the cold start instead of blowing up (Playwright's poll does NOT
    // retry when its callback throws — a rejection punches straight through).
    if (/extension host may only execute/.test(String(err))) return undefined
    throw err
  }
  // Monaco picks CRLF on Windows when the seed has no line break; assertions are EOL-agnostic.
  return (await workbench.getActiveEditorText())?.replace(/\r\n/g, '\n')
}

function expectEdit(workbench: WorkbenchPO, c: EditCase) {
  return expect.poll(() => runEdit(workbench, c), { timeout: 15000 })
}

test.describe('@p1 markdown editing commands', () => {
  test('covers inline emphasis, headings, tasks, smart lists, renumber, and tables', async ({
    page,
    workbench,
  }) => {
    // Spawns a real extension-host subprocess; cold start is slow on CI.
    test.slow()
    await workbench.waitForRestored()

    const { dir, mdPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')

    // The contributed commands must be registered (host booted + manifest scanned)
    // before any direct execution can reach the extension's handlers.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('markdown.editing.toggleBold')), {
        timeout: 15000,
      })
      .toBe(true)

    await workbench.focusActiveEditorGroup()

    // ---- A5 / B1 / B2 / B3 / B5: inline emphasis (wrap selection) -------------
    // The first assertion doubles as the activation gate (polls through host boot).
    await expectEdit(workbench, {
      text: 'hello world',
      selection: [1, 1, 1, 6],
      command: 'markdown.editing.toggleBold',
    }).toBe('**hello** world')

    await expectEdit(workbench, {
      text: 'hello world',
      selection: [1, 1, 1, 6],
      command: 'markdown.editing.toggleItalic',
    }).toBe('*hello* world')

    await expectEdit(workbench, {
      text: 'hello world',
      selection: [1, 1, 1, 6],
      command: 'markdown.editing.toggleInlineCode',
    }).toBe('`hello` world')

    await expectEdit(workbench, {
      text: 'hello world',
      selection: [1, 1, 1, 6],
      command: 'markdown.editing.toggleStrikethrough',
    }).toBe('~~hello~~ world')

    await expectEdit(workbench, {
      text: 'hello world',
      selection: [1, 1, 1, 6],
      command: 'markdown.editing.toggleMath',
    }).toBe('$hello$ world')

    // Toggle off: a selection already wrapped in `**` unwraps.
    await expectEdit(workbench, {
      text: '**hello** world',
      selection: [1, 1, 1, 10],
      command: 'markdown.editing.toggleBold',
    }).toBe('hello world')

    // Toggle off with an empty cursor anywhere inside the wrapped span.
    await expectEdit(workbench, {
      text: '*hello, world*',
      selection: [1, 11, 1, 11],
      command: 'markdown.editing.toggleItalic',
    }).toBe('hello, world')

    await expectEdit(workbench, {
      text: '*hello, world*',
      selection: [1, 9, 1, 14],
      command: 'markdown.editing.toggleItalic',
    }).toBe('hello, world')

    await workbench.setActiveEditorText('*hello, world*')
    await workbench.setActiveEditorCursor(1, 11)
    await page.keyboard.press('Control+I')
    await expect.poll(() => workbench.getActiveEditorText()).toBe('hello, world')

    // ---- B4: heading level up / down -----------------------------------------
    await expectEdit(workbench, {
      text: 'title',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.headingUp',
    }).toBe('# title')

    await expectEdit(workbench, {
      text: '## title',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.headingDown',
    }).toBe('# title')

    // ---- A1: task completion toggle ------------------------------------------
    await expectEdit(workbench, {
      text: '- buy milk',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.toggleTask',
    }).toBe('- [x] buy milk')

    await expectEdit(workbench, {
      text: '- [x] buy milk',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.toggleTask',
    }).toBe('- [ ] buy milk')

    // ---- A2: smart Enter (continue / increment / exit) -----------------------
    await expectEdit(workbench, {
      text: '- item',
      selection: [1, 7, 1, 7],
      command: 'markdown.editing.onEnter',
    }).toBe('- item\n- ')

    await expectEdit(workbench, {
      text: '1. first',
      selection: [1, 9, 1, 9],
      command: 'markdown.editing.onEnter',
    }).toBe('1. first\n2. ')

    await expectEdit(workbench, {
      text: '- first\n- ',
      selection: [2, 3, 2, 3],
      command: 'markdown.editing.onEnter',
    }).toBe('- first\n')

    // ---- A3: smart Tab / Shift+Tab (indent / outdent) ------------------------
    await expectEdit(workbench, {
      text: '- item',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.onTab',
    }).toBe('  - item')

    await expectEdit(workbench, {
      text: '  - item',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.onShiftTab',
    }).toBe('- item')

    // ---- A4: ordered-list auto-renumber (triggered by indenting a middle item)-
    await expectEdit(workbench, {
      text: '1. a\n2. b\n3. c',
      selection: [2, 1, 2, 1],
      command: 'markdown.editing.onTab',
    }).toBe('1. a\n  2. b\n2. c')

    // ---- A6: table formatting (align columns) --------------------------------
    await expectEdit(workbench, {
      text: '| a | bb |\n| - | - |\n| ccc | d |',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.formatTable',
    }).toBe('| a   | bb  |\n| --- | --- |\n| ccc | d   |')

    // ---- B6: in-table Tab navigation (cursor jumps to the next cell) ----------
    await workbench.setActiveEditorText('| a | b |\n| - | - |\n| 1 | 2 |')
    await workbench.setActiveEditorCursor(3, 3)
    await expect
      .poll(
        async () => {
          await workbench.setActiveEditorText('| a | b |\n| - | - |\n| 1 | 2 |')
          await workbench.setActiveEditorCursor(3, 3)
          await workbench.runCommand('markdown.editing.onTab')
          return page.evaluate(() => window.__E2E__!.getActiveEditorCursor())
        },
        { timeout: 15000 },
      )
      .toEqual({ lineNumber: 3, column: 7 })
  })

  test('operates on non-final lines and CRLF documents (regression)', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, mdPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('markdown.editing.toggleTask')), {
        timeout: 15000,
      })
      .toBe(true)

    await workbench.focusActiveEditorGroup()

    // Bug: these all "only worked on the last line" because CRLF left a trailing
    // \r on every other line, defeating the parsers. Operate on line 1 of a
    // multi-line document and assert the *first* line changes.

    // Task toggle on the first of several lines.
    await expectEdit(workbench, {
      text: '- one\n- two\n- three',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.toggleTask',
    }).toBe('- [x] one\n- two\n- three')

    // Smart Enter continuing the first list item (not the last).
    await expectEdit(workbench, {
      text: '- one\n- two',
      selection: [1, 6, 1, 6],
      command: 'markdown.editing.onEnter',
    }).toBe('- one\n- \n- two')

    // Smart Enter mid ordered list must renumber following items in place, not
    // duplicate them: the inserted line + renumber edits once corrupted the doc
    // because they used inconsistent (pre/post-insertion) line coordinates.
    await expectEdit(workbench, {
      text: '1. hello\n2. world\n2. yes',
      selection: [2, 9, 2, 9],
      command: 'markdown.editing.onEnter',
    }).toBe('1. hello\n2. world\n3. \n4. yes')

    // Auto-renumber when indenting a middle item of a top-of-document list.
    await expectEdit(workbench, {
      text: '1. a\n2. b\n3. c\n\ntail',
      selection: [2, 1, 2, 1],
      command: 'markdown.editing.onTab',
    }).toBe('1. a\n  2. b\n2. c\n\ntail')

    // Heading change on a non-final line: increase adds, decrease removes a #.
    await expectEdit(workbench, {
      text: '## title\n\nbody',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.headingUp',
    }).toBe('### title\n\nbody')

    await expectEdit(workbench, {
      text: '## title\n\nbody',
      selection: [1, 1, 1, 1],
      command: 'markdown.editing.headingDown',
    }).toBe('# title\n\nbody')
  })

  test('formats every table when nothing is selected', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, mdPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('markdown.editing.formatTable')), {
        timeout: 15000,
      })
      .toBe(true)

    await workbench.focusActiveEditorGroup()

    // Two tables; an empty cursor sits in the prose between them. Format-table
    // with no selection must align BOTH tables, not just the one under the cursor.
    const doc = '| a | bb |\n| - | - |\n| ccc | d |\n\nmid\n\n| x | y |\n| - | - |\n| zzzz | w |'
    const expected =
      '| a   | bb  |\n| --- | --- |\n| ccc | d   |\n\nmid\n\n| x    | y   |\n| ---- | --- |\n| zzzz | w   |'
    await expectEdit(workbench, {
      text: doc,
      selection: [5, 1, 5, 1], // empty cursor on the "mid" prose line
      command: 'markdown.editing.formatTable',
    }).toBe(expected)
  })

  test('in-table Tab to the first cell lands on its content', async ({ page, workbench }) => {
    test.slow()
    await workbench.waitForRestored()

    const { dir, mdPath } = writeWorkspace()
    await page.evaluate((fsPath) => window.__E2E__!.openWorkspace(fsPath), dir)
    await page.evaluate((fsPath) => window.__E2E__!.openFileUri(fsPath), mdPath)

    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'))
      .toBe('markdown')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('markdown.editing.onShiftTab')), {
        timeout: 15000,
      })
      .toBe(true)

    await workbench.focusActiveEditorGroup()

    // Cursor in the 2nd cell of "| foo | bar |"; Shift+Tab → first cell. The
    // caret must land on 'foo' (column 3, 1-based), not before the leading pipe.
    const seed = '| foo | bar |\n| --- | --- |\n| 1 | 2 |'
    await expect
      .poll(
        async () => {
          await workbench.setActiveEditorText(seed)
          await workbench.setActiveEditorCursor(1, 9) // inside "bar"
          await workbench.runCommand('markdown.editing.onShiftTab')
          return page.evaluate(() => window.__E2E__!.getActiveEditorCursor())
        },
        { timeout: 15000 },
      )
      .toEqual({ lineNumber: 1, column: 3 })
  })

  test('registers contributed keybindings with markdown-focus precedence', async ({
    page,
    workbench,
  }) => {
    test.slow()
    await workbench.waitForRestored()

    // Wait for the extension host to boot so contributed keybindings are loaded.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('markdown.editing.toggleBold')), {
        timeout: 15000,
      })
      .toBe(true)

    // Ctrl+B is bound to BOTH the sidebar toggle (workbench) and bold (plugin) —
    // the plugin wins under `editorTextFocus && editorLangId == markdown`, the
    // workbench command wins elsewhere. Both must be present in the registry.
    const ctrlB = await workbench.getKeybindingCommandsForKey('ctrl+b')
    expect(ctrlB).toContain('workbench.action.toggleSidebarVisibility')
    expect(ctrlB).toContain('markdown.editing.toggleBold')

    expect(await workbench.getKeybindingCommandsForKey('ctrl+i')).toContain(
      'markdown.editing.toggleItalic',
    )
    expect(await workbench.getKeybindingCommandsForKey('alt+c')).toContain(
      'markdown.editing.toggleTask',
    )
    expect(await workbench.getKeybindingCommandsForKey('enter')).toContain(
      'markdown.editing.onEnter',
    )
    expect(await workbench.getKeybindingCommandsForKey('tab')).toContain('markdown.editing.onTab')
  })
})
