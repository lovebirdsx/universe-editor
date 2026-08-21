/*---------------------------------------------------------------------------------------------
 *  Panel terminal restore regression (@regression).
 *
 *  Bug: with the panel visible AND the terminal view active at shutdown,
 *  relaunching the workspace spawned ONE EXTRA terminal alongside the restored
 *  ones. TerminalView's first-mount auto-spawn ran while
 *  TerminalManagerService.reconcileFromStorage() was still in flight (React
 *  mounts before the fire-and-forget reconcile settles, see main.tsx), saw an
 *  empty list, and spawned a profile terminal the restore then added to.
 *
 *  Setup mirrors smoke.layoutPersistence.spec.ts: pre-seed state.json +
 *  workspaces/<id>.json so the launch hits the restore path directly, with
 *  panel visible + terminal container active + one persisted terminal.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  INITIAL_STATE,
  launchElectron,
} from '@universe-editor/e2e-harness'
import { URI } from '@universe-editor/platform'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks } from '../pages/WorkbenchPO.js'

const RESTORED_NAME = 'e2e-restored-terminal'

// A shell that exists on every CI host. An explicit shell in the persisted
// entry skips profile detection on the restore path.
const RESTORED_SHELL = process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh'

// ViewContainerLocation.Panel === 2 (const enum in platform viewRegistry).
const PANEL_LOCATION = 2

const seededWorkspaceState = () => ({
  'workbench.layout': {
    visible: {
      activityBar: true,
      sideBar: true,
      secondarySideBar: false,
      editorArea: true,
      panel: true,
      statusBar: true,
    },
    sizes: { sidebar: 240, secondarySidebar: 300, panel: 200 },
  },
  'workbench.views': {
    activeContainerByLocation: { [PANEL_LOCATION]: 'workbench.view.terminal' },
  },
  'terminal.panelState': {
    schemaVersion: 3,
    groups: [{ terminals: [{ shell: RESTORED_SHELL, name: RESTORED_NAME }] }],
  },
})

function workspaceIdFromUri(uriString: string): string {
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

async function launchWithState(userDataDir: string) {
  writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      [ENABLED_EXTENSIONS_ENV]: '',
    },
  })
  // A failing readiness step must not leak the half-dead app (the test body's
  // own closeApp runs only after this helper returns).
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await page.evaluate(() => window.__E2E__!.whenReady())
    return { app, page }
  } catch (err) {
    await closeApp(app)
    throw err
  }
}

test.describe('@regression terminal restore', () => {
  test('restores exactly the persisted terminals when panel + terminal view were active', async () => {
    // Self-launched cold boot: leave room for the graceful-close + force-kill
    // teardown under full-suite parallel load (see smoke.viewSizes).
    test.setTimeout(120_000)
    test.slow()
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-term-restore-'))

    try {
      const workspaceDir = join(userDataDir, 'fixture-workspace')
      mkdirSync(workspaceDir, { recursive: true })

      const workspaceUri = URI.file(workspaceDir)
      const workspaceId = workspaceIdFromUri(workspaceUri.toString())
      const sessionState = {
        ...(JSON.parse(INITIAL_STATE) as Record<string, unknown>),
        'workbench.windowsState': [
          {
            workspace: { folder: workspaceUri.toJSON(), name: basename(workspaceDir) },
            uiState: null,
            devToolsOpen: false,
          },
        ],
      }

      writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(sessionState, null, 2))
      mkdirSync(join(userDataDir, 'workspaces'), { recursive: true })
      writeFileSync(
        join(userDataDir, 'workspaces', `${workspaceId}.json`),
        JSON.stringify(seededWorkspaceState(), null, 2),
      )

      const { app, page } = await launchWithState(userDataDir)
      try {
        // The persisted terminal must come back through the restore path.
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getPanelTerminalNames()), {
            timeout: 20_000,
          })
          .toContain(RESTORED_NAME)

        // ...and no extra terminal may appear. The buggy auto-spawn fired on the
        // view's first mount (before reconcile settled) but only LANDS after
        // profile detection + spawn, which can outlast the restore itself. Give
        // that window time to close, then take the final snapshot.
        await page.waitForTimeout(3_000)
        const names = await page.evaluate(() => window.__E2E__!.getPanelTerminalNames())
        expect(names).toEqual([RESTORED_NAME])

        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
