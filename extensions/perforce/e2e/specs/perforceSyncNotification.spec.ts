/*---------------------------------------------------------------------------------------------
 *  Perforce get → desktop notification (@p1).
 *
 *  The chain this file exists to hold down spans three processes and cannot be
 *  proven from either end alone:
 *
 *    extension host (runSync's terminal branches)
 *      → `commands.executeCommand('_workbench.showSystemNotification', …)`
 *        → renderer whitelist (`_workbench.*`) → the Action2 → IHostService.notify
 *
 *  The desktop toast itself is unobservable in a headless run (it is raised
 *  main-side and gated on window blur + user presence), and an id that never got
 *  registered fails SILENTLY — `CommandService.executeCommand` answers an unknown
 *  id with a warn and `undefined`, not a rejection, so the caller's `.catch` sees
 *  nothing. Unit tests on both sides stub the other end of the bridge; only this
 *  spec can show the id, the whitelist and the registration actually line up.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

const HEAD = 'head revision two\n'
const behind: SeedFile = {
  relPath: 'behind.txt',
  content: 'have revision one\n',
  headRev: 2,
  headContent: HEAD,
}

/** Open the seeded workspace, wait for the provider + command registration. */
async function openSyncWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  await evaluateWhenRestored(page)
  await workbench.openWorkspace(openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
}

test.describe('@p1 perforce sync notification', () => {
  test.use({ p4Seeds: { files: [behind] } })

  test('a finished get reaches the desktop-notification bridge', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await openSyncWorkspace(page, workbench, perforce.openDir)

    await workbench.runCommand('perforce.syncLatest', {
      resourceUri: perforce.file(behind.relPath),
    })
    // The get really ran — otherwise a stale bridge entry from some earlier step
    // could satisfy the poll below.
    expect(readFileSync(perforce.file(behind.relPath), 'utf8')).toBe(HEAD)

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSystemNotifications()), {
        timeout: 30_000,
        message: 'the finished get should cross the desktop-notification bridge',
      })
      .toContainEqual({
        title: 'Get complete',
        // The same string the in-app toast shows: the notification reports the
        // get's own counts, not a second paraphrase of them.
        body: expect.stringContaining('Updated 1 file(s)'),
      })
  })
})
