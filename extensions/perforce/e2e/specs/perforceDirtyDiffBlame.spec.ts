/*---------------------------------------------------------------------------------------------
 *  Perforce editor visualizations smoke test (@p1) — the provider-neutral
 *  editor features (dirty-diff gutter, shift+alt+y open-changes, inline diff
 *  peek, inline blame, inline merge-conflict actions) must work against a
 *  Perforce workspace through the same renderer code that serves git.
 *
 *  Data flow under test: the renderer resolves the file's owning provider
 *  (`resolveScmProviderId`) and calls `<providerId>.getHeadContent /
 *  .getBlame` — here those route to the fake p4's have-revision and
 *  annotate/describe output, so every assertion proves the p4 provider
 *  (not git) fed the feature.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { test, expect } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const tracked: SeedFile = { relPath: 'tracked.txt', content: 'line one\nline two\nline three\n' }
const conflict: SeedFile = {
  relPath: 'conflict.txt',
  content: [
    'before',
    '>>>> ORIGINAL VERSION //depot/conflict.txt#2',
    'base line',
    '==== THEIRS //depot/conflict.txt#3',
    'their line',
    '==== YOURS conflict.txt',
    'your line',
    '<<<<',
    'after',
    '',
  ].join('\n'),
}
const annotate = {
  changelist: '42',
  user: 'alice',
  // Unix seconds as a string, matching `p4 -ztag changes` output.
  time: '1748000000',
  description: 'seed the tracked file',
}

test.use({
  p4Seeds: { files: [tracked, conflict], annotate },
})

test.describe('@p1 perforce editor visualizations', () => {
  test('gutter/open-changes/peek/blame/conflict-actions all run against the p4 provider @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    // Cold boot + host relaunch on workspace open + annotate/describe round-trips.
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)

    const editedContent = 'line one\nEDITED line two\nline three\n'

    await test.step('dirty-diff gutter renders after a disk edit (p4 getHeadContent)', async () => {
      // Edit on disk out-of-band; the workspace watcher refreshes and the
      // DirtyDiffContribution recomputes regions against the have-revision
      // baseline served by `perforce.getHeadContent`.
      writeFileSync(perforce.file(tracked.relPath), editedContent, 'utf8')
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
        perforce.file(tracked.relPath),
      )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()), {
          timeout: 30_000,
          message: 'edited file should be open in the active editor',
        })
        .toBe(editedContent)
      await expect
        .poll(
          () => page.evaluate(() => window.__E2E__!.getContextKey('quickDiffDecorationCount')),
          { timeout: 30_000, message: 'dirty-diff gutter decorations should appear' },
        )
        .toBeGreaterThan(0)
    })

    await test.step('shift+alt+y opens the file changes in a diff editor', async () => {
      await workbench.focusActiveEditorGroup()
      await page.keyboard.press('Shift+Alt+Y')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 30_000,
          message: 'Open Changes should switch the active editor to a diff',
        })
        .toBe('diff')
      // Left = have revision (the seeded content via perforce.getHeadContent),
      // right = the working-tree edit.
      const diff = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
      expect(diff?.original).toBe(tracked.content)
      expect(diff?.modified).toBe(editedContent)
      await workbench.runCommand('workbench.action.closeActiveEditor')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 30_000,
        })
        .not.toBe('diff')
    })

    await test.step('inline dirty-diff peek opens at the change and closes on Escape', async () => {
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.openDirtyDiffPeekAtLine(2)), {
          timeout: 30_000,
          message: 'dirty-diff peek should open at the edited line',
        })
        .toBe(true)
      expect(await page.evaluate(() => window.__E2E__!.isDirtyDiffPeekVisible())).toBe(true)
      await page.keyboard.press('Escape')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.isDirtyDiffPeekVisible()), {
          timeout: 10_000,
          message: 'Escape should close the dirty-diff peek',
        })
        .toBe(false)
    })

    await test.step('inline blame feeds the status bar from p4 annotate and opens the commit changes', async () => {
      // The seed's annotate metadata tags every line with changelist 42 by
      // alice, so the cursor line resolves to a committed blame entry whose
      // status-bar text mentions the author.
      await expect
        .poll(
          async () => {
            const entries = await workbench.statusBar.entriesFromProbe()
            return entries.some((e) => e.text.includes(annotate.user))
          },
          { timeout: 30_000, message: 'status bar should show the p4 blame entry' },
        )
        .toBe(true)

      // Clicking the blame entry routes through `scm.blame.openCommitChanges` →
      // `perforce.viewCommit` → the sidebar Commit Changes view.
      const blameButton = page.locator('[data-testid="part-statusbar"] button', {
        hasText: annotate.user,
      })
      await expect(blameButton).toBeVisible({ timeout: 10_000 })
      await blameButton.click()
      const view = page.locator('[data-testid="commitChanges-view"]')
      await expect(view).toBeVisible({ timeout: 30_000 })
      // The seeded annotate cl carries no file set (`describe -s` of it reports
      // only metadata), so the view shows its header with no file rows.
      await expect(view.locator('[data-testid="commitChanges-title"]')).toContainText(
        `Changelist ${annotate.changelist}`,
      )
      await expect(view.locator('[data-row-key^="file:"]')).toHaveCount(0)
    })

    await test.step('p4 conflict markers get inline Accept actions', async () => {
      await page.evaluate(
        (p) => window.__E2E__!.openFileUri(p, { pinned: true }),
        perforce.file(conflict.relPath),
      )
      const actions = page.locator('.merge-conflict-actions')
      await expect(actions).toBeVisible({ timeout: 30_000 })

      await actions
        .locator('.merge-conflict-action', { hasText: 'Accept Incoming Change' })
        .first()
        .click()
      // Accept Incoming keeps the THEIRS side (and drops all markers) — for a
      // p4 conflict that is the depot-side block.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorText()), {
          timeout: 10_000,
          message: 'Accept Incoming should replace the conflict block with THEIRS',
        })
        .toBe('before\ntheir line\nafter\n')
    })
  })
})
