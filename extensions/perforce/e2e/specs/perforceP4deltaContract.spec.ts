/*---------------------------------------------------------------------------------------------
 *  The δ fake's own contract.
 *
 *  Every editor-facing p4delta assertion in this suite rests on what the fake
 *  ANSWERS, so the fake itself is pinned here: record shapes, exit codes, the
 *  class tables, the summary field set, the scope CONFIG's algebra and every
 *  fault mode.
 *
 *  Deliberately WITHOUT Electron, and that is the point: all the fault shapes
 *  get real assertions for milliseconds here, while the specs that need editor
 *  behaviour (scan / writes / fallback) pay for one cold launch each. The script
 *  is spawned exactly the way the extension spawns it — `process.execPath
 *  <script>` over the `.mjs` override — against the same seeded state file the
 *  Electron specs use, so the shapes asserted here are the shapes they see.
 *
 *  The scope half is the one place a fake can go quietly wrong: it is a SECOND
 *  implementation of δ's range algebra, and a self-consistent fake would prove
 *  nothing about the real one. What keeps it honest:
 *    - the algebra is asserted against the EDITOR's own reader: the same
 *      `.p4delta-scope` file, written by the same fixture the product's config
 *      reader parses, decides both sides;
 *    - the range is read back off the fake's scope log, which is the only
 *      surviving evidence of WHICH range a run ended up with — the argv names
 *      targets and the config is a file on disk, so neither alone says it;
 *    - the same fixtures were run against the real `p4delta` binary while the
 *      scope config was written, and the resolved range (includes, excludes,
 *      order, and every refusal below) matched.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { readArgvLog, readScopeLog, test, expect, writeScopeFile } from '../fixtures/perforceApp.js'
import type { ScopeResolution, SeedFile } from '../fixtures/perforceApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_P4DELTA = resolve(__dirname, '../fixtures/fake-p4delta.mjs')

const tracked: SeedFile = { relPath: 'tracked.txt', content: 'have tracked\n' }
const nested: SeedFile = { relPath: 'gone/nested.txt', content: 'have nested\n' }
const kept: SeedFile = { relPath: 'kept.txt', content: 'have kept\n' }
const ahead: SeedFile = {
  relPath: 'ahead.txt',
  content: 'have v1\n',
  headRev: 2,
  headContent: 'head v2\n',
}

interface FakeRun {
  readonly code: number | null
  readonly records: readonly Record<string, unknown>[]
  /** stdout lines that were NOT records. `--json` runs must leave this empty —
   *  P4deltaService flags such a line as "this stream cannot be trusted". */
  readonly unparsed: readonly string[]
  /** stdout as raw text — for the assertions about what is NOT a record. */
  readonly stdout: string
  readonly stderr: string
}

/** Fresh logs per test: a shared file would make every "exactly one call" and
 *  "never spawned" assertion depend on the other tests in this file. */
function makeLogs(): { delta: string; p4: string; scope: string } {
  return {
    delta: join(mkTempDir('ue2-p4delta-argv-'), 'argv.log'),
    p4: join(mkTempDir('ue2-p4-argv-'), 'argv.log'),
    scope: join(mkTempDir('ue2-p4delta-scope-'), 'scope.log'),
  }
}

/** One spawn of the fake, the way P4deltaService does it: the script through the
 *  current Node runtime, the state and the three log seams through the env. */
function runFake(
  args: readonly string[],
  opts: {
    readonly fail?: string
    readonly logs: { delta: string; p4: string; scope: string }
  },
  stateFile: string,
): FakeRun {
  const res = spawnSync(process.execPath, [FAKE_P4DELTA, ...args], {
    env: {
      ...process.env,
      UNIVERSE_P4_FAKE_STATE: stateFile,
      UNIVERSE_P4DELTA_ARGV_LOG: opts.logs.delta,
      UNIVERSE_P4_FAKE_ARGV_LOG: opts.logs.p4,
      UNIVERSE_P4DELTA_SCOPE_LOG: opts.logs.scope,
      ...(opts.fail !== undefined ? { UNIVERSE_P4DELTA_FAKE_FAIL: opts.fail } : {}),
    },
    encoding: 'utf8',
  })
  const stdout = res.stdout ?? ''
  const records: Record<string, unknown>[] = []
  const unparsed: string[] = []
  for (const line of stdout.split('\n').filter((l) => l !== '')) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // `--help` / `--version` are human text on purpose; a JSON run leaves this
      // empty.
      unparsed.push(line)
    }
  }
  return { code: res.status, stdout, stderr: res.stderr ?? '', records, unparsed }
}

const SUMMARY_KEYS = [
  'kind',
  'mode',
  'ok',
  'applied',
  // Normal sync and the force repair share `mode:"sync"` and part of the class
  // table; this flag is what tells them apart, on the summary and on every file
  // record (a consumer must never read a repair as "your local work is safe").
  'force',
  'total',
  'counts',
  'scopeMatched',
  'unmatched',
  'elapsedMs',
  'reason',
]

function summaryOf(run: FakeRun): Record<string, unknown> {
  const summary = run.records.find((r) => r['kind'] === 'summary')
  expect(summary, 'a run that ends cleanly must carry a summary').toBeDefined()
  return summary!
}

const filesOf = (run: FakeRun): Record<string, unknown>[] =>
  run.records.filter((r) => r['kind'] === 'file')

/** A local path as δ SPELLS it in its records: platform separators, upper-cased
 *  drive. The editor accepts either spelling (it keys paths through its own
 *  `scopeKey`), but the assertions here should pin the shape the ENGINE emits,
 *  not the shape this test happened to seed. */
function deltaPath(path: string): string {
  const abs = resolve(path)
  return /^[a-zA-Z]:/.test(abs) ? abs[0]!.toUpperCase() + abs.slice(1) : abs
}

// ---- δ's argv, spelled the way the extension spells it --------------------

/** A directory target: the explicit recursive suffix is what tells the engine
 *  "this is a directory" for a path that is not on disk yet. */
const dirTarget = (path: string): string => `${path.replace(/[/\\]+$/, '')}/...`
/** A file target: its plain local path, never a filespec. */
const fileTarget = (path: string): string => path

/** The engine's scan / narrow-query argv, exactly as `_buildP4deltaNarrowArgs`
 *  spells it: the contract switches, this operation's OWN exclusions, then one
 *  argv per target. No `-a` — a narrow query is a preview. The daily scope's own
 *  exclusions are NOT in here: δ reads the same config the editor read. */
const scanArgs = (
  clientRoot: string,
  targets: readonly string[],
  excludes: readonly string[] = [],
): string[] => [
  '--json',
  '--client-root',
  clientRoot,
  '--no-revert-groups',
  ...excludes,
  ...targets,
]

/** δ's write argv (`_buildP4deltaWriteArgs`): `-a` is what makes it the write. */
const applyArgs = (
  clientRoot: string,
  targets: readonly string[],
  options: { readonly excludes?: readonly string[]; readonly override?: boolean } = {},
): string[] => [
  '--json',
  '--client-root',
  clientRoot,
  '--no-revert-groups',
  ...(options.override === true ? ['--no-scope-file'] : []),
  '-a',
  ...(options.excludes ?? []),
  ...targets,
]

const cleanApplyArgs = (
  clientRoot: string,
  targets: readonly string[],
  excludes: readonly string[] = [],
): string[] => [
  '--json',
  '--client-root',
  clientRoot,
  '--no-revert-groups',
  '--clean',
  '-a',
  ...excludes,
  ...targets,
]

/** δ's get argv (`_buildP4deltaSyncArgs`). A NORMAL sync takes no `--exclude-*`
 *  at all — its range is the client view, and a one-off exclusion would change
 *  the question asked of native p4 (the CLI refuses the pair outright). */
const syncArgs = (
  clientRoot: string,
  applied: boolean,
  targets: readonly string[],
  options: { readonly spec?: string; readonly override?: boolean } = {},
): string[] => [
  '--json',
  '--client-root',
  clientRoot,
  '--sync',
  ...(options.spec === undefined || options.spec === '#head'
    ? []
    : ['--to', options.spec.slice(1)]),
  ...(applied ? ['-a'] : []),
  ...(options.override === true ? ['--no-scope-file'] : []),
  ...targets,
]

/** The progress ladder a run walked, read off stderr (progress is display-only
 *  and never a stdout record). */
const phasesOf = (run: FakeRun): string[] =>
  run.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { kind: string; phase?: string })
    .filter((record) => record.kind === 'progress')
    .map((record) => record.phase ?? '')

/** p4's per-file refusal lines, re-emitted on δ's stderr: under `--json` they
 *  are the only channel a consumer can learn "p4 refused this file" from. */
const refusalLines = (run: FakeRun): string[] =>
  run.stderr.split(/\r?\n/).filter((line) => line.includes("can't "))

/** The range a run resolved, off the scope log: the caller names targets and δ
 *  resolves them against the client root's config, so the argv alone cannot say
 *  what the config left of them. The fake writes one line per spawn that
 *  resolved a scope, BEFORE it executes — which makes this the surviving
 *  evidence of a run that later failed, and the way to assert a range that
 *  resolved to nothing at all. */
const resolvedScopes = (logs: { readonly scope: string }): ScopeResolution[] =>
  readScopeLog(logs.scope)

/** The one scope a single-spawn test resolved. */
function onlyScope(logs: { readonly scope: string }): ScopeResolution {
  const all = resolvedScopes(logs)
  expect(all, 'the run must have logged exactly one resolved scope').toHaveLength(1)
  return all[0]!
}

/** A config with arbitrary (often malformed) text — the shapes `writeScopeFile`
 *  deliberately cannot produce, because it writes the GOOD config. */
function writeScopeText(clientRoot: string, text: string): string {
  const file = join(clientRoot, '.p4delta-scope')
  writeFileSync(file, text, 'utf8')
  return file
}

// ---- normal sync: δ's own class table ----

test.describe('@p1 p4delta fake contract — normal sync', () => {
  const other: SeedFile = {
    relPath: 'other.txt',
    content: 'have o1\n',
    headRev: 5,
    headContent: 'head o5\n',
  }
  // Locally modified with the noclobber protection on: p4 refuses it, the
  // classic "your draft survives a get" case. The head content differs from the
  // disk on purpose — a force repair walking over the draft is only observable
  // when the two are not the same bytes.
  const refused: SeedFile = {
    relPath: 'refused.txt',
    content: 'draft to keep\n',
    headRev: 3,
    headContent: 'head v3\n',
    haveRev: 1,
    haveContent: 'have v1\n',
    refused: true,
  }
  // Opened for edit and behind: p4 bumps its have and schedules a merge, and
  // never writes a byte of it.
  const opened: SeedFile = {
    relPath: 'opened.txt',
    content: 'have v1\n',
    headRev: 4,
    headContent: 'head v4\n',
    opened: { action: 'edit' },
  }
  test.use({ p4Seeds: { files: [ahead, other, refused, opened] } })

  test('previews per-file revisions, opened files as resolve, refusals on stderr', ({
    p4Workspace,
  }) => {
    const run = runFake(
      syncArgs(p4Workspace.clientRoot, false, [dirTarget(p4Workspace.clientRoot)]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(run.unparsed).toEqual([])
    // The revision is the one p4 answered for THAT file: a preview carrying a
    // single target rev for the whole run could not describe two different
    // heads, and the apply below is built on this list.
    expect(filesOf(run).map((r) => [r['depotFile'], r['class'], r['rev'], r['stage']])).toEqual([
      ['//depot/ahead.txt', 'update', '2', 'preview'],
      ['//depot/other.txt', 'update', '5', 'preview'],
      // p4 answers an opened file with a notice instead of a record, so δ
      // looks its identity up and files it as a `resolve` — a class of its
      // own, with no native word to report.
      ['//depot/opened.txt', 'resolve', '4', 'preview'],
    ])
    expect(filesOf(run)[0]).toMatchObject({ action: 'updating', nativeAction: 'updated' })
    expect(filesOf(run)[2]).not.toHaveProperty('nativeAction')
    expect(refusalLines(run)).toHaveLength(1)
    // p4 prints the local path in its own platform spelling; the assertion stays
    // on the parts that are the CONTRACT (which file, which refusal).
    expect(refusalLines(run)[0]).toContain('//depot/refused.txt')
    expect(refusalLines(run)[0]).toContain("can't update modified file")
    expect(summaryOf(run)).toMatchObject({
      mode: 'sync',
      applied: false,
      force: false,
      total: 3,
      counts: { update: 2, resolve: 1 },
    })
    // A preview moves nothing, not even the file it planned for.
    expect(readFileSync(p4Workspace.file('ahead.txt'), 'utf8')).toBe(ahead.content)
    expect(readFileSync(p4Workspace.file('other.txt'), 'utf8')).toBe('have o1\n')
  })

  test('applies the plan as exact specs: each file lands at its own revision', ({
    p4Workspace,
  }) => {
    const run = runFake(
      syncArgs(p4Workspace.clientRoot, true, [dirTarget(p4Workspace.clientRoot)]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(
      filesOf(run).map((r) => [r['depotFile'], r['class'], r['rev'], r['stage'], r['applied']]),
    ).toEqual([
      ['//depot/ahead.txt', 'update', '2', 'apply', true],
      ['//depot/other.txt', 'update', '5', 'apply', true],
      ['//depot/opened.txt', 'resolve', '4', 'apply', true],
    ])
    expect(readFileSync(p4Workspace.file('ahead.txt'), 'utf8')).toBe('head v2\n')
    expect(readFileSync(p4Workspace.file('other.txt'), 'utf8')).toBe('head o5\n')
    // Neither the refusal nor the opened file may be written: the first keeps
    // the local draft a get has to protect, the second is p4's own "not being
    // changed" — δ reports its have move, not a transfer.
    expect(readFileSync(p4Workspace.file('refused.txt'), 'utf8')).toBe('draft to keep\n')
    expect(readFileSync(p4Workspace.file('opened.txt'), 'utf8')).toBe('have v1\n')
    // Reported ONCE: the refused file is in no apply plan, so p4 is never
    // handed its spec and never mentions it a second time.
    expect(refusalLines(run)).toHaveLength(1)

    const state = JSON.parse(readFileSync(p4Workspace.stateFile, 'utf8')) as {
      opened: Record<string, { rev: number; unresolved?: boolean }>
    }
    expect(state.opened['//depot/opened.txt']).toMatchObject({ rev: 4, unresolved: true })
  })

  test('a normal sync refuses the one-off exclusions, a force repair takes them', ({
    p4Workspace,
  }) => {
    const refused = runFake(
      syncArgs(p4Workspace.clientRoot, false, [dirTarget(p4Workspace.clientRoot)]).concat([
        '--exclude-dir',
        p4Workspace.file('gone'),
      ]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    // Normal sync's range IS the client view: a one-off exclusion would change
    // the question asked of native p4, so the real CLI refuses the pair outright
    // — a parse-stage error, never a quietly re-scoped sync.
    expect(refused.code).toBe(2)
    expect(refused.stdout).toBe('')

    const logs = makeLogs()
    const forced = runFake(
      syncArgs(p4Workspace.clientRoot, false, [dirTarget(p4Workspace.clientRoot)]).concat([
        '--force',
        '--exclude-dir',
        p4Workspace.file('gone'),
      ]),
      { logs },
      p4Workspace.stateFile,
    )
    expect(forced.code).toBe(0)
    expect(onlyScope(logs).mode).toBe('sync')
  })
})

test.describe('@p1 p4delta fake contract', () => {
  test.use({ p4Seeds: { files: [tracked, nested, kept, ahead] } })

  test('answers --version in the clap banner shape', ({ p4Workspace }) => {
    const run = runFake(['--version'], { logs: makeLogs() }, p4Workspace.stateFile)

    expect(run.code).toBe(0)
    // `<crate name> <semver>`, the crate name compiled in — the shape a real
    // p4delta prints. Nothing in the editor reads it any more (the version gate
    // is gone); it is pinned so the fake stays a faithful CLI.
    expect(run.stdout.trim()).toBe('p4delta 0.1.6')
  })

  test('translates a delegated preview into open-mode records and one summary', ({
    p4Workspace,
  }) => {
    const logs = makeLogs()
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const args = scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)])
    const run = runFake(args, { logs }, p4Workspace.stateFile)

    expect(run.code).toBe(0)
    // One file record for the drift, in CLIENT syntax (the spelling the editor's
    // client→local translation is built on), plus the summary.
    expect(run.unparsed).toEqual([])
    expect(filesOf(run)).toEqual([
      expect.objectContaining({
        kind: 'file',
        mode: 'open',
        class: 'edit',
        action: 'edit',
        depotFile: '//depot/tracked.txt',
        clientFile: '//e2e-client/tracked.txt',
        rev: '1',
        applied: false,
      }),
    ])
    expect(Object.keys(summaryOf(run))).toEqual(SUMMARY_KEYS)
    expect(summaryOf(run)).toMatchObject({
      mode: 'open',
      ok: true,
      applied: false,
      total: 1,
      counts: { edit: 1 },
      scopeMatched: 1,
      unmatched: 0,
      reason: null,
    })

    // The delegation must not be visible as a NATIVE reconcile: the native log
    // records "the extension asked p4 itself", and every spec's negative
    // assertion ("the native engine never ran") is built on it staying empty.
    expect(readArgvLog(logs.p4)).toEqual([])
    expect(readArgvLog(logs.delta)).toEqual([args.join(' ')])
    // The spawn's range, and that it was NOT scoped by a config: no config file
    // exists here, so the target alone is the range and there is no implicit
    // self-exclusion to list.
    expect(onlyScope(logs)).toMatchObject({
      mode: 'open',
      status: 'resolved',
      includes: [`directory:${deltaPath(p4Workspace.clientRoot)}`],
      excludes: [],
      scopeFile: null,
    })
  })

  test('reports an apply run and really writes the opened set', ({ p4Workspace }) => {
    const logs = makeLogs()
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      applyArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(summaryOf(run)).toMatchObject({ ok: true, applied: true, counts: { edit: 1 } })
    expect(filesOf(run)[0]).toMatchObject({ applied: true })

    // The one world both fakes share: the state the native fake reads back as
    // `p4 opened`, written by the delegation's `reconcile -a`.
    const state = JSON.parse(readFileSync(p4Workspace.stateFile, 'utf8')) as {
      opened: Record<string, { action: string; change: string }>
    }
    expect(state.opened['//depot/tracked.txt']).toEqual(
      expect.objectContaining({ action: 'edit', change: 'default' }),
    )
  })

  test('cleans the workspace with the clean class table', ({ p4Workspace }) => {
    const logs = makeLogs()
    // One of each class the clean mode distinguishes: an edited file (revert), a
    // file deleted on disk (restore), and a disk-only file (delete).
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    rmSync(p4Workspace.file('kept.txt'))
    writeFileSync(p4Workspace.file('scratch.txt'), 'never in the depot\n', 'utf8')

    const run = runFake(
      cleanApplyArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(run.unparsed).toEqual([])
    const byClass = Object.fromEntries(filesOf(run).map((r) => [r['class'], r['action']]))
    expect(byClass).toEqual({ revert: 'reverting', restore: 'restoring', delete: 'deleting' })
    expect(summaryOf(run)).toMatchObject({
      mode: 'clean',
      ok: true,
      applied: true,
      counts: { revert: 1, restore: 1, delete: 1 },
    })
    // The clean really moved the disk: the drift came back to its have revision,
    // the missing file came back, the disk-only file is gone.
    expect(readFileSync(p4Workspace.file('tracked.txt'), 'utf8')).toBe(tracked.content)
    expect(readFileSync(p4Workspace.file('kept.txt'), 'utf8')).toBe(kept.content)
    expect(() => readFileSync(p4Workspace.file('scratch.txt'), 'utf8')).toThrow()

    // A clean preview must not touch the disk either — and it must not be
    // delegated to the child's `clean`, which has no dry run.
    const preview = runFake(
      [
        '--json',
        '--client-root',
        p4Workspace.clientRoot,
        '--no-revert-groups',
        '--clean',
        dirTarget(p4Workspace.clientRoot),
      ],
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )
    expect(preview.code).toBe(0)
    expect(summaryOf(preview)).toMatchObject({ applied: false, counts: {} })
  })

  test('syncs the range to the head revision, preview then apply', ({ p4Workspace }) => {
    const logs = makeLogs()
    const target = dirTarget(p4Workspace.clientRoot)
    const preview = runFake(
      syncArgs(p4Workspace.clientRoot, false, [target]),
      { logs },
      p4Workspace.stateFile,
    )

    expect(filesOf(preview)).toEqual([
      expect.objectContaining({
        mode: 'sync',
        class: 'update',
        action: 'updating',
        depotFile: '//depot/ahead.txt',
        applied: false,
        stage: 'preview',
      }),
    ])
    expect(summaryOf(preview)).toMatchObject({
      mode: 'sync',
      applied: false,
      counts: { update: 1 },
    })
    // A preview must not move the disk; the apply must land exactly the head
    // content — with `--to` absent that is `#head`.
    expect(readFileSync(p4Workspace.file('ahead.txt'), 'utf8')).toBe(ahead.content)

    const applied = runFake(
      syncArgs(p4Workspace.clientRoot, true, [target]),
      { logs },
      p4Workspace.stateFile,
    )
    expect(summaryOf(applied)).toMatchObject({ mode: 'sync', ok: true, applied: true })
    expect(filesOf(applied)[0]).toMatchObject({ applied: true, stage: 'apply' })
    expect(readFileSync(p4Workspace.file('ahead.txt'), 'utf8')).toBe(ahead.headContent)
  })

  // Nothing to do: δ stops after the preview — no apply segment, no second p4
  // call, and the summary still reports the `applied` run it was asked for. The
  // ladder is how a consumer tells this apart from a run that died before it
  // wrote anything.
  test('an up-to-date apply walks no apply segment and reports no records', ({ p4Workspace }) => {
    const run = runFake(
      syncArgs(p4Workspace.clientRoot, true, [fileTarget(p4Workspace.file('tracked.txt'))]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(filesOf(run)).toEqual([])
    expect(phasesOf(run)).toEqual(['start', 'preview', 'filter', 'done'])
    expect(summaryOf(run)).toMatchObject({
      ok: true,
      applied: true,
      force: false,
      total: 0,
      counts: {},
    })
  })

  test('reports entries that matched nothing as a complete answer, exit 1', ({ p4Workspace }) => {
    const vanished = join(p4Workspace.clientRoot, 'nowhere')
    const run = runFake(
      ['--json', '--client-root', p4Workspace.clientRoot, dirTarget(vanished)],
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(1)
    // The path is reported in its parsed form (the `/...` suffix is not part of
    // an entry's identity), which is what a consumer matches against.
    expect(run.records).toContainEqual({ kind: 'unmatched', path: deltaPath(vanished) })
    expect(summaryOf(run)).toMatchObject({
      ok: false,
      total: 0,
      counts: {},
      scopeMatched: 0,
      unmatched: 1,
      reason: 'no-entry-matched',
    })
  })

  test('rejects an unknown argument with exit 2, and records the spawn first', ({
    p4Workspace,
  }) => {
    const logs = makeLogs()
    const run = runFake(['--json', '--no-such-flag'], { logs }, p4Workspace.stateFile)

    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('--no-such-flag')
    // The argv log is written before parsing precisely so a parse-stage death is
    // still attributable — a spec asserting "zero spawn" must not be fooled by a
    // run that died before doing anything.
    expect(readArgvLog(logs.delta)).toEqual(['--json --no-such-flag'])
  })

  // ---- fault injection: one case per mode --------------------------------

  test('crash: partial records, no summary, exit 1', ({ p4Workspace }) => {
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { fail: 'crash', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(1)
    // Records got out before the process died — the exact stream hard rule 1 is
    // about (a partial stream is never a conclusion).
    expect(filesOf(run).length).toBeGreaterThan(0)
    expect(run.records.some((r) => r['kind'] === 'summary')).toBe(false)
  })

  test('crash-scan: previews crash, writes keep working', ({ p4Workspace }) => {
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const logs = makeLogs()
    const target = dirTarget(p4Workspace.clientRoot)
    const preview = runFake(
      scanArgs(p4Workspace.clientRoot, [target]),
      { fail: 'crash-scan', logs },
      p4Workspace.stateFile,
    )
    expect(preview.code).toBe(1)
    expect(preview.records.some((r) => r['kind'] === 'summary')).toBe(false)

    // `-a` is what makes it a write: the same fault must leave those alone, so a
    // spec can break the scan path without also breaking the write path.
    const applied = runFake(
      applyArgs(p4Workspace.clientRoot, [target]),
      { fail: 'crash-scan', logs },
      p4Workspace.stateFile,
    )
    expect(applied.code).toBe(0)
    expect(summaryOf(applied)).toMatchObject({ ok: true, applied: true })
  })

  test('nosummary: a complete-looking stream that concludes nothing', ({ p4Workspace }) => {
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { fail: 'nosummary', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(filesOf(run)).toHaveLength(1)
    expect(run.records.some((r) => r['kind'] === 'summary')).toBe(false)
  })

  test('exit2: usage error at the parse stage', ({ p4Workspace }) => {
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { fail: 'exit2', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
  })

  test('error: ok:false with the catch-all reason', ({ p4Workspace }) => {
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { fail: 'error', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(1)
    expect(run.records.some((r) => r['kind'] === 'error')).toBe(true)
    expect(summaryOf(run)).toMatchObject({ ok: false, reason: 'error', counts: { edit: 1 } })
  })

  test('unmatched: every entry reported empty, exit 1', ({ p4Workspace }) => {
    // The target EXISTS on disk — the fault forces the empty answer, which is
    // the point: it is the one ok:false shape a consumer may read as complete.
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { fail: 'unmatched', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(1)
    expect(filesOf(run)).toEqual([])
    expect(summaryOf(run)).toMatchObject({
      ok: false,
      scopeMatched: 0,
      unmatched: 1,
      reason: 'no-entry-matched',
    })
  })

  test('an unknown fault mode is a usage error, never a silent pass', ({ p4Workspace }) => {
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { fail: 'craash', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('craash')
  })
})

// ---- the scope CONFIG: the one persistent range ---------------------------

test.describe('@p1 p4delta fake contract — scope config', () => {
  const stray: SeedFile = { relPath: 'src/keep.txt', content: 'have keep\n' }
  const excluded: SeedFile = { relPath: 'docs/skip.txt', content: 'have skip\n' }
  test.use({ p4Seeds: { files: [stray, excluded] } })

  test('the config’s include and exclude decide the range, and it excludes itself', ({
    p4Workspace,
  }) => {
    const logs = makeLogs()
    writeScopeFile(p4Workspace.clientRoot, ['src'], ['docs'])
    writeFileSync(p4Workspace.file('src/keep.txt'), 'drifted in src\n', 'utf8')
    writeFileSync(p4Workspace.file('docs/skip.txt'), 'drifted in docs\n', 'utf8')

    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    // The exclusion is the CONFIG's, not the argv's: the excluded subtree's drift
    // is not in the answer, which is what proves the entry was honoured.
    expect(filesOf(run).map((r) => r['depotFile'])).toEqual(['//depot/src/keep.txt'])
    expect(summaryOf(run)).toMatchObject({ ok: true, total: 1, scopeMatched: 1, unmatched: 0 })

    // The range the run worked over, as the engine logged it: the config narrowed
    // the target to `src`, and the config file excludes ITSELF — it sits inside
    // the work tree, so a scan that did not skip it would report it as a new file
    // (and a clean would delete it).
    expect(onlyScope(logs)).toEqual({
      kind: 'scope-resolution',
      mode: 'open',
      status: 'resolved',
      includes: [`directory:${deltaPath(p4Workspace.file('src'))}`],
      excludes: [
        `directory:${deltaPath(p4Workspace.file('docs'))}`,
        `file:${deltaPath(p4Workspace.file('.p4delta-scope'))}`,
      ],
      targets: [`directory:${deltaPath(p4Workspace.clientRoot)}`],
      scopeFile: deltaPath(p4Workspace.file('.p4delta-scope')),
    })
  })

  test('a range that intersects to nothing is an error, never a wider range', ({ p4Workspace }) => {
    const logs = makeLogs()
    writeScopeFile(p4Workspace.clientRoot, ['src'])
    const outside = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.file('docs'))]),
      { logs },
      p4Workspace.stateFile,
    )

    // The real tool's bail: nothing was resolved to execute over, so there is no
    // file record at all — only the error and an `ok:false` summary. It never
    // falls back to the workspace, and never to the config's own includes.
    expect(outside.code).toBe(1)
    expect(outside.records.map((r) => r['kind'])).toEqual(['error', 'summary'])
    expect(summaryOf(outside)).toMatchObject({ ok: false, reason: 'error', total: 0 })
    // …and the range it resolved is still on the record, empty: "the config left
    // nothing here", not "the engine never got that far".
    expect(onlyScope(logs)).toMatchObject({
      status: 'empty',
      includes: [],
      targets: [`directory:${deltaPath(p4Workspace.file('docs'))}`],
    })

    // `include: []` is the explicit empty set — an operation over it is refused
    // exactly the same way, INCLUDING when the target itself would be covered.
    writeScopeText(p4Workspace.clientRoot, JSON.stringify({ include: [] }))
    const explicit = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )
    expect(explicit.code).toBe(1)
    expect(summaryOf(explicit)).toMatchObject({ ok: false, reason: 'error' })
  })

  test('no config and no target is refused, never defaulted to the whole client', ({
    p4Workspace,
  }) => {
    const run = runFake(
      ['--json', '--client-root', p4Workspace.clientRoot],
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    // A range given by nobody is the one default that must not exist: under
    // `--clean -a` "the whole client" is destructive, and the caller clearly
    // meant to name something.
    expect(run.code).toBe(1)
    expect(run.records.map((r) => r['kind'])).toEqual(['error', 'summary'])
    expect(String(run.records[0]!['message'])).toContain('No path given')
    expect(summaryOf(run)).toMatchObject({ ok: false, reason: 'error' })
  })

  test('a broken config is refused, never read as "no config"', ({ p4Workspace }) => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['not JSON at all', 'nope', 'not valid JSON'],
      ['a non-object body', '[]', 'expected a JSON object'],
      // A misspelled `exclude` is the silent-widening shape: the team believes a
      // subtree is excluded and it is walked instead.
      ['an unknown key', JSON.stringify({ noise: [] }), 'unknown field "noise"'],
      ['a wrong include type', JSON.stringify({ include: { dir: 'src' } }), 'must be an array'],
      ['a null include', JSON.stringify({ include: null }), 'must be an array'],
      [
        'an entry with two kinds',
        JSON.stringify({ include: [{ dir: 'a', file: 'b' }] }),
        'exactly one of "dir" or "file"',
      ],
      [
        'an absolute entry',
        JSON.stringify({ include: [{ dir: '/etc' }] }),
        'relative to the client',
      ],
      [
        'an entry leaving the root',
        JSON.stringify({ include: [{ dir: '../x' }] }),
        'leaves the client root',
      ],
      [
        'a backslash entry',
        JSON.stringify({ include: [{ dir: 'a\\b' }] }),
        'must use "/" separators',
      ],
      [
        'a recursive suffix',
        JSON.stringify({ include: [{ dir: 'src/...' }] }),
        'recursive wildcard',
      ],
      // `JSON.parse` alone keeps the LAST of two identical keys while both real
      // parsers refuse the config outright, so the deep-equal JSON check is not
      // enough: the raw text has to be scanned.
      [
        'a repeated key',
        '{"include": [{"dir": "a"}], "include": [{"dir": "b"}]}',
        'duplicate key "include"',
      ],
    ]

    for (const [label, text, fragment] of cases) {
      writeScopeText(p4Workspace.clientRoot, text)
      const run = runFake(
        scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
        { logs: makeLogs() },
        p4Workspace.stateFile,
      )
      expect(run.code, label).toBe(1)
      expect(
        run.records.map((r) => r['kind']),
        label,
      ).toEqual(['error', 'summary'])
      // The refusal names what is wrong, not just "the config is bad": the whole
      // rule exists for a hand-edited config a team shares.
      expect(String(run.records[0]!['message']), label).toContain(fragment)
      expect(summaryOf(run), label).toMatchObject({ ok: false, reason: 'error' })
    }

    // …and it names the offending ENTRY, so a long config says which line.
    writeScopeText(p4Workspace.clientRoot, JSON.stringify({ include: [{ file: '../escape' }] }))
    const named = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )
    const message = String(named.records[0]!['message'])
    expect(message).toContain('include[0]')
    expect(message).toContain('leaves the client root')
  })

  test('a config entry outside the root is refused, not silently dropped', ({ p4Workspace }) => {
    // A `..` walk that starts above the root would name a directory this client
    // cannot see; dropping the entry instead would WIDEN the range.
    writeScopeText(p4Workspace.clientRoot, JSON.stringify({ exclude: [{ dir: 'a/../../x' }] }))
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(1)
    expect(String(run.records[0]!['message'])).toContain('exclude[0]')
    expect(summaryOf(run)).toMatchObject({ ok: false, reason: 'error' })
  })

  test('--no-scope-file drops the config only: the target still decides the range', ({
    p4Workspace,
  }) => {
    const logs = makeLogs()
    writeScopeFile(p4Workspace.clientRoot, ['src'], ['docs'])
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.file('docs'))], []).concat([
        '--no-scope-file',
      ]),
      { logs },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    // The config would have excluded `docs` (and its include would have left the
    // target empty); with the config dropped, the target is the range and there
    // is no implicit self-exclusion to list. The config file's own path is NOT
    // special-cased away either — with no config in play it is an ordinary path
    // inside the range.
    expect(onlyScope(logs)).toMatchObject({
      status: 'resolved',
      includes: [`directory:${deltaPath(p4Workspace.file('docs'))}`],
      excludes: [],
      scopeFile: null,
    })
  })

  // ---- the run's OWN exclusions (the reconcile-noise side) ----------------

  test('the run’s exclusions union with the config’s, config first', ({ p4Workspace }) => {
    const logs = makeLogs()
    // The config excludes `docs`; the run adds a directory that does not exist
    // locally and a FILE exclusion — the caller declares the kind through the
    // flag, so δ must not stat for it (a "file" reading would only hide the path
    // itself, never the subtree under it).
    writeScopeFile(p4Workspace.clientRoot, undefined, ['docs'])
    const ghost = join(p4Workspace.clientRoot, 'ghost')
    const run = runFake(
      scanArgs(
        p4Workspace.clientRoot,
        [dirTarget(p4Workspace.clientRoot)],
        ['--exclude-file', p4Workspace.file('src/keep.txt'), '--exclude-dir', ghost],
      ),
      { logs },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(onlyScope(logs)).toMatchObject({
      status: 'resolved',
      // …the UNION, in the contract's order: the config's entries, then the
      // run's (directories as a block, then files — the kind is a flag
      // grouping), then the config file's own implicit entry.
      excludes: [
        `directory:${deltaPath(p4Workspace.file('docs'))}`,
        `directory:${deltaPath(ghost)}`,
        `file:${deltaPath(p4Workspace.file('src/keep.txt'))}`,
        `file:${deltaPath(p4Workspace.file('.p4delta-scope'))}`,
      ],
    })
  })

  test('the run’s exclusions really prune the run, not just the log', ({ p4Workspace }) => {
    writeScopeFile(p4Workspace.clientRoot, undefined, ['docs'])
    writeFileSync(p4Workspace.file('src/keep.txt'), 'drifted in src\n', 'utf8')
    writeFileSync(p4Workspace.file('docs/skip.txt'), 'drifted in docs\n', 'utf8')

    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [dirTarget(p4Workspace.clientRoot)]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    // The scan's records answer for `src` alone. A fake that dropped the config
    // exclusions (the silent-widening failure) would list the docs drift here.
    expect(filesOf(run).map((r) => r['depotFile'])).toEqual(['//depot/src/keep.txt'])
  })

  test('an exclusion that swallows the whole target is an error, not a wider range', ({
    p4Workspace,
  }) => {
    writeScopeFile(p4Workspace.clientRoot)
    const run = runFake(
      scanArgs(
        p4Workspace.clientRoot,
        [dirTarget(p4Workspace.file('src'))],
        ['--exclude-dir', p4Workspace.file('src')],
      ),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    // The exclusion wins over the target, so the intersection is empty — and an
    // empty range is a refusal. Reporting it as "nothing to do" would look like
    // an ordinary answer for a run the caller scoped wrongly.
    expect(run.code).toBe(1)
    expect(run.records.map((r) => r['kind'])).toEqual(['error', 'summary'])
    expect(summaryOf(run)).toMatchObject({ ok: false, reason: 'error' })
  })

  test('an APPLIED run never walks inside an excluded directory — open and clean both', ({
    p4Workspace,
  }) => {
    // Drift on both sides, in both directions: an edit and a disk-only file. The
    // excluded subtree is where a write would show first if the fake handed the
    // union to the child and filtered its answer afterwards — `reconcile -a`
    // opens as it walks, and `clean -a` DELETES disk-only files as it walks.
    const driftedOutside = 'outside drift\n'
    const driftedInside = 'inside drift\n'
    const scratchInside = 'disk-only inside\n'
    const writeAll = (): void => {
      writeFileSync(p4Workspace.file('src/keep.txt'), driftedOutside, 'utf8')
      writeFileSync(p4Workspace.file('docs/skip.txt'), driftedInside, 'utf8')
      writeFileSync(p4Workspace.file('docs/scratch.txt'), scratchInside, 'utf8')
    }
    const openedNow = (): string[] =>
      Object.keys(
        (
          JSON.parse(readFileSync(p4Workspace.stateFile, 'utf8')) as {
            opened: Record<string, unknown>
          }
        ).opened,
      ).sort()
    const root = (): string => dirTarget(p4Workspace.clientRoot)

    // The config excludes `docs`; no argv exclusion is involved, which is the
    // point: the persistent boundary has to hold on its own.
    writeScopeFile(p4Workspace.clientRoot, undefined, ['docs'])

    writeAll()
    const cleanRun = runFake(
      cleanApplyArgs(p4Workspace.clientRoot, [root()]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )
    expect(cleanRun.code).toBe(0)
    // The clean answers for the visible level and nothing under `docs`…
    expect(filesOf(cleanRun).map((r) => r['depotFile'])).toEqual(['//depot/src/keep.txt'])
    // …its drift came back to the have revision…
    expect(readFileSync(p4Workspace.file('src/keep.txt'), 'utf8')).toBe(stray.content)
    // …while the excluded subtree kept BOTH its drift and its disk-only file
    // (a `clean -a` that walked it would have destroyed the draft).
    expect(readFileSync(p4Workspace.file('docs/skip.txt'), 'utf8')).toBe(driftedInside)
    expect(readFileSync(p4Workspace.file('docs/scratch.txt'), 'utf8')).toBe(scratchInside)

    writeAll()
    // The clean swept the client root's OWN level, and that level spec
    // (`<root>/*`) still matches the unversioned config file: p4 has no negating
    // spec, so the carve's documented residual reaches the file the exclusion
    // names at that level even though the RECORDS filter it out. The step below is
    // about the open write, and a run whose config had just been swept would be a
    // different (wider) range — so the config is written again, deliberately.
    writeScopeFile(p4Workspace.clientRoot, undefined, ['docs'])
    const openRun = runFake(
      applyArgs(p4Workspace.clientRoot, [root()]),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )
    expect(openRun.code).toBe(0)
    expect(filesOf(openRun).map((r) => r['depotFile'])).toEqual(['//depot/src/keep.txt'])
    // The opened set the native fake answers `p4 opened` from: the visible drift
    // alone. Post-filtering the answer would have left `docs/skip.txt` in here —
    // the write happens on the way through, not in the records.
    //
    // The config file IS in there — the same carve residual as above, now in its
    // other direction: `<root>/*` is what reaches the files beside it, and p4 has
    // no negating spec, so an unversioned file at that level is opened even though
    // the RECORDS hide it. What must stay out is the excluded subtree, and it
    // does: neither its drift nor its disk-only file was opened.
    expect(openedNow()).toEqual(['//depot/.p4delta-scope', '//depot/src/keep.txt'])
    expect(readFileSync(p4Workspace.file('docs/scratch.txt'), 'utf8')).toBe(scratchInside)
  })

  test('an unknown --exclude flag is a usage error, never a dropped exclusion', ({
    p4Workspace,
  }) => {
    writeScopeFile(p4Workspace.clientRoot, ['src'])
    const run = runFake(
      scanArgs(
        p4Workspace.clientRoot,
        [dirTarget(p4Workspace.clientRoot)],
        ['--exclude', p4Workspace.file('docs')],
      ),
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )

    // "excluded" and "not excluded" differ by a whole subtree, so a flag the
    // engine does not know must fail the run rather than be skipped: a silently
    // ignored exclusion is a silently widened range.
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
  })
})
