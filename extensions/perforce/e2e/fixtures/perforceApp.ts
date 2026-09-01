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

import { test as base, type ElectronApplication, type Page } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  WorkbenchPO,
  closeApp,
  expectNoLeaks,
  launchApp,
  resolveEditorBuild,
  seedBaselineUserData,
  waitForProbe,
} from '@universe-editor/e2e-harness'
import type { UriComponents } from '@universe-editor/extension-api'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_P4 = resolve(__dirname, 'fake-p4.mjs')
const { appRoot: APP_ROOT, mainEntry: MAIN_ENTRY } = resolveEditorBuild()

// Only the Perforce extension is activated for these specs (P2 minimal set): its
// SCM provider is all they exercise, so skipping TS/markdown/ai LSP startup keeps
// the cold launch lean and free of unrelated warmup flake.
const PERFORCE_EXTENSIONS = ['@universe-editor/perforce'] as const

/** A depot file the fake p4 knows about: its content is what the workspace has
 *  synced (the have revision), and it is written to disk as-is. */
export interface SeedFile {
  readonly relPath: string
  readonly content: string
  /** Depot head is ahead of the synced revision: `headRev`/`headContent` become
   *  the depot head (`p4 sync -n` then reports the file), while the seeded
   *  `content` stays the have revision at #1. */
  readonly headRev?: number
  readonly headContent?: string
  /** Per-revision historical contents, keyed by revision number. `sync @<cl>`
   *  resolves a changelist to a revision (via `changeMeta.rev`) and reads this
   *  map for that revision's content — without it, every sub-head revision
   *  falls back to the head content. */
  readonly revisions?: Readonly<Record<string, string>>
  /** Fault injection: a real `p4 sync` without `-f` refuses to overwrite this
   *  file (`can't clobber writable file`, exit 1); `-f` overrides. */
  readonly clobber?: boolean
  /** Fault injection, the `allwrite noclobber` counterpart of {@link clobber}:
   *  sync skips just this file (`can't update modified file` on **stdout**,
   *  exit **0**) and carries on with the rest; `-f` overrides. */
  readonly refused?: boolean
  /** The file is already open in this client. `resolve` seeds a needs-resolve
   *  state that `p4 resolve -am` either auto-lands ('merge') or leaves open
   *  with `resolve skipped` ('conflict'). */
  readonly opened?: {
    readonly action?: 'edit' | 'add' | 'delete'
    readonly change?: string
    readonly rev?: number
    readonly resolve?: 'merge' | 'conflict'
  }
  /** Open for edit/add in ANOTHER client — `p4 opened -a` reports it with the
   *  other client's client-syntax `clientFile` (the "in use by others" marker). */
  readonly openedBy?: {
    readonly user: string
    readonly client: string
    readonly action?: 'edit' | 'add'
    readonly rev?: number
  }
  /** Write the file to the workspace but keep it OUT of the depot — a local-only
   *  file, which is the only kind `.p4ignore` rules are meant to hide. Seeding an
   *  ignored file as a depot file instead would make the checkIgnore depot filter
   *  legitimately drop it and the spec would assert the wrong thing. */
  readonly untracked?: boolean
}

export interface PerforceHarness {
  /** The fake p4 client root (top of the workspace mapping). */
  readonly clientRoot: string
  /** The folder the editor should open — the client root, or a nested subdir when
   *  the spec sets `openSubdir` (mirrors opening a deep folder of a big depot). */
  readonly openDir: string
  /** Absolute path of a file under the client root (forward-slashed). */
  file(relPath: string): string
  /** `file()` as an explorer-right-click `UriComponents` (`{scheme:'file', path}`).
   *  POSIX host paths already start with `/`, so only Windows's `C:/…` needs a
   *  leading slash prepended. */
  fileUri(relPath: string): UriComponents
  /** `file()` as a `file:///` URL string, for commands whose arg is a uri string
   *  rather than `UriComponents`. Raw concatenation, so seed relPaths must stay
   *  ASCII — anything needing percent-encoding would drift from `fileUri`. */
  fileUrl(relPath: string): string
}

interface FakeState {
  user: string
  client: string
  clientRoot: string
  depotPrefix: string
  /** Depot files. `rev`/`content` are the HEAD revision+content; `haveRev`/
   *  `haveContent`, when present, are what the client has synced. */
  files: Record<
    string,
    {
      rev: number
      content: string
      revisions?: Record<string, string>
      haveRev?: number
      haveContent?: string
      clobber?: boolean
      refused?: boolean
    }
  >
  opened: Record<
    string,
    {
      action: string
      change: string
      rev: number
      unresolved?: boolean
      resolveOutcome?: 'merge' | 'conflict'
    }
  >
  /** Files someone ELSE has open (`p4 opened -a` source). */
  openedByOthers?: Record<string, { user: string; client: string; action: string; rev: number }>
  /** Ignore rules (`p4 ignores -i` source): client-root-relative paths / dirs. */
  ignored?: string[]
  changelists?: Record<string, { description: string }>
  changeMeta?: Record<string, { user: string; time: string; desc: string; rev?: number }>
  /** Submitted changelists with their file sets (`describe -s` source), keyed by
   *  change id → depot file → action/rev. */
  submitted?: Record<string, Record<string, { action: string; rev: number }>>
  annotateCl?: string
  /** `cstat` classifications (change id → have/need/partial). Absent = the server
   *  has no `cstat`, which the behind-list must degrade on. */
  cstat?: Record<string, 'have' | 'need' | 'partial'>
}

const toPosix = (p: string): string => p.split('\\').join('/')

function seedWorkspace(
  seeds: readonly SeedFile[],
  changelists: Readonly<Record<string, string>> = {},
  annotate?: P4AnnotateSeed,
  submitted?: P4SubmittedSeed,
  ignored?: readonly string[],
  changeMetaSeed?: Readonly<Record<string, P4ChangeMetaSeed>>,
  cstat?: Readonly<Record<string, 'have' | 'need' | 'partial'>>,
): {
  workspaceDir: string
  stateFile: string
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'ue2-p4-ws-'))
  const depotPrefix = '//depot'
  const files: FakeState['files'] = {}
  const opened: FakeState['opened'] = {}
  const openedByOthers: NonNullable<FakeState['openedByOthers']> = {}
  for (const seed of seeds) {
    const abs = join(workspaceDir, seed.relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, seed.content, 'utf8')
    if (seed.untracked === true) continue
    const depotFile = `${depotPrefix}/${toPosix(seed.relPath)}`
    const faults = {
      ...(seed.clobber === true ? { clobber: true } : {}),
      ...(seed.refused === true ? { refused: true } : {}),
    }
    const entry: FakeState['files'][string] =
      seed.headRev !== undefined
        ? {
            rev: seed.headRev,
            content: seed.headContent ?? seed.content,
            haveRev: 1,
            haveContent: seed.content,
            ...(seed.revisions ? { revisions: seed.revisions } : {}),
            ...faults,
          }
        : { rev: 1, content: seed.content, ...(seed.revisions ? { revisions: seed.revisions } : {}), ...faults }
    files[depotFile] = entry
    if (seed.opened) {
      opened[depotFile] = {
        action: seed.opened.action ?? 'edit',
        change: seed.opened.change ?? 'default',
        rev: seed.opened.rev ?? entry.haveRev ?? entry.rev,
        ...(seed.opened.resolve !== undefined
          ? { unresolved: true, resolveOutcome: seed.opened.resolve }
          : {}),
      }
    }
    if (seed.openedBy) {
      openedByOthers[depotFile] = {
        user: seed.openedBy.user,
        client: seed.openedBy.client,
        action: seed.openedBy.action ?? 'edit',
        rev: seed.openedBy.rev ?? entry.rev,
      }
    }
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'ue2-p4-state-'))
  const stateFile = join(stateDir, 'state.json')
  const changeMeta: FakeState['changeMeta'] = {}
  if (annotate) {
    changeMeta[annotate.changelist] = {
      user: annotate.user,
      time: annotate.time,
      desc: annotate.description,
    }
  }
  if (submitted) {
    changeMeta[submitted.changelist] = {
      user: submitted.user,
      time: submitted.time,
      desc: submitted.description,
    }
  }
  if (changeMetaSeed) {
    for (const [id, m] of Object.entries(changeMetaSeed)) {
      changeMeta[id] = {
        user: m.user,
        time: m.time,
        desc: m.desc,
        ...(m.rev !== undefined ? { rev: m.rev } : {}),
      }
    }
  }
  const state: FakeState = {
    user: 'e2e',
    client: 'e2e-client',
    clientRoot: workspaceDir,
    depotPrefix,
    files,
    opened,
    ...(Object.keys(openedByOthers).length > 0 ? { openedByOthers } : {}),
    ...(Object.keys(changelists).length > 0
      ? {
          changelists: Object.fromEntries(
            Object.entries(changelists).map(([id, description]) => [id, { description }]),
          ),
        }
      : {}),
    ...(Object.keys(changeMeta).length > 0 ? { changeMeta } : {}),
    ...(annotate ? { annotateCl: annotate.changelist } : {}),
    ...(submitted
      ? {
          submitted: {
            [submitted.changelist]: Object.fromEntries(
              submitted.files.map((f) => [
                `${depotPrefix}/${toPosix(f.relPath)}`,
                { action: f.action, rev: f.rev },
              ]),
            ),
          },
        }
      : {}),
    ...(ignored && ignored.length > 0 ? { ignored: [...ignored] } : {}),
    ...(cstat && Object.keys(cstat).length > 0 ? { cstat: { ...cstat } } : {}),
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  return { workspaceDir, stateFile }
}

export type PerforceFixtures = {
  p4Workspace: PerforceHarness & { stateFile: string }
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
  /** Pending numbered changelists to pre-create, keyed by id → description. Used to
   *  assert that an (empty) numbered changelist stays visible in the SCM view. */
  readonly changelists?: Readonly<Record<string, string>>
  /** Submitted-changelist blame seed: annotate tags every line with this cl and
   *  `changes -l` resolves its author/summary, so the inline blame + status bar
   *  show `user`. */
  readonly annotate?: P4AnnotateSeed
  /** A submitted changelist with a real file set (`describe -s` + `changes -l`
   *  source). Backs "Open Commit" (multi-diff) and graph details assertions. */
  readonly submitted?: P4SubmittedSeed
  /** Ignore rules for `p4 ignores -i` (checkIgnore e2e): client-root-relative
   *  paths or directory prefixes. */
  readonly ignored?: readonly string[]
  /** Submitted-changelist metadata for the behind-list (`changes -s submitted`
   *  source), keyed by change id. `rev` lets `sync @<cl>` resolve to a concrete
   *  revision. */
  readonly changeMeta?: Readonly<Record<string, P4ChangeMetaSeed>>
  /** `cstat` classifications for the behind-list, keyed by change id. Omit to
   *  model a server with no `cstat` (the behind-list then degrades to the
   *  unfiltered recent list). */
  readonly cstat?: Readonly<Record<string, 'have' | 'need' | 'partial'>>
}

/** One submitted changelist's metadata for `changes -s submitted`. */
export interface P4ChangeMetaSeed {
  readonly user: string
  /** Unix seconds (string), matching `p4 -ztag changes` output. */
  readonly time: string
  readonly desc: string
  /** The revision this changelist produced, so the fake can resolve `sync @<cl>`
   *  to a concrete revision in the file's `revisions` history. */
  readonly rev?: number
}

/** Blame seed: the changelist annotate reports + the metadata `changes -l` returns. */
export interface P4AnnotateSeed {
  readonly changelist: string
  readonly user: string
  /** Unix seconds (string), matching `p4 -ztag changes` output. */
  readonly time: string
  readonly description: string
}

/** A submitted changelist: metadata (`changes -l`) plus the files it touched
 *  (`describe -s`). `rev` is the revision CONTAINING the edit (base = rev-1). */
export interface P4SubmittedSeed {
  readonly changelist: string
  readonly user: string
  /** Unix seconds (string), matching `p4 -ztag changes` output. */
  readonly time: string
  readonly description: string
  readonly files: readonly {
    readonly relPath: string
    readonly action: 'add' | 'edit' | 'delete'
    readonly rev: number
  }[]
}

export const test = base.extend<PerforceFixtures & { p4Seeds: P4SeedConfig; openSubdir: string }>({
  p4Seeds: [{ files: DEFAULT_SEEDS }, { option: true }],
  // Relative subdir to open instead of the client root ('' = open the root) —
  // reproducing "open a deep folder of a huge p4 client".
  openSubdir: ['', { option: true }],
  // The seeded depot/workspace is a first-class fixture: both electronApp (which
  // launches the app against its state file) and the `perforce` harness read it
  // from here, so nothing has to be smuggled onto the ElectronApplication handle.
  p4Workspace: async ({ p4Seeds, openSubdir }, use) => {
    const { workspaceDir, stateFile } = seedWorkspace(
      p4Seeds.files,
      p4Seeds.changelists,
      p4Seeds.annotate,
      p4Seeds.submitted,
      p4Seeds.ignored,
      p4Seeds.changeMeta,
      p4Seeds.cstat,
    )
    const openDir = openSubdir ? join(workspaceDir, openSubdir) : workspaceDir
    const abs = (relPath: string) => toPosix(join(workspaceDir, relPath))
    await use({
      clientRoot: workspaceDir,
      openDir,
      stateFile,
      file: abs,
      fileUri: (relPath: string) => {
        const p = abs(relPath)
        return { scheme: 'file', path: p.startsWith('/') ? p : '/' + p }
      },
      fileUrl: (relPath: string) => `file:///${abs(relPath).replace(/^\/+/, '')}`,
    })
  },
  electronApp: async ({ p4Workspace }, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-p4-'))
    seedBaselineUserData(userDataDir)
    const app = await launchApp({
      appRoot: APP_ROOT,
      mainEntry: MAIN_ENTRY,
      userDataDir,
      extensions: PERFORCE_EXTENSIONS,
      env: {
        UNIVERSE_P4_PATH: FAKE_P4,
        UNIVERSE_P4_FAKE_STATE: p4Workspace.stateFile,
      },
    })
    await use(app)
    await closeApp(app)
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
  perforce: async ({ p4Workspace }, use) => {
    const { clientRoot, openDir, file, fileUri, fileUrl } = p4Workspace
    await use({ clientRoot, openDir, file, fileUri, fileUrl })
  },
})

export { expect } from '@playwright/test'

import { expect as playwrightExpect } from '@playwright/test'

/**
 * Wait out the extension-host cold start before firing perforce.* commands.
 *
 * The SCM source control is created EARLY in the perforce extension's activate()
 * (PerforceClient.create → scm.createSourceControl), but the contributed command
 * handlers register LATER in the same activate(), in one synchronous
 * `context.subscriptions.push(...)` burst. getScmSourceControlCount() flips >0 in
 * that window, so a perforce.* command fired right after the SCM-count gate can
 * reach a host that has no handler yet: the renderer forwards the contributed
 * command, the host has nothing to run and forwards it back, and the renderer
 * rejects it ("extension host may only execute _workbench.* commands"). Because
 * all handlers register in one synchronous burst, polling any one read-only
 * command (perforce.refresh) until it stops rejecting gates them all.
 */
export async function waitForPerforceCommands(workbench: WorkbenchPO): Promise<void> {
  await playwrightExpect
    .poll(
      async () => {
        try {
          await workbench.runCommand('perforce.refresh')
          return true
        } catch (err) {
          if (/extension host may only execute/.test(String(err))) return false
          throw err
        }
      },
      {
        timeout: 30_000,
        message: 'perforce contributed commands should be registered in the host',
      },
    )
    .toBe(true)
}
