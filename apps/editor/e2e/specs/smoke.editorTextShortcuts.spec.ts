/*---------------------------------------------------------------------------------------------
 *  Editor text-editing shortcut guard (@p1).
 *
 *  Guards the keys published in docs/user/zh-CN/reference/editor-shortcuts.md.
 *
 *  Monaco's built-in editor keys are mirrored into KeybindingsRegistry at
 *  KeybindingWeight.MonacoDefault (50) and *deferred* by the global handler — it
 *  returns without preventDefault, so the event reaches monaco's own dispatch. A
 *  built-in key therefore only goes dead when a higher-weight binding claims it,
 *  when monaco's precondition fails, or when the language lacks the capability.
 *  The first is what this file pins; the third is pinned by the last test.
 *
 *  Two platform traps this file encodes deliberately:
 *
 *  - monaco rebinds several actions per platform (`linux:` / `win:` blocks in its
 *    kbOpts), but the bridge only mirrors the base `primary`. So on Linux the
 *    shortcut editor can name a command for a key that actually runs a different
 *    action — `Alt+Shift+Down` is mirrored as copy-line but really inserts a
 *    cursor below. The Linux entries below assert the *behaviour*, so fixing the
 *    bridge to be platform-aware will fail this file and force a doc update.
 *
 *  - the scene is a real `.json` file on purpose. In the core baseline
 *    (`extensions: []`) json is the only language that has a comment config, a
 *    formatting provider and a document-symbol provider (its worker lives in the
 *    renderer). An untitled plaintext buffer would make Ctrl+/ fail for language
 *    reasons and read as a keybinding bug.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const IS_LINUX = process.platform === 'linux'

const JSON_BODY =
  '{\n  "name": "alpha",\n  "beta": 2,\n  "alias": "alpha",\n  "gamma": {\n    "nested": 3\n  }\n}\n'

/** MonacoDefault — the only weight the dispatcher defers without preventDefault. */
const MONACO_DEFAULT_WEIGHT = 50

type DocKey = readonly [key: string, command: string]

/** Single-stroke keys whose mirrored command matches what monaco really runs. */
const STROKE_KEYS: readonly DocKey[] = [
  ['ctrl+/', 'editor.action.commentLine'],
  ['ctrl+shift+k', 'editor.action.deleteLines'],
  ['ctrl+enter', 'editor.action.insertLineAfter'],
  ['ctrl+shift+enter', 'editor.action.insertLineBefore'],
  ['ctrl+]', 'editor.action.indentLines'],
  ['ctrl+[', 'editor.action.outdentLines'],
  ['ctrl+d', 'editor.action.addSelectionToNextFindMatch'],
  ['ctrl+shift+l', 'editor.action.selectHighlights'],
  ['ctrl+f2', 'editor.action.changeAll'],
  ['alt+shift+i', 'editor.action.insertCursorAtEndOfEachLineSelected'],
  ['ctrl+u', 'cursorUndo'],
  ['ctrl+l', 'expandLineSelection'],
  ['ctrl+a', 'editor.action.selectAll'],
  ['ctrl+z', 'undo'],
  ['ctrl+y', 'redo'],
  ['ctrl+g', 'editor.action.gotoLine'],
  ['ctrl+shift+o', 'editor.action.quickOutline'],
  ['ctrl+space', 'editor.action.triggerSuggest'],
  ['ctrl+shift+space', 'editor.action.triggerParameterHints'],
  ['ctrl+.', 'editor.action.quickFix'],
  ['f2', 'editor.action.rename'],
  ['ctrl+shift+\\', 'editor.action.jumpToBracket'],
  ['alt+shift+right', 'editor.action.smartSelect.expand'],
  ['alt+shift+left', 'editor.action.smartSelect.shrink'],
  ['ctrl+shift+[', 'editor.fold'],
  ['ctrl+shift+]', 'editor.unfold'],
  ['ctrl+f3', 'editor.action.nextSelectionMatchFindAction'],
  ['ctrl+shift+f3', 'editor.action.previousSelectionMatchFindAction'],
  ['f8', 'editor.action.marker.nextInFiles'],
  ['shift+f8', 'editor.action.marker.prevInFiles'],
  ['f7', 'editor.action.wordHighlight.next'],
  ['shift+f7', 'editor.action.wordHighlight.prev'],
  ['alt+f8', 'editor.action.marker.next'],
  ['alt+shift+f8', 'editor.action.marker.prev'],
]

/** Platform-divergent keys: monaco's own `windows`-flavoured binding. */
const WIN_KEYS: readonly DocKey[] = [
  ['alt+shift+down', 'editor.action.copyLinesDownAction'],
  ['alt+shift+up', 'editor.action.copyLinesUpAction'],
  ['ctrl+alt+down', 'editor.action.insertCursorBelow'],
  ['ctrl+alt+up', 'editor.action.insertCursorAbove'],
  ['alt+shift+a', 'editor.action.blockComment'],
  ['alt+shift+f', 'editor.action.formatDocument'],
]

/**
 * Keys monaco rebinds per platform. On Linux the bridge still mirrors the base
 * (windows-flavoured) key, so the registry names one command while monaco runs
 * another — or nothing at all. Asserted as observed behaviour, so making the
 * bridge platform-aware fails here and forces the doc's platform table to move.
 */
const LINUX_DIVERGENT: ReadonlyArray<readonly [string, string]> = [
  ['alt+shift+a', 'editor.action.blockComment'],
  ['alt+shift+down', 'editor.action.copyLinesDownAction'],
  ['alt+shift+up', 'editor.action.copyLinesUpAction'],
  ['ctrl+alt+down', 'editor.action.insertCursorBelow'],
  ['ctrl+alt+up', 'editor.action.insertCursorAbove'],
]

/** 2-stroke chords, traced as [first, second]. */
const CHORD_KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ['ctrl+k', 'ctrl+c', 'editor.action.addCommentLine'],
  ['ctrl+k', 'ctrl+u', 'editor.action.removeCommentLine'],
  ['ctrl+k', 'ctrl+f', 'editor.action.formatSelection'],
  ['ctrl+k', 'ctrl+0', 'editor.foldAll'],
  ['ctrl+k', 'ctrl+j', 'editor.unfoldAll'],
  ['ctrl+k', 'ctrl+[', 'editor.foldRecursively'],
  ['ctrl+k', 'ctrl+]', 'editor.unfoldRecursively'],
  ['ctrl+k', 'ctrl+/', 'editor.foldAllBlockComments'],
]

/**
 * Keys the project claims on purpose, so the doc can tell users what a key does
 * *here* instead of what monaco would have done with it.
 */
const OCCUPIED_KEYS: readonly DocKey[] = [
  ['alt+up', 'findWordAtCursor.previous'],
  ['alt+down', 'findWordAtCursor.next'],
  ['f1', 'workbench.action.showCommands'],
  ['ctrl+f', 'workbench.action.editor.find'],
  ['ctrl+h', 'workbench.action.editor.findReplace'],
  ['f3', 'workbench.action.editor.findNext'],
  ['shift+f3', 'workbench.action.editor.findPrevious'],
  // Linux rebinds formatDocument to ctrl+shift+i, which the workbench already
  // uses for DevTools — so on Linux there is no working format-document key.
  ['ctrl+shift+i', 'workbench.action.toggleDevTools'],
]

const LINUX_OCCUPIED_KEYS: readonly DocKey[] = [
  ['ctrl+alt+shift+down', 'workbench.action.increaseViewHeight'],
  ['ctrl+alt+shift+up', 'workbench.action.decreaseViewHeight'],
]

const text = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorText())
const selCount = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorSelectionCount())

async function setText(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((t) => window.__E2E__!.setActiveEditorText(t), body))
    .toBe(true)
}

/** One temp dir per call: the core suite is fullyParallel, so tests must not share one. */
async function openJsonEditor(
  page: Page,
  workbench: { openWorkspace(p: string): Promise<void> },
  body = JSON_BODY,
): Promise<void> {
  const dir = mkTempDir('universe-editor-e2e-editor-keys-')
  const jsonPath = join(dir, 'editor-keys.json')
  writeFileSync(jsonPath, body, 'utf8')
  await workbench.openWorkspace(dir)
  await page.evaluate((p) => window.__E2E__!.openFileUri(p), jsonPath)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('activeEditorLanguageId')))
    .toBe('json')
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('editorTextFocus')))
    .toBe(true)
}

test.describe('@p1 editor text shortcuts', () => {
  test('documented editor keys still resolve to their monaco command', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    const platformKeys = IS_LINUX ? [] : WIN_KEYS
    for (const [key, command] of [...STROKE_KEYS, ...platformKeys]) {
      await test.step(`${key} → ${command}`, async () => {
        const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
        const rivals = trace.candidates
          .filter((c) => c.selected && c.command !== command)
          .map((c) => `${c.command}@${c.weight}[${c.when ?? 'always'}]`)
        expect(
          trace.command,
          `${key} no longer resolves to ${command}; winner=${trace.command}@${trace.weight}` +
            (rivals.length ? ` (rivals: ${rivals.join(', ')})` : ''),
        ).toBe(command)
        expect(
          trace.weight,
          `${key} is no longer a deferred monaco default (weight ${trace.weight}) — ` +
            'a higher weight means the dispatcher preventDefaults and monaco never sees it',
        ).toBe(MONACO_DEFAULT_WEIGHT)
      })
    }

    for (const [first, second, command] of CHORD_KEYS) {
      await test.step(`${first} ${second} → ${command}`, async () => {
        const trace = await page.evaluate(
          ([f, s]) => window.__E2E__!.traceKeybinding(s!, [f!]),
          [first, second],
        )
        expect(trace.command, `${first} ${second} no longer resolves to ${command}`).toBe(command)
      })
    }
  })

  test('linux: monaco rebinds make the mirrored keys diverge', async ({ page, workbench }) => {
    test.skip(!IS_LINUX, 'windows uses the base binding, covered by the test above')
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    for (const [key, mirrored] of LINUX_DIVERGENT) {
      await test.step(`${key} is mirrored as ${mirrored} but monaco disagrees`, async () => {
        const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
        expect(
          trace.command,
          `${key} no longer mirrors ${mirrored} — if the bridge became platform-aware, ` +
            "update the doc's platform table and drop this entry",
        ).toBe(mirrored)
      })
    }

    // ...and the wrap-around that makes it reachable anyway: whatever the
    // registry does not know about falls through to monaco untouched.
    await setText(page, JSON_BODY)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
    await page.keyboard.press('Alt+Shift+A')
    await expect.poll(() => text(page)).toBe(JSON_BODY)

    await setText(page, JSON_BODY)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
    await page.keyboard.press('Control+Shift+A')
    await expect.poll(() => text(page)).toContain('/*')

    await setText(page, JSON_BODY)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
    await page.keyboard.press('Alt+Shift+ArrowDown')
    await expect.poll(() => selCount(page)).toBe(2)
  })

  test('keys the workbench claims on purpose still belong to the workbench', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    const occupied = IS_LINUX ? [...OCCUPIED_KEYS, ...LINUX_OCCUPIED_KEYS] : OCCUPIED_KEYS
    for (const [key, command] of occupied) {
      await test.step(`${key} → ${command}`, async () => {
        const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
        expect(
          trace.command,
          `${key} changed hands — the doc's "keys the workbench claims" table is stale`,
        ).toBe(command)
      })
    }
  })

  test('editor text shortcuts really edit the buffer', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    await test.step('Ctrl+Shift+K deletes the current line', async () => {
      await setText(page, JSON_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
      await page.keyboard.press('Control+Shift+k')
      await expect.poll(() => text(page)).toBe(JSON_BODY.replace('  "name": "alpha",\n', ''))
    })

    await test.step('Ctrl+Enter inserts a line below', async () => {
      await setText(page, JSON_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('Control+Enter')
      // Auto-indent pads the new line with the current indent, so assert the line
      // count rather than the exact text.
      const lineCount = async () => ((await text(page)) ?? '').split('\n').length
      await expect.poll(lineCount).toBe(JSON_BODY.split('\n').length + 1)
    })

    await test.step('Ctrl+D selects the next occurrence of the word', async () => {
      await setText(page, JSON_BODY)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorSelection(2, 12, 2, 17)))
        .toBe(true)
      await page.keyboard.press('Control+d')
      await expect.poll(() => selCount(page)).toBe(2)
    })

    await test.step('Ctrl+Z undoes, Ctrl+Y redoes', async () => {
      await setText(page, JSON_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
      await page.keyboard.press('Control+Shift+k')
      await expect.poll(() => text(page)).not.toBe(JSON_BODY)
      await page.keyboard.press('Control+z')
      await expect.poll(() => text(page)).toBe(JSON_BODY)
      await page.keyboard.press('Control+y')
      await expect.poll(() => text(page)).not.toBe(JSON_BODY)
    })

    await test.step('Ctrl+K Ctrl+0 resolves and runs the fold-all chord', async () => {
      await setText(page, JSON_BODY)
      await page.keyboard.press('Control+k')
      await page.keyboard.press('Control+0')
      // Folding is visibly observable only through monaco's DOM (39 → 5 rendered
      // lines), which specs must not assert. The chord's effect on the buffer is
      // "none", and that is what is checkable here: a stolen chord would type
      // into the buffer instead.
      await expect.poll(() => text(page)).toBe(JSON_BODY)
    })
  })

  test('comment toggling is gated by the language, not by the key', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    await setText(page, JSON_BODY)
    await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
    await page.keyboard.press('Control+Slash')
    await expect.poll(() => text(page)).toContain('// "name": "alpha"')

    // Same key in an untitled plaintext buffer: no comment configuration, so the
    // command declines silently. Without this contrast the JSON case above would
    // not tell a keybinding break from a language limitation.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect.poll(() => workbench.getActiveEditorUri()).toMatch(/^untitled:/)
    await setText(page, 'plain text\nsecond line\n')
    await page.keyboard.press('Control+Slash')
    await page.waitForTimeout(300)
    await expect.poll(() => text(page)).toBe('plain text\nsecond line\n')
  })
})
