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
  opts: { readonly fail?: string; readonly logs: { delta: string; p4: string } },
  stateFile: string,
): FakeRun {
  const res = spawnSync(process.execPath, [FAKE_P4DELTA, ...args], {
    env: {
      ...process.env,
      UNIVERSE_P4_FAKE_STATE: stateFile,
      UNIVERSE_P4DELTA_ARGV_LOG: opts.logs.delta,
      UNIVERSE_P4_FAKE_ARGV_LOG: opts.logs.p4,
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
      // `--help` is human text on purpose; a JSON run leaves this empty.
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

test.describe('@p1 p4delta fake contract', () => {
  test.use({ p4Seeds: { files: [tracked, nested, kept, ahead] } })

  test('answers --help with the two switches the probe admits it by', ({ p4Workspace }) => {
    const run = runFake(['--help'], { logs: makeLogs() }, p4Workspace.stateFile)

    expect(run.code).toBe(0)
    // `probeP4delta` refuses any executable whose help does not mention BOTH:
    // `--json` is the contract, `--client-root` the round-trip saver.
    expect(run.stdout).toContain('--json')
    expect(run.stdout).toContain('--client-root')
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
    expect(filesOf(run)).toEqual([
      expect.objectContaining({ depotFile: '//depot/tracked.txt' }),
    ])
    expect(summaryOf(run)).toMatchObject({ total: 1, scopeMatched: 1, unmatched: 0 })

    // …and the entry rode along verbatim, spelled as an exclusion. A dropped
    // separator or a missing entry shows up here, not in the record stream (the
    // delegated child was asked for the union either way).
    expect(readArgvLog(logs.delta)).toEqual([
      scanArgs(p4Workspace.clientRoot, entries).join(' '),
    ])
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
    const syncArgs = (applied: boolean): string[] => [
      '--json',
      '--no-scope-file',
      '--client-root',
      p4Workspace.clientRoot,
      '--no-revert-groups',
      '--sync',
      ...(applied ? ['-a'] : []),
      '--',
      entry,
    ]
    const preview = runFake(syncArgs(false), { logs }, p4Workspace.stateFile)

    expect(filesOf(preview)).toEqual([
      expect.objectContaining({
        mode: 'sync',
        class: 'update',
        action: 'updating',
        depotFile: '//depot/ahead.txt',
        applied: false,
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

    const applied = runFake(syncArgs(true), { logs }, p4Workspace.stateFile)
    expect(summaryOf(applied)).toMatchObject({ mode: 'sync', ok: true, applied: true })
    expect(readFileSync(p4Workspace.file('ahead.txt'), 'utf8')).toBe(ahead.headContent)
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
