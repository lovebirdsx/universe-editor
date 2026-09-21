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
 *  Three things this file encodes deliberately:
 *
 *  - the mirror resolves monaco's per-platform `win` / `mac` / `linux` blocks the
 *    way monaco's own `bindToCurrentPlatform` does (whole-rule replacement), so on
 *    the running platform the shortcut editor names the key monaco really runs —
 *    on Linux `Ctrl+Alt+Shift+↑/↓` is copy-line, and `Alt+Shift+↑/↓` adds a cursor
 *    above/below. A bridge that regresses to mirroring the base rule only fails
 *    here.
 *
 *  - four built-in features have no reachable default key left, because this
 *    editor claims their native key for something else. Each is restored on an
 *    alternative key by monacoCompatKeybindings.ts; the second test pins those
 *    keys, their weight (they must outrank the deferral at 50, or the key would
 *    be dead) and that they really act on the buffer.
 *
 *  - `F9` / `Shift+F9` sort the selected lines. These are not restorations —
 *    monaco ships no key for the sort actions at all — so they live in
 *    monacoExtraKeybindings.ts, and the third test pins them the same way plus
 *    the selection bound the sort must respect.
 *
 *  The scene is a real `.json` file on purpose. In the core baseline
 *  (`extensions: []`) json is the only language that has a comment config, a
 *  formatting provider and a document-symbol provider (its worker lives in the
 *  renderer). An untitled plaintext buffer would make Ctrl+/ fail for language
 *  reasons and read as a keybinding bug.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

const IS_LINUX = process.platform === 'linux'

const JSON_BODY =
  '{\n  "name": "alpha",\n  "beta": 2,\n  "alias": "alpha",\n  "gamma": {\n    "nested": 3\n  }\n}\n'

/** One-line json, so a formatter run is unmistakable in the buffer. */
const FLAT_JSON_BODY = '{"name":"alpha","beta":2}'

/** Taller than any editor viewport, so a page-scroll has somewhere to go. */
const TALL_JSON_BODY = `{\n${Array.from({ length: 200 }, (_, i) => `  "key${i}": ${i},`).join(
  '\n',
)}\n  "last": true\n}\n`

/** MonacoDefault — the only weight the dispatcher defers without preventDefault. */
const MONACO_DEFAULT_WEIGHT = 50

/** `WorkbenchContrib` — what Action2 and registerKeybinding default to. */
const WORKBENCH_CONTRIB_WEIGHT = 200

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
 * Keys monaco rebinds on Linux. The mirror resolves the same platform block, so
 * these assert the *rebound* key — a bridge that ignores `linux:` mirrors the
 * base key instead and fails here.
 */
const LINUX_REBOUND_KEYS: readonly DocKey[] = [
  ['alt+shift+down', 'editor.action.insertCursorBelow'],
  ['alt+shift+up', 'editor.action.insertCursorAbove'],
  ['ctrl+shift+a', 'editor.action.blockComment'],
  // ctrl+shift+i is the one Linux rebind that is *not* pressable: the workbench
  // claims it for DevTools (see the occupied list). Its registration is asserted
  // in the binding-enumeration test below instead.
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
 * *here* instead of what monaco would have done with it. The resize keys are
 * listed for every platform: their when-clause is `... || editorAreaFocus`,
 * which has nothing to do with the platform.
 */
const OCCUPIED_KEYS: readonly DocKey[] = [
  ['alt+up', 'findWordAtCursor.previous'],
  ['alt+down', 'findWordAtCursor.next'],
  ['f1', 'workbench.action.showCommands'],
  ['ctrl+f', 'workbench.action.editor.find'],
  ['ctrl+h', 'workbench.action.editor.findReplace'],
  ['f3', 'workbench.action.editor.findNext'],
  ['shift+f3', 'workbench.action.editor.findPrevious'],
  ['ctrl+alt+shift+down', 'workbench.action.increaseViewHeight'],
  ['ctrl+alt+shift+up', 'workbench.action.decreaseViewHeight'],
  // Linux rebinds formatDocument to ctrl+shift+i, which the workbench already
  // uses for DevTools — the mirrored row exists, the workbench still wins it.
  ['ctrl+shift+i', 'workbench.action.toggleDevTools'],
]

/**
 * The alternative keys monacoCompatKeybindings.ts restores. Hardcoded on
 * purpose: importing the renderer module would make the spec agree with the
 * implementation by construction, which is the one thing a guard must not do.
 */
const COMPAT_KEYS: readonly DocKey[] = [
  ['ctrl+shift+up', 'editor.action.moveLinesUpAction'],
  ['ctrl+shift+down', 'editor.action.moveLinesDownAction'],
  ['ctrl+shift+alt+f', 'editor.toggleFold'],
  ['shift+alt+pageup', 'scrollPageUp'],
  ['shift+alt+pagedown', 'scrollPageDown'],
]

/** Linux-only entries: elsewhere the native key works, so no alternative is offered. */
const COMPAT_KEYS_LINUX: readonly DocKey[] = [
  ['ctrl+shift+d', 'editor.action.copyLinesDownAction'],
  ['ctrl+shift+alt+d', 'editor.action.copyLinesUpAction'],
  ['shift+alt+f', 'editor.action.formatDocument'],
]

/**
 * Keys this editor adds for core commands monaco ships *keyless* — not
 * restorations of a taken key, so they are not in the compat table. Same rule
 * though: hardcoded, because importing the renderer table would make the guard
 * agree with the implementation by construction.
 */
const ADDED_KEYS: readonly DocKey[] = [
  ['f9', 'editor.action.sortLinesAscending'],
  ['shift+f9', 'editor.action.sortLinesDescending'],
]

/** Four unsorted lines: the sort must touch the selected ones and leave the rest. */
const SORT_BODY = 'dddd\ncccc\naaaa\nbbbb\n'

interface RegisteredBinding {
  readonly command: string
  readonly key: string
  readonly weight: number
}

const text = (page: Page) => page.evaluate(() => window.__E2E__!.getActiveEditorText())
const selCount = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorSelectionCount())
const firstVisibleLine = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorFirstVisibleLine())
const visibleLineCount = (page: Page) =>
  page.evaluate(() => window.__E2E__!.getActiveEditorVisibleLineCount())

async function setText(page: Page, body: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((t) => window.__E2E__!.setActiveEditorText(t), body))
    .toBe(true)
}

async function registry(page: Page): Promise<readonly RegisteredBinding[]> {
  return page.evaluate(() => window.__E2E__!.getAllKeybindings())
}

/** Registered at `weight`, regardless of who would win the key at runtime. */
function mirrored(
  bindings: readonly RegisteredBinding[],
  key: string,
  command: string,
  weight: number = MONACO_DEFAULT_WEIGHT,
): boolean {
  return bindings.some((kb) => kb.key === key && kb.command === command && kb.weight === weight)
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

  test('the mirror resolves monaco’s per-platform rebinds', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    // Platform-truth sentinel: the bridge derives the platform from monaco's own
    // `OS` constant, and `isLinux` is seeded from the same place. A second
    // platform source (e.g. process.platform) would make them disagree.
    expect(await page.evaluate(() => window.__E2E__!.getContextKey('isLinux'))).toBe(IS_LINUX)

    if (IS_LINUX) {
      for (const [key, command] of LINUX_REBOUND_KEYS) {
        await test.step(`${key} → ${command}`, async () => {
          const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
          expect(
            trace.command,
            `${key} no longer resolves to the Linux rebind ${command} — the mirror is ` +
              'reading the base rule again',
          ).toBe(command)
          expect(trace.weight).toBe(MONACO_DEFAULT_WEIGHT)
        })
      }
    }

    const bindings = await registry(page)

    // Keys the mirror must NOT carry: monaco dropped them on this platform, and
    // a phantom row is what the shortcut editor would show the user instead.
    const stale: readonly DocKey[] = IS_LINUX
      ? [
          ['alt+shift+up', 'editor.action.copyLinesUpAction'],
          ['alt+shift+down', 'editor.action.copyLinesDownAction'],
          ['alt+shift+a', 'editor.action.blockComment'],
          ['alt+shift+f', 'editor.action.formatDocument'],
          ['ctrl+pageup', 'scrollPageUp'],
          ['ctrl+pagedown', 'scrollPageDown'],
        ]
      : [
          ['alt+ctrl+shift+up', 'editor.action.copyLinesUpAction'],
          ['alt+ctrl+shift+down', 'editor.action.copyLinesDownAction'],
          ['ctrl+shift+a', 'editor.action.blockComment'],
          ['ctrl+shift+i', 'editor.action.formatDocument'],
        ]
    for (const [key, command] of stale) {
      await test.step(`${key} is not mirrored as ${command} here`, async () => {
        expect(
          mirrored(bindings, key, command),
          `${key} is registered as ${command} at weight ${MONACO_DEFAULT_WEIGHT}, but monaco ` +
            'has no such binding on this platform',
        ).toBe(false)
      })
    }

    // ...and the keys it must carry instead.
    const expected: readonly DocKey[] = IS_LINUX
      ? [
          ['alt+ctrl+shift+up', 'editor.action.copyLinesUpAction'],
          ['alt+ctrl+shift+down', 'editor.action.copyLinesDownAction'],
          ['ctrl+shift+a', 'editor.action.blockComment'],
          ['ctrl+shift+i', 'editor.action.formatDocument'],
          ['alt+pageup', 'scrollPageUp'],
          ['alt+pagedown', 'scrollPageDown'],
        ]
      : [
          ['alt+shift+up', 'editor.action.copyLinesUpAction'],
          ['alt+shift+down', 'editor.action.copyLinesDownAction'],
          ['alt+shift+a', 'editor.action.blockComment'],
          ['alt+shift+f', 'editor.action.formatDocument'],
        ]
    for (const [key, command] of expected) {
      await test.step(`${key} is mirrored as ${command}`, async () => {
        expect(
          mirrored(bindings, key, command),
          `${key} should be registered as ${command} at weight ${MONACO_DEFAULT_WEIGHT}`,
        ).toBe(true)
      })
    }
  })

  test('keys the workbench claims on purpose still belong to the workbench', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    for (const [key, command] of OCCUPIED_KEYS) {
      await test.step(`${key} → ${command}`, async () => {
        const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
        expect(
          trace.command,
          `${key} changed hands — the doc's "keys the workbench claims" table is stale`,
        ).toBe(command)
      })
    }
  })

  test('alternative keys reach the features the workbench took over', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    const compat = IS_LINUX ? [...COMPAT_KEYS, ...COMPAT_KEYS_LINUX] : COMPAT_KEYS

    for (const [, command] of compat) {
      await test.step(`${command} exists`, async () => {
        await expect
          .poll(() => page.evaluate((c) => window.__E2E__!.hasCommand(c), command), {
            message:
              `${command} is not registered — the alternative key would swallow the ` +
              'keystroke with nothing to run',
          })
          .toBe(true)
      })
    }

    for (const [key, command] of compat) {
      await test.step(`${key} → ${command}`, async () => {
        const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
        expect(trace.command, `${key} does not reach ${command}`).toBe(command)
        expect(
          trace.weight,
          `${key} sits at weight ${trace.weight}; at ${MONACO_DEFAULT_WEIGHT} the dispatcher ` +
            'defers to monaco, which has no binding for this key',
        ).toBe(WORKBENCH_CONTRIB_WEIGHT)
      })
    }

    // An alternative key is only ours to take while monaco holds no *primary* on
    // it. A monaco bump that adds one would silently shadow the core command
    // again, which is exactly the class of bug this whole change is about.
    const bindings = await registry(page)
    for (const [key, command] of compat) {
      await test.step(`${key} carries no other monaco default`, async () => {
        const rivals = bindings
          .filter((kb) => kb.key === key && kb.weight === MONACO_DEFAULT_WEIGHT)
          .filter((kb) => kb.command !== command)
          .map((kb) => kb.command)
        expect(
          rivals,
          `${key} is now monaco's own default for ${rivals.join(', ')} — the alternative key ` +
            'for ' +
            command +
            ' shadows it',
        ).toEqual([])
      })
    }

    await test.step('Ctrl+Shift+↓ moves the line down', async () => {
      await setText(page, JSON_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
      await page.keyboard.press('Control+Shift+ArrowDown')
      await expect.poll(() => text(page)).toContain('  "beta": 2,\n  "name": "alpha",')
    })

    await test.step('Ctrl+Shift+↑ moves the line up', async () => {
      await setText(page, JSON_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(3, 1))
      await page.keyboard.press('Control+Shift+ArrowUp')
      await expect.poll(() => text(page)).toContain('  "beta": 2,\n  "name": "alpha",')
    })

    await test.step('Ctrl+Shift+Alt+F folds', async () => {
      await setText(page, JSON_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      const before = (await visibleLineCount(page)) ?? 0
      await page.keyboard.press('Control+Shift+Alt+f')
      // Folding is view state, so the buffer stays put either way — the visible
      // line count is what drops. Without this the step would pass on a key that
      // does nothing at all.
      await expect
        .poll(visibleLineCount.bind(null, page), {
          message: `folding hid nothing — all ${before} lines are still visible`,
        })
        .toBeLessThan(before)
      expect(await text(page)).toBe(JSON_BODY)
    })

    await test.step('Shift+Alt+PageDown scrolls a page', async () => {
      await setText(page, TALL_JSON_BODY)
      const before = (await firstVisibleLine(page)) ?? 1
      await page.keyboard.press('Shift+Alt+PageDown')
      await expect
        .poll(firstVisibleLine.bind(null, page), {
          message: `the page-scroll left the first visible line at ${before}`,
        })
        .toBeGreaterThan(before)
      expect(await text(page)).toBe(TALL_JSON_BODY)
    })

    if (IS_LINUX) {
      await test.step('Ctrl+Shift+D copies the line down', async () => {
        await setText(page, JSON_BODY)
        await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(2, 1))
        await page.keyboard.press('Control+Shift+d')
        await expect.poll(() => text(page)).toContain('  "name": "alpha",\n  "name": "alpha",')
      })

      await test.step('Ctrl+Shift+Alt+D copies the line up', async () => {
        await setText(page, JSON_BODY)
        await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(3, 1))
        await page.keyboard.press('Control+Shift+Alt+d')
        await expect.poll(() => text(page)).toContain('  "beta": 2,\n  "beta": 2,')
      })

      await test.step('Shift+Alt+F formats the document', async () => {
        await setText(page, FLAT_JSON_BODY)
        await page.keyboard.press('Shift+Alt+f')
        // Only the json formatter produces this indentation, so the assertion
        // tells a real formatting run from a key that merely did nothing.
        await expect.poll(() => text(page)).toContain('\n  "name": "alpha",\n')
      })
    }
  })

  test('the added keys reach the core commands monaco ships keyless', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await openJsonEditor(page, workbench)

    for (const [, command] of ADDED_KEYS) {
      await test.step(`${command} exists`, async () => {
        await expect
          .poll(() => page.evaluate((c) => window.__E2E__!.hasCommand(c), command), {
            message:
              `${command} is not registered — the added key would swallow the ` +
              'keystroke with nothing to run',
          })
          .toBe(true)
      })
    }

    for (const [key, command] of ADDED_KEYS) {
      await test.step(`${key} → ${command}`, async () => {
        const trace = await page.evaluate((k) => window.__E2E__!.traceKeybinding(k), key)
        expect(trace.command, `${key} does not reach ${command}`).toBe(command)
        expect(
          trace.weight,
          `${key} sits at weight ${trace.weight}; at ${MONACO_DEFAULT_WEIGHT} the dispatcher ` +
            'defers to monaco, which ships no key for the sort actions',
        ).toBe(WORKBENCH_CONTRIB_WEIGHT)
      })
    }

    // Same hazard the compat keys are guarded against: a monaco bump that gives
    // F9 a *mirrored* primary would make the added key shadow it. (Defaults monaco
    // registers through its own action2 path never enter this registry.)
    const bindings = await registry(page)
    for (const [key, command] of ADDED_KEYS) {
      await test.step(`${key} carries no other mirrored monaco default`, async () => {
        const rivals = bindings
          .filter((kb) => kb.key === key && kb.weight === MONACO_DEFAULT_WEIGHT)
          .filter((kb) => kb.command !== command)
          .map((kb) => kb.command)
        expect(
          rivals,
          `${key} is now monaco's own default for ${rivals.join(', ')} — the added key for ` +
            `${command} shadows it`,
        ).toEqual([])
      })
    }

    // The context menu is the one entry point a key press cannot cover: an entry
    // whose command id is wrong still renders and then does nothing when picked,
    // so pin the ids the menu resolves to *and* that they are registered.
    await test.step('the editor menu offers the sort pair, wired to registered commands', async () => {
      const commands = await page.evaluate(() =>
        window.__E2E__!.getEditorContextMenuCommands({
          editorHasSelection: true,
          editorReadonly: false,
        }),
      )
      for (const [key, command] of ADDED_KEYS) {
        expect(commands, `${key} is not offered by the editor context menu`).toContain(command)
        await expect
          .poll(() => page.evaluate((c) => window.__E2E__!.hasCommand(c), command), {
            message: `${command} is not registered — the menu entry would do nothing when picked`,
          })
          .toBe(true)
      }
    })

    await test.step('F9 sorts the selected lines, leaving the unselected one alone', async () => {
      await setText(page, SORT_BODY)
      // endColumn 1 means the selection stops at the end of line 3, so line 4
      // must not move — that is the assertion, not just "the buffer changed".
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorSelection(1, 1, 4, 1)))
        .toBe(true)
      await page.keyboard.press('F9')
      await expect.poll(() => text(page)).toBe('aaaa\ncccc\ndddd\nbbbb\n')
    })

    await test.step('Shift+F9 sorts them descending', async () => {
      await setText(page, SORT_BODY)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.setActiveEditorSelection(1, 1, 4, 1)))
        .toBe(true)
      await page.keyboard.press('Shift+F9')
      await expect.poll(() => text(page)).toBe('dddd\ncccc\naaaa\nbbbb\n')
    })

    await test.step('with nothing selected F9 sorts the whole file (monaco semantics)', async () => {
      await setText(page, SORT_BODY)
      await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(1, 1))
      await page.keyboard.press('F9')
      // Line 4 moves here and did not in the selection step above: the two
      // expectations cannot both pass on one shape of "sorted".
      await expect.poll(() => text(page)).toBe('aaaa\nbbbb\ncccc\ndddd\n')
    })
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
      const before = (await visibleLineCount(page)) ?? 0
      await page.keyboard.press('Control+k')
      await page.keyboard.press('Control+0')
      // The visible line count is the DOM-free way to see folding; a stolen chord
      // would type into the buffer instead, so pin both.
      await expect
        .poll(visibleLineCount.bind(null, page), { message: 'fold-all hid nothing' })
        .toBeLessThan(before)
      expect(await text(page)).toBe(JSON_BODY)
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
