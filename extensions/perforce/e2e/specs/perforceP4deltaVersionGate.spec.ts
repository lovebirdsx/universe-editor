/*---------------------------------------------------------------------------------------------
 *  The engine admission gate: an outdated or unreadable p4delta must not run
 *  (@p1, @regression).
 *
 *  The gate samples `--version` before the engine is handed to any client. Two
 *  failure shapes are pinned here, and each must produce the same three facts:
 *    - the only δ spawn is the gate's own `--version` — no business argv;
 *    - the workspace still answers: the drift scan ran natively (the native argv
 *      log records what the EXTENSION handed p4, and δ's delegated children are
 *      stripped from it);
 *    - the Perforce output channel explains why δ was refused.
 *
 *  The fake's `UNIVERSE_P4DELTA_FAKE_VERSION` knob provides both shapes: `0.1.6`
 *  is a parseable banner below the floor, `not-a-version` is output the strict
 *  parser must treat as no answer (fail-closed) rather than as satisfaction.
 *  The warning toast is left to `extensionP4delta.test.ts`; activation-time
 *  notification timing is not what this file exists to prove.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { evaluateWhenRestored, mkTempDir } from '@universe-editor/e2e-harness'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import { readArgvLog, test, expect } from '../fixtures/perforceApp.js'
import type { PerforceHarness, SeedFile } from '../fixtures/perforceApp.js'

const drifted: SeedFile = { relPath: 'drifted.txt', content: 'have revision\n' }
/** Drift only: differs from the have revision, never `p4 edit`-ed. */
const DRIFTED_CONTENT = 'edited on disk\n'

const oldDeltaLog = join(mkTempDir('ue2-p4delta-gate-argv-'), 'p4delta.log')
const oldP4Log = join(mkTempDir('ue2-p4delta-gate-p4-'), 'p4.log')
const unreadableDeltaLog = join(mkTempDir('ue2-p4delta-gate-argv-'), 'p4delta.log')
const unreadableP4Log = join(mkTempDir('ue2-p4delta-gate-p4-'), 'p4.log')

const isVersionProbe = (line: string): boolean => /(^| )--version( |$)/.test(line)
const versionProbeLines = (log: string): string[] => readArgvLog(log).filter(isVersionProbe)
const businessLines = (log: string): string[] => readArgvLog(log).filter((l) => !isVersionProbe(l))
const nativeScanLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => l.includes('reconcile') && /(^| )-n( |$)/.test(l))

async function openWithDrift(
  page: Page,
  workbench: WorkbenchPO,
  perforce: PerforceHarness,
): Promise<void> {
  await evaluateWhenRestored(page)
  writeFileSync(perforce.file(drifted.relPath), DRIFTED_CONTENT, 'utf8')
  await workbench.openWorkspace(perforce.openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
}

/** The gate sampled the engine, refused it, and the native path kept working. */
async function expectRefusedNatively(
  deltaLog: string,
  p4Log: string,
  page: Page,
  reason: string,
): Promise<void> {
  await expect
    .poll(() => versionProbeLines(deltaLog).length, {
      timeout: 60_000,
      message: 'the gate should have sampled the engine with --version',
    })
    .toBeGreaterThan(0)
  expect(businessLines(deltaLog)).toEqual([])

  await expect
    .poll(() => nativeScanLines(p4Log).length, {
      timeout: 60_000,
      message: 'the refused engine must fall back to a native scan',
    })
    .toBeGreaterThan(0)

  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getOutputChannelContent('Perforce')), {
      timeout: 30_000,
      message: 'the Perforce channel should explain the refusal',
    })
    .toContain(reason)
}

test.describe('@p1 perforce p4delta version gate — outdated engine', () => {
  test.use({
    p4Seeds: { files: [drifted] },
    p4delta: { version: '0.1.6' },
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: oldDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: oldP4Log,
    },
  })

  test('refuses a build below the floor and scans natively @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await openWithDrift(page, workbench, perforce)
    await expectRefusedNatively(oldDeltaLog, oldP4Log, page, 'older than the required 0.1.21')
  })
})

test.describe('@p1 perforce p4delta version gate — unreadable banner', () => {
  test.use({
    p4Seeds: { files: [drifted] },
    p4delta: { version: 'not-a-version' },
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: unreadableDeltaLog,
      UNIVERSE_P4_FAKE_ARGV_LOG: unreadableP4Log,
    },
  })

  test('treats a build that cannot report a version as refused, fail-closed @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await openWithDrift(page, workbench, perforce)
    await expectRefusedNatively(
      unreadableDeltaLog,
      unreadableP4Log,
      page,
      'did not report a supported version (>= 0.1.21)',
    )
  })
})
