/*---------------------------------------------------------------------------------------------
 *  Playwright fixture for Perforce specs. Cold-launches Electron (like
 *  electronApp.ts) but wires the extension's `p4` calls to the fake p4 CLI
 *  (fixtures/fake-p4.mjs) via `UNIVERSE_P4_PATH`, and seeds a temp workspace whose
 *  depot state lives in a JSON file (`UNIVERSE_P4_FAKE_STATE`).
 *
 *  This machine / CI has the real `p4` client but no reachable `p4d`, so the
 *  extension's discovery would fail and disable the provider. The fake stands in
 *  with a real on-disk depot model so the full "edit a file → it appears in
 *  Changes to Reconcile" flow can be exercised deterministically.
 *
 *  Each test gets its own workspace dir + state file, exposed via the `perforce`
 *  fixture. Cold-launch (not the shared instance) because opening a workspace
 *  relaunches the extension host — main-process state a window reload won't reset.
 *--------------------------------------------------------------------------------------------*/

import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from '../pages/WorkbenchPO.js'
import { APP_ROOT, MAIN_ENTRY, closeApp } from './electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_P4 = resolve(__dirname, 'fake-p4.mjs')

/** A depot file the fake p4 knows about: its content is the have-revision. */
export interface SeedFile {
  readonly relPath: string
  readonly content: string
}

export interface PerforceHarness {
  /** The fake p4 client root (top of the workspace mapping). */
  readonly clientRoot: string
  /** The folder the editor should open — the client root, or a nested subdir when
   *  the spec sets `openSubdir` (mirrors opening a deep folder of a big depot). */
  readonly openDir: string
  /** Absolute path of a file under the client root (forward-slashed). */
  file(relPath: string): string
}

interface FakeState {
  user: string
  client: string
  clientRoot: string
  depotPrefix: string
  files: Record<string, { rev: number; content: string }>
  opened: Record<string, unknown>
}

const toPosix = (p: string): string => p.split('\\').join('/')

function seedWorkspace(seeds: readonly SeedFile[]): {
  workspaceDir: string
  stateFile: string
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'ue2-p4-ws-'))
  const depotPrefix = '//depot'
  const files: FakeState['files'] = {}
  for (const seed of seeds) {
    const abs = join(workspaceDir, seed.relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, seed.content, 'utf8')
    files[`${depotPrefix}/${toPosix(seed.relPath)}`] = { rev: 1, content: seed.content }
  }
  const stateDir = join(workspaceDir, '.p4fake')
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, 'state.json')
  const state: FakeState = {
    user: 'e2e',
    client: 'e2e-client',
    clientRoot: workspaceDir,
    depotPrefix,
    files,
    opened: {},
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  return { workspaceDir, stateFile }
}

export type PerforceFixtures = {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
  perforce: PerforceHarness
}

/** Files seeded into the depot + workspace. Override per-spec with `test.use`. */
export const DEFAULT_SEEDS: readonly SeedFile[] = [
  { relPath: 'tracked.txt', content: 'original content\n' },
]

// Playwright mis-handles an option fixture whose value is a bare array (tuple
// ambiguity — it unwraps to the first element). Wrap the seed list in an object
// so `test.use({ p4Seeds: { files: [...] } })` round-trips intact.
export interface P4SeedConfig {
  readonly files: readonly SeedFile[]
}

export const test = base.extend<PerforceFixtures & { p4Seeds: P4SeedConfig; openSubdir: string }>({
  p4Seeds: [{ files: DEFAULT_SEEDS }, { option: true }],
  // Relative subdir to open instead of the client root ('' = open the root) —
  // reproducing "open a deep folder of a huge p4 client".
  openSubdir: ['', { option: true }],
  electronApp: async ({ p4Seeds, openSubdir }, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-p4-'))
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )
    const { workspaceDir, stateFile } = seedWorkspace(p4Seeds.files)
    const openDir = openSubdir ? join(workspaceDir, openSubdir) : workspaceDir
    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
        UNIVERSE_P4_PATH: FAKE_P4,
        UNIVERSE_P4_FAKE_STATE: stateFile,
      },
    })
    const handle = app as unknown as { _p4ClientRoot: string; _p4OpenDir: string }
    handle._p4ClientRoot = workspaceDir
    handle._p4OpenDir = openDir
    await use(app)
    await closeApp(app)
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
  perforce: async ({ electronApp }, use) => {
    const handle = electronApp as unknown as { _p4ClientRoot: string; _p4OpenDir: string }
    const clientRoot = handle._p4ClientRoot
    await use({
      clientRoot,
      openDir: handle._p4OpenDir,
      file: (relPath: string) => toPosix(join(clientRoot, relPath)),
    })
  },
})

export { expect } from '@playwright/test'
