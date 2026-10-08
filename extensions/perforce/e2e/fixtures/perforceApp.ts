/*---------------------------------------------------------------------------------------------
 *  Playwright fixture for Perforce specs. Cold-launches Electron (like
 *  electronApp.ts) but wires the extension's `p4` calls to the fake p4 CLI
 *  (fixtures/fake-p4.mjs) via `UNIVERSE_P4_PATH`, and seeds a temp workspace whose
 *  depot state lives in a JSON file (`UNIVERSE_P4_FAKE_STATE`).
 *
 *  This machine / CI has the real `p4` client but no reachable `p4d`, so the
 *  extension's discovery would fail and disable the provider. The fake stands in
 *  with a real on-disk depot model so the full "edit a file → it shows an RC
 *  badge in the Explorer" flow can be exercised deterministically.
 *
 *  Each test gets its own workspace dir + state file, exposed via the `perforce`
 *  fixture. Cold-launch (not the shared instance) because opening a workspace
 *  relaunches the extension host — main-process state a window reload won't reset.
 *--------------------------------------------------------------------------------------------*/

import { test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import {
  WorkbenchPO,
  closeApp,
  expectNoLeaks,
  installFailureForensics,
  launchApp,
  resolveEditorBuild,
  seedBaselineUserData,
  waitForProbe,
  mkTempDir,
} from '@universe-editor/e2e-harness'
import type { UriComponents } from '@universe-editor/extension-api'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_P4 = resolve(__dirname, 'fake-p4.mjs')
const FAKE_P4DELTA = resolve(__dirname, 'fake-p4delta.mjs')
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
  /** The revision the workspace has synced when it is not #1 (or 0 = never
   *  synced, which leaves the client's have list empty). Defaults to 1 under
   *  `headRev`, i.e. the pre-existing "seeded content is the have revision"
   *  shape. */
  readonly haveRev?: number
  /** Content of the {@link haveRev} revision; defaults to `content`. */
  readonly haveContent?: string
  /** Per-revision historical contents, keyed by revision number. Read by the
   *  fake when printing or syncing a specific sub-head revision — without it,
   *  every sub-head revision falls back to the head content. */
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
}

/** One path spelling for comparisons: specs read logs (always `/`) against
 *  fixture paths (platform spelling), so they normalize both sides. */
export const toPosix = (p: string): string => p.split('\\').join('/')

/** The fake p4's depot prefix — every seeded depot path starts with it. */
export const DEPOT_PREFIX = '//depot'

/** One entry of the daily scope config, as a spec writes it: a client-root
 *  relative path, `/`-spelled (an absolute path is relativised against the root).
 *  A bare string names a DIRECTORY, the common case; `{ path, isDirectory: false }`
 *  names a single file. */
export type ScopeConfigEntry = string | { readonly path: string; readonly isDirectory?: boolean }

/** The workspace's daily scope file: `<clientRoot>/.p4delta-scope`, the JSON
 *  config δ reads (see `docs/reconcile.md`). The FILE is the one persistent
 *  source of the range — the extension reads exactly this path and applies the
 *  same algebra, and an operation's positional targets intersect it.
 *
 *  `include` OMITTED means the whole client root; `include: []` means explicitly
 *  nothing (every daily operation is then refused — the two are deliberately not
 *  the same). `exclude` always wins over either, and the config file excludes
 *  itself.
 *
 *  The extension resolves it itself, so writing one does not need an engine —
 *  a spec that wants the δ paths to run passes `test.use({ p4delta: {} })`.
 */
export function writeScopeFile(
  clientRoot: string,
  include?: readonly ScopeConfigEntry[],
  exclude: readonly ScopeConfigEntry[] = [],
): string {
  const entryOf = (value: ScopeConfigEntry): Record<string, string> => {
    const path = toPosix(typeof value === 'string' ? value : value.path).replace(/^\.\//, '')
    const isFile = typeof value !== 'string' && value.isDirectory === false
    return isFile ? { file: path } : { dir: path }
  }
  const config: Record<string, unknown> = {}
  if (include !== undefined) config.include = include.map(entryOf)
  if (exclude.length > 0) config.exclude = exclude.map(entryOf)
  const file = join(clientRoot, '.p4delta-scope')
  writeFileSync(file, JSON.stringify(config), 'utf8')
  return file
}

/**
 * Opt-in δ engine for a spec (see the `p4delta` fixture). The two fake engines
 * share one state file, so a spec can drive a write through δ and inspect the
 * result with the native model (or the other way round).
 */
export interface P4deltaFixtureConfig {
  /**
   * Injection for EVERY fake p4delta spawn: `UNIVERSE_P4DELTA_FAKE_FAIL`. The run
   * faults are `crash` / `crash-scan` / `nosummary` / `exit2` / `error` /
   * `unmatched` (see the fake's header); an unknown value makes the fake exit 2.
   */
  readonly fail?: string
}

/**
 * One fake's argv log (`UNIVERSE_P4_FAKE_ARGV_LOG` /
 * `UNIVERSE_P4DELTA_ARGV_LOG`), one spawn per line, '' before the first spawn.
 *
 * The fakes answer from a shared on-disk model, so a panel assertion alone
 * cannot tell which engine was asked or with what argv — these logs are where
 * the SHAPE of the call (`--json` / `--client-root` / `--exclude-dir` /
 * "no native reconcile at all") is assertable. A missing file is the empty log,
 * deliberately not an error: "never spawned" is a valid thing to assert.
 */
export function readArgvLog(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

/**
 * One δ spawn's RESOLVED SCOPE, as the fake logged it
 * (`UNIVERSE_P4DELTA_SCOPE_LOG`): the range the run actually worked over, not
 * the argv that asked for it.
 *
 * The caller names targets and δ resolves them against the client root's config,
 * so the argv line alone cannot say what range the engine ended up with — only
 * the config read it did says that. That is the whole question the layering work
 * is about (scope ∩ focus, the config's exclusions). The fake writes one of these
 * per spawn that resolved a scope, before it executes, so this is also the
 * surviving evidence of a run that later crashed.
 */
export interface ScopeResolution {
  readonly kind: 'scope-resolution'
  /** The run's mode: `open`, `clean` or `sync`. */
  readonly mode: string
  readonly status: 'resolved' | 'empty'
  /** `<kind>:<path>` entries, e.g. `directory:E:/ws/src` — the range the run was
   *  scoped to (the config's includes intersected with {@link targets}, minus the
   *  exclusions). */
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
  /** The typed positional targets this run was GIVEN, which is the caller's own
   *  claim about the range; `includes` is what the config left of it. */
  readonly targets: readonly string[]
  readonly scopeFile: string | null
}

export function readScopeLog(file: string): ScopeResolution[] {
  return readArgvLog(file).map((line) => JSON.parse(line) as ScopeResolution)
}

/** The client's have revision of one seeded depot file, read straight from the
 *  fake p4's state file (what a real `p4 fstat` would report as `haveRev`). */
export function readHaveRev(stateFile: string, relPath: string): number | undefined {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    files?: Record<string, { haveRev?: number }>
  }
  return state.files?.[`${DEPOT_PREFIX}/${toPosix(relPath)}`]?.haveRev
}

function seedWorkspace(
  seeds: readonly SeedFile[],
  changelists: Readonly<Record<string, string>> = {},
  annotate?: P4AnnotateSeed,
  submitted?: readonly P4SubmittedSeed[],
  ignored?: readonly string[],
): {
  workspaceDir: string
  stateFile: string
} {
  const workspaceDir = mkTempDir('ue2-p4-ws-')
  const depotPrefix = DEPOT_PREFIX
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
            haveRev: seed.haveRev ?? 1,
            haveContent: seed.haveContent ?? seed.content,
            ...(seed.revisions ? { revisions: seed.revisions } : {}),
            ...faults,
          }
        : {
            rev: 1,
            content: seed.content,
            // Only when a spec asks for it: absent, the entry keeps its old shape
            // (head == have == #1) and every existing seed is unaffected.
            ...(seed.haveRev !== undefined
              ? { haveRev: seed.haveRev, haveContent: seed.haveContent ?? seed.content }
              : {}),
            ...(seed.revisions ? { revisions: seed.revisions } : {}),
            ...faults,
          }
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
  const stateDir = mkTempDir('ue2-p4-state-')
  const stateFile = join(stateDir, 'state.json')
  const changeMeta: FakeState['changeMeta'] = {}
  if (annotate) {
    changeMeta[annotate.changelist] = {
      user: annotate.user,
      time: annotate.time,
      desc: annotate.description,
    }
  }
  for (const sub of submitted ?? []) {
    changeMeta[sub.changelist] = {
      user: sub.user,
      time: sub.time,
      desc: sub.description,
      // The revision the change produced for its files: `sync @<cl>` lands on
      // it instead of head, so a graph get-revision can stop at a middle rev.
      ...(sub.rev !== undefined ? { rev: sub.rev } : {}),
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
    ...(submitted !== undefined && submitted.length > 0
      ? {
          submitted: Object.fromEntries(
            submitted.map((sub) => [
              sub.changelist,
              Object.fromEntries(
                sub.files.map((f) => [
                  `${depotPrefix}/${toPosix(f.relPath)}`,
                  { action: f.action, rev: f.rev },
                ]),
              ),
            ]),
          ),
        }
      : {}),
    ...(ignored && ignored.length > 0 ? { ignored: [...ignored] } : {}),
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  return { workspaceDir, stateFile }
}

export type PerforceFixtures = {
  p4Workspace: PerforceHarness & { stateFile: string; saviorFile: string }
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
  /** Submitted changelists with real file sets (`describe -s` + `changes -l`
   *  source, newest first). Back "Open Commit" (multi-diff), graph details
   *  assertions, and — with `rev` set — `p4 sync @<cl>` landing mid-history. */
  readonly submitted?: readonly P4SubmittedSeed[]
  /** Ignore rules for `p4 ignores -i` (checkIgnore e2e): client-root-relative
   *  paths or directory prefixes. */
  readonly ignored?: readonly string[]
  /** Sync records another tool left on this machine, as the graph's sync point
   *  reads them (`../src/graphSyncExternal.ts`). Seeded into a temp file the app
   *  is pointed at, never into the workspace. */
  readonly savior?: readonly P4SaviorSeed[]
}

/** One entry of the `editor_savior` helper's sync config. */
export interface P4SaviorSeed {
  /** Depot path the tool groups its entries under (the stream). The extension
   *  matches on the client root, so this is decoration. */
  readonly depotPath: string
  /** Epoch ms the tool stamped the record with — what decides whether it or the
   *  editor's own record answers. */
  readonly timestamp: number
  readonly change: string | number
  /** Client root the record claims to describe. Defaults to this spec's own
   *  workspace, which is what makes it answer for it. */
  readonly clientRoot?: string
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
 *  (`describe -s`). `rev` is the revision the change produced for those files —
 *  `p4 sync @<changelist>` then lands on `rev` instead of head (time travel to
 *  a middle revision). Per-file `files[].rev` is the same number per file. */
export interface P4SubmittedSeed {
  readonly changelist: string
  readonly user: string
  /** Unix seconds (string), matching `p4 -ztag changes` output. */
  readonly time: string
  readonly description: string
  /** Revision the change produced; without it `sync @<cl>` resolves to head. */
  readonly rev?: number
  readonly files: readonly {
    readonly relPath: string
    readonly action: 'add' | 'edit' | 'delete'
    readonly rev: number
  }[]
}

/**
 * The sync config `editor_savior` keeps under the user's home, as the app reads
 * it — written to a temp file the app is pointed at instead of anywhere near the
 * workspace or the real one.
 *
 * A path is returned even with nothing to seed, and it is a path that does not
 * exist: the app always reads SOME file for this, and pointing it at a real
 * developer's own records would make every journey depend on their machine.
 */
function seedSaviorConfig(clientRoot: string, seeds: readonly P4SaviorSeed[] | undefined): string {
  const file = join(mkTempDir('ue2-p4-savior-'), 'sync_config.json')
  if (seeds === undefined || seeds.length === 0) return file
  const byDepot: Record<string, unknown[]> = {}
  for (const seed of seeds) {
    const entries = byDepot[seed.depotPath] ?? []
    entries.push({
      ClientName: 'e2e-client',
      ClientRoot: seed.clientRoot ?? clientRoot,
      ChangeNum: Number(seed.change),
      Timestamp: seed.timestamp,
    })
    byDepot[seed.depotPath] = entries
  }
  writeFileSync(file, JSON.stringify(byDepot, null, 2), 'utf8')
  return file
}

/** The fake-CLI log files a spec can point the run at through `p4ExtraEnv`. */
const FAKE_CLI_LOG_ENV = [
  'UNIVERSE_P4DELTA_SCOPE_LOG',
  'UNIVERSE_P4DELTA_ARGV_LOG',
  'UNIVERSE_P4_FAKE_ARGV_LOG',
] as const

/** `work`, or undefined after `ms`: a renderer that stopped answering must not
 *  hang the teardown that is busy collecting evidence (a `page.evaluate` has no
 *  timeout of its own). A rejection still propagates — the caller reports it. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  const settled = work.then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const,
  )
  const timedOut = Symbol('timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      settled,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), ms)
      }),
    ])
    if (result === timedOut) return undefined
    if ('error' in result) throw result.error
    return result.value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Evidence Playwright's own artifacts cannot carry — screenshots of this app are
 * black frames and the aria snapshot is taken after the leak gate unmounted
 * React (see the harness `forensics.ts` header):
 *
 * - the extension's **`Perforce` output channel**. It lives in renderer memory,
 *   so the `<userData>/logs` copy does not contain one line of it, and its lines
 *   are what tell "the setting never reached the client"
 *   (`[perforce] reconcile exclusions: 0 dir(s) … (<none>)`) apart from "the
 *   scan never ran" (`reconcile-scan: …`) or "the client went offline".
 * - the **fake CLIs' logs**. They carry the assertions of most specs here, and a
 *   MISSING file is itself an answer ("nothing ever spawned it") that a bare test
 *   result cannot be told apart from "spawned with the wrong argv".
 *
 * Attached only on failure, and best-effort throughout: forensics must never turn
 * a pass into a failure, fail an already-failing test twice, or hang a teardown.
 * Read BEFORE `expectNoLeaks(page)` — that is what unmounts React, and with it
 * the probe.
 *
 * Each piece lands TWICE, on purpose: as a file under the test's output dir (CI
 * uploads `test-results/`, and an in-memory attachment is not in it) and as an
 * attachment (the list reporter prints text bodies, so the failure is readable
 * straight from the job log).
 */
async function attachPerforceForensics(
  page: Page,
  testInfo: TestInfo,
  env: Record<string, string>,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return
  const outDir = testInfo.outputPath('perforce-forensics')
  try {
    mkdirSync(outDir, { recursive: true })
  } catch {
    // Without the dir the attachments below still reach the job log.
  }
  const attach = async (name: string, body: string): Promise<void> => {
    try {
      writeFileSync(join(outDir, name), body, 'utf8')
    } catch {
      // Best-effort: the attachment below is the same text.
    }
    try {
      await testInfo.attach(name, { body, contentType: 'text/plain' })
    } catch {
      // Attaching is optional; the test result is not.
    }
  }

  let channel: string
  try {
    const content = await bounded(
      page.evaluate((name) => window.__E2E__!.getOutputChannelContent(name), 'Perforce'),
      10_000,
    )
    channel = content ?? '<unavailable: the renderer did not answer within 10s>'
  } catch (error) {
    channel = `<unavailable: ${String(error)}>`
  }
  await attach('perforce-output-channel.txt', channel)
  for (const key of FAKE_CLI_LOG_ENV) {
    const file = env[key]
    if (file === undefined) continue
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '<missing: nothing spawned it>'
    await attach(`${key}.log`, body)
  }
}

export const test = base.extend<
  PerforceFixtures & {
    p4Seeds: P4SeedConfig
    openSubdir: string
    p4ExtraEnv: Record<string, string>
    p4delta: P4deltaFixtureConfig | undefined
  }
>({
  p4Seeds: [{ files: DEFAULT_SEEDS }, { option: true }],
  // Relative subdir to open instead of the client root ('' = open the root) —
  // reproducing "open a deep folder of a huge p4 client".
  openSubdir: ['', { option: true }],
  // Extra environment for the launched app. Needed by the sync I/O rate spec,
  // which points `UNIVERSE_P4_IO_PROBE` at a deterministic fake sampler and
  // slows the fake p4 down so the run is observable while it is in flight.
  p4ExtraEnv: [{}, { option: true }],
  // Opt-in only: `test.use({ p4delta: {} })` points the extension at the fake
  // p4delta engine, `{ fail: '<mode>' }` also injects a fault. LEFT UNSET by
  // default on purpose — every pre-existing spec runs both engines' wiring
  // unchanged (p4 alone, no δ), and turning δ on for them would silently move
  // their scans onto a second fake.
  p4delta: [undefined, { option: true }],
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
    )
    const openDir = openSubdir ? join(workspaceDir, openSubdir) : workspaceDir
    const saviorFile = seedSaviorConfig(workspaceDir, p4Seeds.savior)
    const abs = (relPath: string) => toPosix(join(workspaceDir, relPath))
    await use({
      clientRoot: workspaceDir,
      openDir,
      stateFile,
      saviorFile,
      file: abs,
      fileUri: (relPath: string) => {
        const p = abs(relPath)
        return { scheme: 'file', path: p.startsWith('/') ? p : '/' + p }
      },
      fileUrl: (relPath: string) => `file:///${abs(relPath).replace(/^\/+/, '')}`,
    })
  },
  electronApp: async ({ p4Workspace, p4ExtraEnv, p4delta }, use, testInfo) => {
    const userDataDir = mkTempDir('universe-editor-e2e-p4-')
    seedBaselineUserData(userDataDir)
    const app = await launchApp({
      appRoot: APP_ROOT,
      mainEntry: MAIN_ENTRY,
      userDataDir,
      extensions: PERFORCE_EXTENSIONS,
      env: {
        UNIVERSE_P4_PATH: FAKE_P4,
        UNIVERSE_P4_FAKE_STATE: p4Workspace.stateFile,
        // No OS process sampler in the fake-p4 environment: it is per-platform,
        // unpinnable and would make every timing assertion here nondeterministic.
        // The rate's own spec overrides this with a scripted probe.
        UNIVERSE_P4_IO_PROBE: 'off',
        // Pinned even when nothing is seeded (the file simply does not exist):
        // the app reads the real developer's own sync records otherwise, and
        // every assertion below would depend on their machine.
        UNIVERSE_P4_SAVIOR_CONFIG: p4Workspace.saviorFile,
        // The δ engine, only when the spec asked for it. `UNIVERSE_P4DELTA_PATH`
        // is what lets the extension keep δ enabled despite `p4` itself being a
        // script override (the fake above) — see `resolveP4deltaEngine`.
        ...(p4delta !== undefined
          ? {
              UNIVERSE_P4DELTA_PATH: FAKE_P4DELTA,
              ...(p4delta.fail !== undefined ? { UNIVERSE_P4DELTA_FAKE_FAIL: p4delta.fail } : {}),
            }
          : {}),
        ...p4ExtraEnv,
      },
    })
    // The window is needed HERE only to install failure forensics (the page
    // fixture makes the real assertions about it). Best-effort: a window that
    // never appears must fail as the page fixture's problem, not as a forensics
    // timeout during setup. `firstWindow()` is cached, so the page fixture gets
    // the same Page.
    const page = await app.firstWindow().catch(() => undefined)
    const finalizeForensics =
      page === undefined ? undefined : installFailureForensics(page, userDataDir)
    await use(app)
    await closeApp(app)
    // After closeApp: the log files are flushed by then.
    if (finalizeForensics !== undefined) await finalizeForensics(testInfo)
  },
  page: async ({ electronApp, p4ExtraEnv }, use, testInfo) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForProbe(page)
    await use(page)
    await attachPerforceForensics(page, testInfo, p4ExtraEnv)
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
