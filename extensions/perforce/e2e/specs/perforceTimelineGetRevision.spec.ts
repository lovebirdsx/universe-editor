/*---------------------------------------------------------------------------------------------
 *  Perforce Timeline "Get This Revision" (@p1), command-driven.
 *
 *  Driving the Timeline view's UI is out of scope here — the item payload is
 *  what the command consumes, so the spec feeds the exact TimelineItem shape the
 *  view hands the context-menu command (`{ command: { arguments: [{ uri,
 *  depotFile, rev }] } }`, same source openInGraph-adjacent commands read) and
 *  asserts the sync lands. A single-file `#rev` get is the most casual sync
 *  there is, so no dialog may park it. The seed makes the sync FORWARD: the
 *  client has #1 and `#2` is a real middle revision of the three-rev history.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import {
  test,
  expect,
  waitForPerforceCommands,
  readHaveRev,
  DEPOT_PREFIX,
} from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

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

test.describe('@p1 perforce timeline get this revision', () => {
  test.use({ p4Seeds: { files: [aTxt] } })

  test('perforce.timeline.getThisRevision syncs the file to the row revision @regression', async ({
    page,
    workbench,
    perforce,
    p4Workspace,
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
    await waitForPerforceCommands(workbench)

    await workbench.runCommand('perforce.timeline.getThisRevision', {
      command: {
        arguments: [
          {
            uri: perforce.file('src/a.txt'),
            depotFile: `${DEPOT_PREFIX}/src/a.txt`,
            rev: 2,
          },
        ],
      },
    })

    await expect
      .poll(() => readFileSync(perforce.file('src/a.txt'), 'utf8'), {
        timeout: 30_000,
        message: 'the timeline get must write revision #2 without waiting on a confirmation',
      })
      .toBe(V2)
    await expect
      .poll(() => readHaveRev(p4Workspace.stateFile, 'src/a.txt'), {
        timeout: 30_000,
        message: 'the fake depot should report haveRev 2 for the file',
      })
      .toBe(2)
  })
})
