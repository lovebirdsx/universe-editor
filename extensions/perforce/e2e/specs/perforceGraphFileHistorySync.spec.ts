/*---------------------------------------------------------------------------------------------
 *  Perforce Graph file-history "Get Revision" (@p1).
 *
 *  A single-file scoped graph lists only the changes that touched the file, and
 *  each row offers "Get This Revision" and "Get Latest Revision". The seed makes
 *  every sync FORWARD: the client has #1, changelist 4521 produced #2, 4522
 *  (head) produced #3. Two steps in one cold launch (each sync moves forward):
 *
 *  1. "Get This Revision" on the non-head row rolls the single file back to #2
 *     with NO confirmation — a one-file #rev sync is the most casual get there
 *     is, and a parked dialog would time the disk poll out.
 *  2. "Get Latest Revision" brings the same file forward to #3.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands, readHaveRev } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const V1 = 'v1\n'
const V2 = 'v2\n'
const V3 = 'v3\n'

const aTxt: SeedFile = {
  relPath: 'src/a.txt',
  content: V1,
  headRev: 3,
  headContent: V3,
  revisions: { '1': V1, '2': V2, '3': V3 },
}

const SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    // Unix seconds as a string, matching `p4 -ztag changes` output.
    time: '1751600000',
    description: 'a.txt to v2',
    rev: 2,
    files: [{ relPath: 'src/a.txt', action: 'edit', rev: 2 }],
  },
  {
    changelist: '4522',
    user: 'e2e',
    time: '1751600100',
    description: 'a.txt to v3',
    rev: 3,
    files: [{ relPath: 'src/a.txt', action: 'edit', rev: 3 }],
  },
]

test.describe('@p1 perforce graph file history get revision', () => {
  test.use({ p4Seeds: { files: [aTxt], submitted: SUBMITTED } })

  test('file history rows get this revision without a confirm, and get latest @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
  }) => {
    // Cold boot + host relaunch on workspace open + the scoped changes query.
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

    await workbench.runCommand('perforce-graph.viewFileHistory', {
      resource: perforce.fileUri('src/a.txt'),
      isDirectory: false,
    })
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    await expect(editor).toBeVisible()
    // The scoped `changes <file>` query lists only the two changes that touched it.
    await expect(editor.locator('[data-id="4522"]')).toBeVisible()
    await expect(editor.locator('[data-id="4521"]')).toBeVisible()

    const openRowMenu = async (id: string) => {
      await editor.locator(`[data-id="${id}"]`).click({ button: 'right' })
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible({ timeout: 10_000 })
      return menu
    }

    await test.step('Get This Revision lands the single file on #2 without asking', async () => {
      const menu = await openRowMenu('4521')
      await menu.getByText('Get This Revision', { exact: true }).click()

      await expect
        .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
          timeout: 30_000,
          message: 'the single-file get must write #2 without waiting on a confirmation',
        })
        .toBe(V2)
      await expect
        .poll(() => readHaveRev(p4Workspace.stateFile, 'src/a.txt'), {
          timeout: 30_000,
          message: 'the fake depot should report haveRev 2 for the file',
        })
        .toBe(2)
    })

    await test.step('Get Latest Revision brings the file forward to head', async () => {
      const menu = await openRowMenu('4521')
      await menu.getByText('Get Latest Revision', { exact: true }).click()

      await expect
        .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
          timeout: 30_000,
          message: 'the get-latest should write the head revision (#3) to disk',
        })
        .toBe(V3)
    })
  })
})
