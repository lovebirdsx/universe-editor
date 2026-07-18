/*---------------------------------------------------------------------------------------------
 *  Playwright fixture for Swarm (P4 Code Review) specs. Cold-launches Electron
 *  wired to BOTH the fake p4 CLI (fixtures/fake-p4.mjs, for ticket + shelve) and a
 *  fake Swarm REST server (fixtures/fake-swarm.mjs), so the review layer can be
 *  exercised end-to-end with no reachable Helix Core or Swarm.
 *
 *  The fake Swarm server listens on an ephemeral port and writes its base URL to a
 *  portfile the fixture reads, then passes it to the app via `UNIVERSE_SWARM_BASE_URL`
 *  (swarmApi honours the override). Swarm is enabled through the seeded settings.
 *  Requests the extension issues are appended to a log file exposed on the `swarm`
 *  fixture so specs can assert the right calls were made.
 *--------------------------------------------------------------------------------------------*/

import { test as base, type ElectronApplication, type Page } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  WorkbenchPO,
  closeApp,
  expectNoLeaks,
  launchApp,
  resolveEditorBuild,
  waitForProbe,
} from '@universe-editor/e2e-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_P4 = resolve(__dirname, 'fake-p4.mjs')
const FAKE_SWARM = resolve(__dirname, 'fake-swarm.mjs')
const { appRoot: APP_ROOT, mainEntry: MAIN_ENTRY } = resolveEditorBuild()

// Swarm review lives in the Perforce extension; activate only it (P2 minimal set).
const PERFORCE_EXTENSIONS = ['@universe-editor/perforce'] as const

const toPosix = (p: string): string => p.split('\\').join('/')

export interface SwarmHarness {
  readonly clientRoot: string
  /** The fake Swarm server's base URL (for control-endpoint calls). */
  readonly baseUrl: string
  /** Read the recorded Swarm requests (method + path + body), newest last. */
  requests(): Array<{ method: string; path: string; query: string; body?: unknown }>
  /** Wait until a request matching the predicate has been recorded. */
  waitForRequest(
    match: (r: { method: string; path: string; query: string }) => boolean,
    timeoutMs?: number,
  ): Promise<void>
  /** Inject a brand-new review into the fake server (test-only control endpoint),
   *  so a subsequent dashboard poll surfaces it as newly needing the user's action. */
  addReview(opts: { id?: string; author?: string; description?: string }): Promise<void>
}

export type SwarmFixtures = {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
  swarm: SwarmHarness
}

async function waitForPortfile(portfile: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portfile)) {
      try {
        const { baseUrl } = JSON.parse(readFileSync(portfile, 'utf8')) as { baseUrl: string }
        if (baseUrl) return baseUrl
      } catch {
        /* not written fully yet */
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('fake-swarm did not report its port in time')
}

export const test = base.extend<SwarmFixtures>({
  electronApp: async ({}, use) => {
    // Temp dirs: user data, workspace, swarm portfile + request log.
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-swarm-'))
    const workspaceDir = mkdtempSync(join(tmpdir(), 'ue2-swarm-ws-'))
    const fakeDir = join(workspaceDir, '.swarmfake')
    mkdirSync(fakeDir, { recursive: true })
    const portfile = join(fakeDir, 'port.json')
    const logfile = join(fakeDir, 'requests.log')
    const stateFile = join(fakeDir, 'p4state.json')
    const baselineA =
      Array.from({ length: 120 }, (_, i) => `export const line${i + 1} = ${i + 1}`).join('\n') +
      '\n'
    const shelvedA =
      Array.from({ length: 120 }, (_, i) => {
        const line = i + 1
        return line === 60 || line === 100
          ? `export const line${line} = ${line} + 1`
          : `export const line${line} = ${line}`
      }).join('\n') + '\n'

    // A real spreadsheet (valid xlsx bytes made with SheetJS) so the Excel
    // extension actually parses + diffs it. A text-diff path would utf8-corrupt the
    // zip bytes and show nothing; the review must route it through the webview diff
    // over raw base64 bytes. Deep path mirrors the real depot layout of the bug.
    const xlsxDepot = '//depot/AkiBase/Source/Config/z.battle/b.Buff/b.Buff_LevelNew.xlsx'
    const xlsxRel = 'AkiBase/Source/Config/z.battle/b.Buff/b.Buff_LevelNew.xlsx'
    const xlsxBase = readFileSync(resolve(__dirname, 'assets', 'buff-base.xlsx'))
    const xlsxShelf = readFileSync(resolve(__dirname, 'assets', 'buff-shelf.xlsx'))

    // Seed a minimal p4 depot so discovery succeeds + shelve has something.
    mkdirSync(join(workspaceDir, 'src', 'editor'), { recursive: true })
    mkdirSync(join(workspaceDir, 'src', 'runtime'), { recursive: true })
    mkdirSync(join(workspaceDir, 'AkiBase', 'Source', 'Config', 'z.battle', 'b.Buff'), {
      recursive: true,
    })
    writeFileSync(join(workspaceDir, 'hello.txt'), 'hello\n', 'utf8')
    writeFileSync(join(workspaceDir, 'src', 'editor', 'a.ts'), baselineA, 'utf8')
    writeFileSync(join(workspaceDir, 'src', 'runtime', 'b.ts'), 'export const b = 1\n', 'utf8')
    writeFileSync(join(workspaceDir, xlsxRel), xlsxShelf)
    writeFileSync(
      stateFile,
      JSON.stringify({
        user: 'e2e',
        client: 'e2e-client',
        clientRoot: workspaceDir,
        depotPrefix: '//depot',
        files: {
          '//depot/hello.txt': { rev: 1, content: 'hello\n' },
          '//depot/src/editor/a.ts': { rev: 1, content: baselineA },
          '//depot/src/runtime/b.ts': { rev: 1, content: 'export const b = 1\n' },
          // A depot path OUTSIDE the client view (not under //depot, the mapped
          // prefix): `p4 where` returns no mapping and a client-bound `p4 print`
          // fails. It must still diff, because printRevision reads it with no
          // client. Regression guard for the blank out-of-workspace diff.
          '//other/lib/c.ts': { rev: 4, content: 'export const c = 1\n' },
          // A file with revision history, edited by SUBMITTED change 906 (below).
          // #6 (head) contains the edit; #5 is the pre-edit base. `describe -S` of
          // a submitted change reports #6, so the base must be #5 — else both diff
          // sides show #6 and the diff is blank (the committed-review bug).
          '//depot/src/editor/d.ts': {
            rev: 6,
            content: 'export const d = 2\n',
            revisions: { 5: 'export const d = 1\n', 6: 'export const d = 2\n' },
          },
          [xlsxDepot]: { rev: 3, contentBase64: xlsxBase.toString('base64') },
        },
        opened: {},
        // Submitted changelists (describe -S reports status=submitted; a file's
        // `rev` is the revision that CONTAINS the edit, so its base is rev-1).
        submitted: {
          '906': {
            '//depot/src/editor/d.ts': { action: 'edit', rev: 6 },
          },
        },
        shelved: {
          '900': {
            '//depot/src/editor/a.ts': { action: 'edit', rev: 1, content: shelvedA },
            '//depot/src/runtime/b.ts': {
              action: 'add',
              rev: 1,
              content: 'export const b = 2\n',
            },
          },
          // A shelf whose only file lies outside the client view (see files map);
          // backs review #1004, the out-of-workspace diff regression guard.
          '904': {
            '//other/lib/c.ts': { action: 'edit', rev: 4, content: 'export const c = 2\n' },
          },
          '903': {
            [xlsxDepot]: {
              action: 'edit',
              rev: 3,
              contentBase64: xlsxShelf.toString('base64'),
            },
          },
        },
      }),
      'utf8',
    )

    // Start the fake Swarm server and learn its URL.
    const swarmProc: ChildProcess = spawn(process.execPath, [FAKE_SWARM], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        UNIVERSE_SWARM_FAKE_PORTFILE: portfile,
        UNIVERSE_SWARM_FAKE_LOG: logfile,
      },
      stdio: 'ignore',
    })
    const baseUrl = await waitForPortfile(portfile)

    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify(
        {
          'workbench.language': 'en-US',
          'update.mode': 'manual',
          'perforce.swarm.enabled': true,
          'perforce.swarm.url': baseUrl,
          'perforce.swarm.apiVersion': 'v9',
          // The seeded reviews use fixed 2023 timestamps; disable the time window
          // so the default 7-day limit doesn't filter them all out.
          'perforce.swarm.reviewWindowDays': 0,
        },
        null,
        2,
      ),
      'utf8',
    )
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )

    const app = await launchApp({
      appRoot: APP_ROOT,
      mainEntry: MAIN_ENTRY,
      userDataDir,
      extensions: PERFORCE_EXTENSIONS,
      extraArgs: [workspaceDir],
      env: {
        UNIVERSE_P4_PATH: FAKE_P4,
        UNIVERSE_P4_FAKE_STATE: stateFile,
        UNIVERSE_SWARM_BASE_URL: baseUrl,
      },
    })
    const handle = app as unknown as {
      _clientRoot: string
      _logfile: string
      _swarmProc: ChildProcess
      _baseUrl: string
    }
    handle._clientRoot = workspaceDir
    handle._logfile = logfile
    handle._swarmProc = swarmProc
    handle._baseUrl = baseUrl
    await use(app)
    await closeApp(app)
    swarmProc.kill()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForProbe(page)
    await use(page)
    await expectNoLeaks(page)
  },
  workbench: async ({ page }, use) => {
    await use(new WorkbenchPO(page))
  },
  swarm: async ({ electronApp }, use) => {
    const handle = electronApp as unknown as {
      _clientRoot: string
      _logfile: string
      _baseUrl: string
    }
    const readLog = (): Array<{
      method: string
      path: string
      query: string
      body?: unknown
    }> => {
      if (!existsSync(handle._logfile)) return []
      return readFileSync(handle._logfile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    }
    await use({
      clientRoot: toPosix(handle._clientRoot),
      baseUrl: handle._baseUrl,
      requests: readLog,
      waitForRequest: async (matchFn, timeoutMs = 10_000) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          if (readLog().some((r) => matchFn(r))) return
          await new Promise((r) => setTimeout(r, 150))
        }
        throw new Error('timed out waiting for a matching Swarm request')
      },
      addReview: async (opts) => {
        const res = await fetch(`${handle._baseUrl}/__control__/add-review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(opts),
        })
        if (!res.ok) throw new Error(`add-review failed: ${res.status}`)
      },
    })
  },
})

export { expect } from '@playwright/test'
