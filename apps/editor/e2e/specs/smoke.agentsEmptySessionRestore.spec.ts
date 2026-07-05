/*---------------------------------------------------------------------------------------------
 *  Empty ACP session restore smoke test (@p1) — regression guard for bug2.
 *
 *  Repro: a session that was created but NEVER messaged (hasMessages=false) is
 *  persisted to history + restored as an editor tab. After a restart the agent
 *  no longer knows that session, so `session/load` (or even spawning the agent)
 *  fails. The OLD behaviour surfaced a "Failed to resume agent session" error
 *  inside the tab and left a ghost row in the session list. The FIX discards the
 *  empty session silently: the history row is dropped and the editor tab closes
 *  itself, with no error UI.
 *
 *  We seed the post-restart state directly (workspace state with an acp.session
 *  tab + the session-history bucket + the active-session pointer), mirroring
 *  smoke.editorRestore's seed-then-launch approach so we don't depend on a real
 *  agent or a fragile relaunch. The agent id is intentionally unknown so the
 *  resume reliably fails — exactly the cross-restart condition we care about.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, APP_ROOT, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks } from '../pages/WorkbenchPO.js'

const EMPTY_SESSION_ID = 'echo-empty-session-1'
const ACP_RESOURCE = `universe:/acp/session/${EMPTY_SESSION_ID}`

function fsPathToUriComponents(fsPath: string) {
  const forwardSlash = fsPath.replace(/\\/g, '/')
  const path = forwardSlash.startsWith('/') ? forwardSlash : '/' + forwardSlash
  return { scheme: 'file', authority: '', path, query: '', fragment: '' }
}

/** Stable workspace id — must mirror main/storage.ts:workspaceIdFromUri. */
function workspaceIdFromFolder(folderFsPath: string): string {
  const path = folderFsPath.replace(/\\/g, '/')
  const uriString = 'file://' + (path.startsWith('/') ? path : '/' + path)
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

/** A workspace grid with a single restored acp.session editor tab. */
function buildWorkspaceState() {
  return {
    grid: {
      root: {
        type: 'branch',
        size: 1,
        children: [
          {
            type: 'leaf',
            size: 1,
            data: {
              editors: [
                {
                  typeId: 'acp.session',
                  // AcpSessionEditorInput.serialize() returns a JSON string.
                  data: JSON.stringify({
                    sessionId: EMPTY_SESSION_ID,
                    agentId: 'echo',
                    title: 'Empty Session',
                  }),
                },
              ],
              activeIndex: 0,
            },
          },
        ],
      },
      orientation: 0,
      width: 800,
      height: 600,
    },
    activeGroupId: 0,
  }
}

/** Seed the workspace bucket: restored tab + empty-session history + active pointer. */
function seedWorkspaceFile(userDataDir: string, folder: string): void {
  const hash = workspaceIdFromFolder(folder)
  const wsDir = join(userDataDir, 'workspaces')
  mkdirSync(wsDir, { recursive: true })
  const now = Date.now()
  const payload = {
    'workbench.workspaceState': { groups: buildWorkspaceState() },
    'acp.sessionHistory': {
      schemaVersion: 1,
      entries: [
        {
          id: EMPTY_SESSION_ID,
          agentId: 'echo',
          sessionIdOnAgent: EMPTY_SESSION_ID,
          title: 'Empty Session',
          createdAt: now,
          lastUsedAt: now,
          hasMessages: false,
        },
      ],
    },
    'acp.activeSessionId': EMPTY_SESSION_ID,
  }
  writeFileSync(join(wsDir, `${hash}.json`), JSON.stringify(payload, null, 2))
}

/** Seed state.json so the app restores a single window into `folder`. */
function seedGlobalSession(userDataDir: string, folder: string): void {
  const folderComponents = fsPathToUriComponents(folder)
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  const payload = {
    'workbench.windowsState': [
      { workspace: { folder: folderComponents, name }, uiState: null, devToolsOpen: false },
    ],
    'workbench.recentWorkspaces': [{ folder: folderComponents, name, lastOpened: Date.now() }],
  }
  writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(payload, null, 2))
}

async function launchWithState(userDataDir: string) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: { ...inheritedEnv, UNIVERSE_E2E: '1', NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.evaluate(() => window.__E2E__!.whenRestored())
      break
    } catch (err) {
      if (attempt === 1 || !/Execution context was destroyed/.test(String(err))) throw err
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
    }
  }
  return { app, page }
}

test.describe('@p1 empty agent session restore', () => {
  test('discards an unresumable empty session silently — no error tab, no ghost row @regression', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-empty-acp-'))
    try {
      const workspaceFolder = mkdtempSync(join(tmpdir(), 'universe-editor-ws-'))

      seedGlobalSession(userDataDir, workspaceFolder)
      seedWorkspaceFile(userDataDir, workspaceFolder)

      const { app, page } = await launchWithState(userDataDir)
      try {
        // The restored acp.session tab auto-resumes, fails (agent gone), and the
        // empty session is discarded — the tab closes itself.
        await expect
          .poll(
            () =>
              page.evaluate(() => window.__E2E__!.getActiveGroupEditorUris() as readonly string[]),
            { timeout: 8000 },
          )
          .not.toContain(ACP_RESOURCE)

        // It must never surface a resume error in the editor body.
        expect(await page.locator('[data-testid="acp-session-resume-error"]').count()).toBe(0)
        await expectNoLeaks(page)
      } finally {
        await closeApp(app)
      }
      try {
        rmSync(workspaceFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    } finally {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* noop — temp dir cleanup is best-effort */
      }
    }
  })
})
