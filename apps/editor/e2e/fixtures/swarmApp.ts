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

import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from '../pages/WorkbenchPO.js'
import { APP_ROOT, MAIN_ENTRY, closeApp } from './electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_P4 = resolve(__dirname, 'fake-p4.mjs')
const FAKE_SWARM = resolve(__dirname, 'fake-swarm.mjs')

const toPosix = (p: string): string => p.split('\\').join('/')

export interface SwarmHarness {
  readonly clientRoot: string
  /** Read the recorded Swarm requests (method + path + body), newest last. */
  requests(): Array<{ method: string; path: string; query: string; body?: unknown }>
  /** Wait until a request matching the predicate has been recorded. */
  waitForRequest(
    match: (r: { method: string; path: string }) => boolean,
    timeoutMs?: number,
  ): Promise<void>
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

    // Seed a minimal p4 depot so discovery succeeds + shelve has something.
    mkdirSync(join(workspaceDir, 'src', 'editor'), { recursive: true })
    mkdirSync(join(workspaceDir, 'src', 'runtime'), { recursive: true })
    writeFileSync(join(workspaceDir, 'hello.txt'), 'hello\n', 'utf8')
    writeFileSync(join(workspaceDir, 'src', 'editor', 'a.ts'), baselineA, 'utf8')
    writeFileSync(join(workspaceDir, 'src', 'runtime', 'b.ts'), 'export const b = 1\n', 'utf8')
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
        },
        opened: {},
        shelved: {
          '900': {
            '//depot/src/editor/a.ts': { action: 'edit', rev: 1, content: shelvedA },
            '//depot/src/runtime/b.ts': {
              action: 'add',
              rev: 1,
              content: 'export const b = 2\n',
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

    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, workspaceDir],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
        UNIVERSE_P4_PATH: FAKE_P4,
        UNIVERSE_P4_FAKE_STATE: stateFile,
        UNIVERSE_SWARM_BASE_URL: baseUrl,
      },
    })
    const handle = app as unknown as {
      _clientRoot: string
      _logfile: string
      _swarmProc: ChildProcess
    }
    handle._clientRoot = workspaceDir
    handle._logfile = logfile
    handle._swarmProc = swarmProc
    await use(app)
    await closeApp(app)
    swarmProc.kill()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await use(page)
    await expectNoLeaks(page)
  },
  workbench: async ({ page }, use) => {
    await use(new WorkbenchPO(page))
  },
  swarm: async ({ electronApp }, use) => {
    const handle = electronApp as unknown as { _clientRoot: string; _logfile: string }
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
      requests: readLog,
      waitForRequest: async (matchFn, timeoutMs = 10_000) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          if (readLog().some((r) => matchFn(r))) return
          await new Promise((r) => setTimeout(r, 150))
        }
        throw new Error('timed out waiting for a matching Swarm request')
      },
    })
  },
})

export { expect } from '@playwright/test'
