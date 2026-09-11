/*---------------------------------------------------------------------------------------------
 *  Explorer multi-select "Get" fan-out for Perforce (@p1).
 *
 *  Both gets fan out over the Explorer's Ctrl-selection (the selection
 *  materializes as the command's second argument): "Get Latest Revision"
 *  (`perforce.syncLatest`) and "Get Revision…" (`perforce.sync`) run one
 *  filespec per selected element. `beta.txt` is the regression point — it is
 *  selected but never right-clicked, so only a selection-aware handler reaches
 *  it. Both files start at #1 with head #2, so the latest get really moves
 *  them; the second journey re-runs through the quick pick (first item =
 *  Latest revision) over the same selection and lands the "already at the
 *  latest" report instead of acting on just the clicked row.
 *
 *  A second block below covers the same picker's force rows with a `refused`
 *  seed, where the bytes on disk are what distinguish a real `-f` from a no-op.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands, readHaveRev } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const seeds: readonly SeedFile[] = [
  { relPath: 'alpha.txt', content: 'alpha v1\n', headRev: 2, headContent: 'alpha v2\n' },
  { relPath: 'beta.txt', content: 'beta v1\n', headRev: 2, headContent: 'beta v2\n' },
]

test.describe('@p1 explorer perforce get multi-select', () => {
  test.use({ p4Seeds: { files: seeds } })

  test(
    'get latest and get revision act on the whole ctrl-selection @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)
      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await waitForPerforceCommands(workbench)
      // A toggle: it would HIDE the Explorer when the side bar already has focus.
      await workbench.showExplorer()

      const rowOf = (seed: SeedFile) => page.locator('[role="treeitem"]', { hasText: seed.relPath })
      for (const seed of seeds) {
        await expect(rowOf(seed)).toBeVisible({ timeout: 60_000 })
      }

      /** Ctrl-select every seed row, then open the context menu on `seeds[1]`. */
      const selectAllAndMenu = async () => {
        for (const seed of seeds) {
          await rowOf(seed).click({ modifiers: ['Control'] })
        }
        await rowOf(seeds[1]!).click({ button: 'right' })
        const menu = page.getByRole('menu').first()
        await expect(menu).toBeVisible({ timeout: 10_000 })
        return menu
      }

      await test.step('Get Latest Revision pulls every selected file to head', async () => {
        const menu = await selectAllAndMenu()
        await menu.getByText('Get Latest Revision', { exact: true }).click()

        // beta is the regression point: selected but never right-clicked.
        for (const seed of seeds) {
          await expect
            .poll(() => readFileSync(perforce.file(seed.relPath), 'utf8'), {
              timeout: 30_000,
              message: `${seed.relPath} should land on its head revision`,
            })
            .toBe(seed.headContent)
        }
      })

      await test.step('Get Revision… quick pick runs the same selection (already at the latest)', async () => {
        // A plain click first: the tree kept the old selection, and Ctrl-click
        // toggles — this rebuilds a clean two-row selection.
        await rowOf(seeds[0]!).click()
        const menu = await selectAllAndMenu()
        const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
        await expect(submenuRow).toBeVisible({ timeout: 10_000 })
        await submenuRow.hover()
        const panel = page.getByTestId('context-menu-submenu')
        await expect(panel).toBeVisible({ timeout: 10_000 })
        await panel.getByText('Get Revision…', { exact: true }).click()

        const quickInput = page.getByTestId('quick-input')
        await expect(quickInput).toBeVisible({ timeout: 30_000 })
        await expect(quickInput.getByText('Latest revision', { exact: true })).toBeVisible()
        await page.keyboard.press('Enter')
        await workbench.quickInput.waitForHidden()

        // The selection-scoped run reports up-to-date instead of touching just
        // the clicked row — and both files stay intact at head.
        await expect(
          page
            .locator('[data-testid="notification-toast-item"]')
            .filter({ hasText: 'Already at the latest revision' }),
        ).toBeVisible({ timeout: 30_000 })
        for (const seed of seeds) {
          expect(readFileSync(perforce.file(seed.relPath), 'utf8')).toBe(seed.headContent)
        }
      })
    },
  )
})

/*---------------------------------------------------------------------------------------------
 *  The picker's force rows. `refused` is the crux — the fake skips that file on
 *  a plain get (an `allwrite noclobber` client keeps the local copy and the have
 *  revision), so the bytes on disk plus the landed revision prove two things a
 *  forward get never could: that `-f` really reached p4, and that the run used
 *  the spec the user picked (`@4521`, `#3`) rather than `#head`, which would
 *  leave a different revision behind. Three steps over one cold launch — the
 *  picker reached through the Explorer menu (the selection-scoped branch), the
 *  command invoked with a bare resource (the single-file branch), and one
 *  confirmation dismissed with Escape — the first two parking on the one
 *  confirmation that names the target and the scope, the last proving that
 *  refusing it runs nothing at all.
 *--------------------------------------------------------------------------------------------*/

const V1 = 'forced v1\n'
const V2 = 'forced v2\n'
const V3 = 'forced v3\n'

const FORCED: SeedFile = {
  relPath: 'forced.txt',
  content: V1,
  headRev: 3,
  headContent: V3,
  revisions: { '1': V1, '2': V2, '3': V3 },
  refused: true,
}

const FORCED_SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    // Unix seconds as a string, matching `p4 -ztag changes` output.
    time: '1751600000',
    description: 'forced.txt to v2',
    rev: 2,
    files: [{ relPath: 'forced.txt', action: 'edit', rev: 2 }],
  },
]

test.describe('@p1 explorer perforce force get', () => {
  test.use({ p4Seeds: { files: [FORCED], submitted: FORCED_SUBMITTED } })

  /** The confirmation, matched on its button: the picker carries `role=dialog`
   *  too, and the picker rows are gone by the time it is up. */
  const forceDialog = (page: Page) =>
    page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: 'Force Get', exact: true }),
    })

  test(
    'force rows take a picked changelist / revision and only then overwrite @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce, p4Workspace }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)
      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await waitForPerforceCommands(workbench)
      await workbench.showExplorer()

      const row = page.locator('[role="treeitem"]', { hasText: FORCED.relPath })
      await expect(row).toBeVisible({ timeout: 60_000 })

      /** The client's effective have revision. The fake stores `haveRev` only
       *  while it differs from head — a client at head is the plain file shape
       *  with no `haveRev` key at all — so an absent key means head. */
      const haveOf = (): number | undefined =>
        readHaveRev(p4Workspace.stateFile, FORCED.relPath) ?? FORCED.headRev

      /** Answer the value prompt that follows a picked row. The input box and
       *  the pick share one `quick-input` testid, so the placeholder (which only
       *  the input box has) is what says the pick already closed. */
      const answerPrompt = async (placeHolder: string, value: string): Promise<void> => {
        const box = page.getByPlaceholder(placeHolder, { exact: true })
        await expect(box).toBeVisible({ timeout: 30_000 })
        await box.fill(value)
        await box.press('Enter')
      }

      await test.step('the force changelist row runs `@4521 -f` once confirmed', async () => {
        await row.click({ button: 'right' })
        const menu = page.getByRole('menu').first()
        await expect(menu).toBeVisible({ timeout: 10_000 })
        const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
        await expect(submenuRow).toBeVisible({ timeout: 10_000 })
        await submenuRow.hover()
        const panel = page.getByTestId('context-menu-submenu')
        await expect(panel).toBeVisible({ timeout: 10_000 })
        await panel.getByText('Get Revision…', { exact: true }).click()

        const quickInput = page.getByTestId('quick-input')
        await expect(
          quickInput.getByText('Force-get: as of a changelist…', { exact: true }),
        ).toBeVisible({ timeout: 30_000 })
        // The forced rows are additions, not a replacement: the plain rows the
        // menu has always offered are still there, unprefixed.
        await expect(quickInput.getByText('As of a changelist…', { exact: true })).toBeVisible()
        await quickInput.getByText('Force-get: as of a changelist…', { exact: true }).click()
        await answerPrompt('12345', '4521')

        const dialog = forceDialog(page)
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        // The two facts the dialog exists to deliver: where the get travels to,
        // and how wide it is.
        await expect(dialog).toContainText('@4521')
        await expect(dialog).toContainText(FORCED.relPath)
        await expect(dialog).toContainText('cannot be undone')
        // Nothing has been written while the confirmation is still up.
        expect(readFileSync(perforce.file(FORCED.relPath), 'utf8')).toBe(V1)

        await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

        // #2 is neither the draft (V1) nor head (V3): landing on it takes both
        // the `-f` (the refusal would have kept V1) and the picked spec.
        await expect
          .poll(() => readFileSync(perforce.file(FORCED.relPath), 'utf8'), {
            timeout: 30_000,
            message: 'the forced get should overwrite the refused file with revision #2',
          })
          .toBe(V2)
        await expect
          .poll(() => readHaveRev(p4Workspace.stateFile, FORCED.relPath), {
            timeout: 30_000,
            message: 'a force get over a refused file advances the have revision',
          })
          .toBe(2)
      })

      await test.step('the force revision row runs `#3 -f` without a selection', async () => {
        // No selection this time: the command is invoked with just a resource,
        // which is the single-file branch (the other place a force confirms).
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.sync', { resourceUri: p }),
            perforce.file(FORCED.relPath),
          )
          .catch(() => {})

        const quickInput = page.getByTestId('quick-input')
        await expect(
          quickInput.getByText('Force-get: a specific revision…', { exact: true }),
        ).toBeVisible({ timeout: 30_000 })
        await quickInput.getByText('Force-get: a specific revision…', { exact: true }).click()
        await answerPrompt('4', '3')

        const dialog = forceDialog(page)
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        // A revision spec, not a changelist — named as the user typed it.
        await expect(dialog).toContainText('#3')
        await expect(dialog).toContainText(FORCED.relPath)
        expect(readFileSync(perforce.file(FORCED.relPath), 'utf8')).toBe(V2)

        await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

        await expect
          .poll(() => readFileSync(perforce.file(FORCED.relPath), 'utf8'), {
            timeout: 30_000,
            message: 'the forced get should land revision #3',
          })
          .toBe(V3)
        await expect
          .poll(haveOf, {
            timeout: 30_000,
            message: 'the client should be at head after the forced get to #3',
          })
          .toBe(3)
      })

      await test.step('dismissing the confirmation leaves the workspace untouched', async () => {
        // The only force row whose target differs from where the file sits: the
        // file is at head (#3) now, so a run that slipped through the cancel
        // would land #2 and move the have revision with it. Refusing to
        // confirm must leave both alone — "the dialog closed" is not enough,
        // since a cancel that fell through to the run would close it too.
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.sync', { resourceUri: p }),
            perforce.file(FORCED.relPath),
          )
          .catch(() => {})

        const quickInput = page.getByTestId('quick-input')
        await expect(
          quickInput.getByText('Force-get: as of a changelist…', { exact: true }),
        ).toBeVisible({ timeout: 30_000 })
        await quickInput.getByText('Force-get: as of a changelist…', { exact: true }).click()
        await answerPrompt('12345', '4521')

        const dialog = forceDialog(page)
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('@4521')
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden({ timeout: 10_000 })
        // Bounded window so a run that started anyway has time to land its
        // write; costs nothing while the cancel holds.
        await page.waitForTimeout(3_000)

        expect(readFileSync(perforce.file(FORCED.relPath), 'utf8')).toBe(V3)
        expect(haveOf()).toBe(3)
      })
    },
  )
})
