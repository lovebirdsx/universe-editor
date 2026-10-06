/*---------------------------------------------------------------------------------------------
 *  The δ fake's own contract.
 *
 *  Every editor-facing p4delta assertion in this suite rests on what the fake
 *  ANSWERS, so the fake itself is pinned here: record shapes, exit codes, the
 *  scope/exclusion accounting, the summary field set, and every fault mode.
 *
 *  Deliberately WITHOUT Electron, and that is the point: all the fault shapes
 *  get real assertions for milliseconds here, while the specs that need editor
 *  behaviour (scan / writes / fallback) pay for one cold launch each. The script
 *  is spawned exactly the way the extension spawns it — `process.execPath
 *  <script>` over the `.mjs` override — against the same seeded state file the
 *  Electron specs use, so the shapes asserted here are the shapes they see.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { readArgvLog, test, expect } from '../fixtures/perforceApp.js'
import type { SeedFile } from '../fixtures/perforceApp.js'

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
function makeLogs(): { delta: string; p4: string } {
  return {
    delta: join(mkTempDir('ue2-p4delta-argv-'), 'argv.log'),
    p4: join(mkTempDir('ue2-p4-argv-'), 'argv.log'),
  }
}

/** One spawn of the fake, the way P4deltaService does it: the script through the
 *  current Node runtime, the state and the two log seams through the env. */
function runFake(
  args: readonly string[],
  opts: {
    readonly fail?: string
    readonly logs: { delta: string; p4: string }
    /** Extra env for the run — the legacy-build knob and nothing else so far. */
    readonly env?: Record<string, string>
  },
  stateFile: string,
): FakeRun {
  const res = spawnSync(process.execPath, [FAKE_P4DELTA, ...args], {
    env: {
      ...process.env,
      UNIVERSE_P4_FAKE_STATE: stateFile,
      UNIVERSE_P4DELTA_ARGV_LOG: opts.logs.delta,
      UNIVERSE_P4_FAKE_ARGV_LOG: opts.logs.p4,
      ...(opts.fail !== undefined ? { UNIVERSE_P4DELTA_FAKE_FAIL: opts.fail } : {}),
      ...opts.env,
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

/** The engine's SCAN argv, spelled exactly like the extension spells it
 *  (`_buildP4deltaScanArgs`): the contract switches, then the scope after `--`. */
const scanArgs = (clientRoot: string, entries: readonly string[]): string[] => [
  '--json',
  '--no-scope-file',
  '--client-root',
  clientRoot,
  '--no-revert-groups',
  '--',
  ...entries,
]

/** δ's normal sync, spelled the way the extension spells it: the contract
 *  switches, then the scope after `--`. */
const syncArgs = (clientRoot: string, applied: boolean, entries: readonly string[]): string[] => [
  '--json',
  '--no-scope-file',
  '--client-root',
  clientRoot,
  '--sync',
  ...(applied ? ['-a'] : []),
  '--',
  ...entries,
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

/** The same call one switch later: `-a` turns the preview into the write. */
const applyArgs = (clientRoot: string, entries: readonly string[]): string[] => [
  '--json',
  '--no-scope-file',
  '--client-root',
  clientRoot,
  '--no-revert-groups',
  '-a',
  '--',
  ...entries,
]

// ---- normal sync: δ's own class table, and the build that predates it ----

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

  const wholeScope = (root: string): string => `${root}/...`

  test('previews per-file revisions, opened files as resolve, refusals on stderr', ({
    p4Workspace,
  }) => {
    const run = runFake(
      syncArgs(p4Workspace.clientRoot, false, [wholeScope(p4Workspace.clientRoot)]),
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
    expect(refusalLines(run)).toEqual([
      // p4 prints the local path in its own platform spelling; `p4Workspace.file`
      // hands out the forward-slash form, so normalize before comparing.
      `//depot/refused.txt#3 - can't update modified file ${resolve(
        p4Workspace.file('refused.txt'),
      )}`,
    ])
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
      syncArgs(p4Workspace.clientRoot, true, [wholeScope(p4Workspace.clientRoot)]),
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

  // The build the editor must NOT drive at all: it reports 0.1.5, below the
  // minimum, and its `--sync` IS the force repair (the split flag did not exist
  // yet). These are the shapes a consumer would have to refuse; the version gate
  // means none of them is ever reached.
  test.describe('a pre-split build', () => {
    const env = { UNIVERSE_P4DELTA_FAKE_LEGACY: '1' }

    test('reports 0.1.5, the version the probe rejects', ({ p4Workspace }) => {
      const version = runFake(['--version'], { logs: makeLogs(), env }, p4Workspace.stateFile)
      expect(version.code).toBe(0)
      expect(version.stdout.trim()).toBe('p4delta 0.1.5')

      // Fidelity: the pre-split build's help does not list `--force`, and its
      // parser does not know the flag (clap's exit 2).
      const help = runFake(['--help'], { logs: makeLogs(), env }, p4Workspace.stateFile)
      expect(help.code).toBe(0)
      expect(help.stdout).not.toContain('--force')

      const forced = runFake(
        ['--json', '--force', '--sync', '--', wholeScope(p4Workspace.clientRoot)],
        { logs: makeLogs(), env },
        p4Workspace.stateFile,
      )
      expect(forced.code).toBe(2)
    })

    test('runs --sync as the force repair, over the draft a get would keep', ({ p4Workspace }) => {
      const run = runFake(
        syncArgs(p4Workspace.clientRoot, true, [wholeScope(p4Workspace.clientRoot)]),
        { logs: makeLogs(), env },
        p4Workspace.stateFile,
      )

      expect(run.code).toBe(0)
      expect(summaryOf(run)).toMatchObject({
        mode: 'sync',
        ok: true,
        applied: true,
        force: true,
      })
      // Every record carries the flag and none carries a stage: this is a
      // repair, and no reader may take it for the preview/apply pipeline.
      for (const record of filesOf(run)) {
        expect(record['force']).toBe(true)
        expect(record).not.toHaveProperty('stage')
      }
      // The reason the gate exists: the legacy `--sync` walks over the local
      // draft a normal get is supposed to protect.
      expect(readFileSync(p4Workspace.file('refused.txt'), 'utf8')).toBe('head v3\n')
    })
  })
})

test.describe('@p1 p4delta fake contract', () => {
  test.use({ p4Seeds: { files: [tracked, nested, kept, ahead] } })

  test('answers --version with the version the probe admits it by', ({ p4Workspace }) => {
    const run = runFake(['--version'], { logs: makeLogs() }, p4Workspace.stateFile)

    expect(run.code).toBe(0)
    // `probeP4delta` reads exactly this line — clap's `<crate name> <semver>`,
    // the crate name compiled in — so the shape is pinned here: a fake that
    // renamed itself (or dropped below the minimum) would silently keep every
    // δ journey running on p4.
    expect(run.stdout.trim()).toBe('p4delta 0.1.6')
  })

  test('translates a delegated preview into open-mode records and one summary', ({
    p4Workspace,
  }) => {
    const logs = makeLogs()
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
      { logs },
      p4Workspace.stateFile,
    )

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
    expect(readArgvLog(logs.delta)).toEqual([
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]).join(' '),
    ])
  })

  test('reports an apply run and really writes the opened set', ({ p4Workspace }) => {
    const logs = makeLogs()
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      applyArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
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

  test('hands every exclusion over in one call and withholds the excluded subtree', ({
    p4Workspace,
  }) => {
    const logs = makeLogs()
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    writeFileSync(p4Workspace.file('gone/nested.txt'), 'edited in an excluded dir\n', 'utf8')
    const excluded = `${p4Workspace.clientRoot}/gone/...`
    const entries = [`${p4Workspace.clientRoot}/...`, `-${excluded}`]
    const run = runFake(scanArgs(p4Workspace.clientRoot, entries), { logs }, p4Workspace.stateFile)

    // The excluded drift is not in the answer (δ applies exclusions itself, so a
    // caller that carved the scope would answer a DIFFERENT question — this is
    // what proves the entry was honoured).
    expect(filesOf(run)).toEqual([expect.objectContaining({ depotFile: '//depot/tracked.txt' })])
    expect(summaryOf(run)).toMatchObject({ total: 1, scopeMatched: 1, unmatched: 0 })

    // …and the entry rode along verbatim, spelled as an exclusion. A dropped
    // separator or a missing entry shows up here, not in the record stream (the
    // delegated child was asked for the union either way).
    expect(readArgvLog(logs.delta)).toEqual([scanArgs(p4Workspace.clientRoot, entries).join(' ')])
  })

  test('cleans the workspace with the clean class table', ({ p4Workspace }) => {
    const logs = makeLogs()
    // One of each class the clean mode distinguishes: an edited file (revert), a
    // file deleted on disk (restore), and a disk-only file (delete).
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    rmSync(p4Workspace.file('kept.txt'))
    writeFileSync(p4Workspace.file('scratch.txt'), 'never in the depot\n', 'utf8')

    const run = runFake(
      [
        '--json',
        '--no-scope-file',
        '--client-root',
        p4Workspace.clientRoot,
        '--no-revert-groups',
        '--clean',
        '-a',
        '--',
        `${p4Workspace.clientRoot}/...`,
      ],
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
        '--no-scope-file',
        '--client-root',
        p4Workspace.clientRoot,
        '--no-revert-groups',
        '--clean',
        '--',
        `${p4Workspace.clientRoot}/...`,
      ],
      { logs: makeLogs() },
      p4Workspace.stateFile,
    )
    expect(preview.code).toBe(0)
    expect(summaryOf(preview)).toMatchObject({ applied: false, counts: {} })
  })

  test('syncs the scope to the head revision, preview then apply', ({ p4Workspace }) => {
    const logs = makeLogs()
    const entry = `${p4Workspace.clientRoot}/...`
    const preview = runFake(
      syncArgs(p4Workspace.clientRoot, false, [entry]),
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
      syncArgs(p4Workspace.clientRoot, true, [entry]),
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
    const only = `${p4Workspace.clientRoot}/tracked.txt`
    const run = runFake(
      syncArgs(p4Workspace.clientRoot, true, [only]),
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
    const vanished = `${p4Workspace.clientRoot}/nowhere/...`
    const run = runFake(['--json', '--', vanished], { logs: makeLogs() }, p4Workspace.stateFile)

    expect(run.code).toBe(1)
    // The path is reported in its parsed form (the `/...` suffix is not part of
    // an entry's identity), which is what a consumer matches against.
    expect(run.records).toContainEqual({
      kind: 'unmatched',
      path: `${p4Workspace.clientRoot}/nowhere`,
    })
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
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
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
    const preview = runFake(
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
      { fail: 'crash-scan', logs },
      p4Workspace.stateFile,
    )
    expect(preview.code).toBe(1)
    expect(preview.records.some((r) => r['kind'] === 'summary')).toBe(false)

    // `-a` is what makes it a write: the same fault must leave those alone, so a
    // spec can break the scan path without also breaking the write path.
    const applied = runFake(
      [
        '--json',
        '--no-scope-file',
        '--client-root',
        p4Workspace.clientRoot,
        '--no-revert-groups',
        '-a',
        '--',
        `${p4Workspace.clientRoot}/...`,
      ],
      { fail: 'crash-scan', logs },
      p4Workspace.stateFile,
    )
    expect(applied.code).toBe(0)
    expect(summaryOf(applied)).toMatchObject({ ok: true, applied: true })
  })

  test('nosummary: a complete-looking stream that concludes nothing', ({ p4Workspace }) => {
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
      { fail: 'nosummary', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(0)
    expect(filesOf(run)).toHaveLength(1)
    expect(run.records.some((r) => r['kind'] === 'summary')).toBe(false)
  })

  test('exit2: usage error at the parse stage', ({ p4Workspace }) => {
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
      { fail: 'exit2', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
  })

  test('error: ok:false with the catch-all reason', ({ p4Workspace }) => {
    writeFileSync(p4Workspace.file('tracked.txt'), 'edited on disk\n', 'utf8')
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
      { fail: 'error', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(1)
    expect(run.records.some((r) => r['kind'] === 'error')).toBe(true)
    expect(summaryOf(run)).toMatchObject({ ok: false, reason: 'error', counts: { edit: 1 } })
  })

  test('unmatched: every entry reported empty, exit 1', ({ p4Workspace }) => {
    // The scope entry EXISTS on disk — the fault forces the empty answer, which
    // is the point: it is the one ok:false shape a consumer may read as complete.
    const run = runFake(
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
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
      scanArgs(p4Workspace.clientRoot, [`${p4Workspace.clientRoot}/...`]),
      { fail: 'craash', logs: makeLogs() },
      p4Workspace.stateFile,
    )

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('craash')
  })
})
