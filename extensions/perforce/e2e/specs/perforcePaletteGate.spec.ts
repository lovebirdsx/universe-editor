/*---------------------------------------------------------------------------------------------
 *  Perforce command-palette gate (@p1) — both halves of one switch.
 *
 *  `contributes.commands` puts every command into the palette by default, and
 *  perforce's `activate()` bails out of a folder with no usable p4 client BEFORE
 *  registering a single handler. So in a window that is not a Perforce workspace
 *  the palette used to offer all 43 gated perforce commands (four more are hidden
 *  everywhere — they need an argument), and running one bounced renderer → host →
 *  renderer and died on the host-invokable allowlist ("extension host may only
 *  execute _workbench.* commands") — an internal invariant reported as if it were
 *  the user's mistake.
 *
 *  Both halves are pinned here because either one alone is satisfiable by
 *  accident: hiding the commands AND rejecting an unregistered contributed
 *  command happen to also hold while the extension host is still starting, so a
 *  one-sided test passes vacuously (the suite's own cold-start window). The
 *  workspace half closes that hole — a gate that never opens would pass the
 *  hidden half just as well.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, toPosix, waitForPerforceActivation } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

const tracked: SeedFile = { relPath: 'tracked.txt', content: 'have tracked\n' }

test.use({ p4Seeds: { files: [tracked] } })

/** Typed into the palette after `openPalette`. 'p4delta' 命中这一族全部三条命令：自装副本
 *  `perforce.p4delta.install`（id 是它的关键词之一）与两条日志出口（标题里带 P4delta）。
 *  无工作区时三条一起消失，所以这个查询的行数就是「闸门的两半」。 */
const PALETTE_QUERY = 'p4delta'

async function openPalette(page: Page, workbench: WorkbenchPO): Promise<void> {
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.showCommands')
  })
  await workbench.quickInput.waitForVisible()
}

test.describe('@p1 perforce palette gate', () => {
  test('a Perforce workspace opens the gate for its palette commands @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    // Cold boot + host relaunch on workspace open.
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)
    await waitForPerforceActivation(workbench)

    // The key `activate()` paints once a client is in hand. Waiting for the
    // command burst above already implies it, but assert it directly: it is the
    // value the manifest's `when` reads, and a palette that stays shut here would
    // hide exactly the commands that can serve this window.
    await expect
      .poll(() => workbench.getContextKey<unknown>('perforceHasWorkspace'), { timeout: 30_000 })
      .toBe(true)

    await openPalette(page, workbench)
    await page.keyboard.type(PALETTE_QUERY)
    // 三条命令带这个词：自装副本一条 + 两条日志出口（实时频道 / 最近一份运行日志）。
    // 查询词命中的是标题与命令 id，所以这一数就是「这一族命令都过闸了」。
    const rows = workbench.quickInput.dialog.getByRole('option')
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: /p4delta/i })).toHaveCount(3)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('a window outside every Perforce workspace hides them and rejects one honestly @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    // A plain folder: the fake p4 answers `info` with the SEEDED client's root,
    // which does not contain this folder, and `p4 clients` offers no other
    // candidate — the "folder outside the workspace" case, not "p4 missing".
    const plainDir = toPosix(mkTempDir('universe-editor-e2e-p4-plain-'))
    await workbench.openWorkspace(plainDir)

    // The manifest must reach the renderer before anything below means what it
    // says: the contributed-command proxy (and with it the palette entry) is
    // created at translation time, and every assertion here would also hold
    // against an extension host that simply had not started yet.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('perforce.p4delta.install')), {
        timeout: 60_000,
        message: 'perforce contributions should be translated',
      })
      .toBe(true)

    await openPalette(page, workbench)
    // The palette itself must be alive before "no p4delta row" means anything:
    // an empty list would satisfy the count-0 assertion below for a reason that
    // has nothing to do with the gate.
    const rows = workbench.quickInput.dialog.getByRole('option')
    await expect(rows.first()).toBeVisible()
    await page.keyboard.type(PALETTE_QUERY)
    await expect(rows).toHaveCount(0)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // Executed anyway (a keybinding, another extension, a probe): the host owns no
    // handler, and that — not a host allowlist rule — is what the caller is told.
    await expect(workbench.runCommand('perforce.p4delta.install')).rejects.toThrow(
      /Contributed command 'perforce\.p4delta\.install' does not exist\./,
    )
  })
})
