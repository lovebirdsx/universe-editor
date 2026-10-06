#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Fake `p4delta` CLI for e2e / manual testing of the Perforce extension.
 *
 *  Why it exists: this machine (and CI) has no p4delta build, so the extension
 *  would resolve no engine and every δ-backed path (the whole-scope scan, the
 *  narrow query, the three writes) would silently fall back to native p4 — the
 *  engine's wiring would be untestable end to end. This script stands in.
 *
 *  How it answers: it keeps NO depot model of its own. Every question is
 *  DELEGATED to `fake-p4.mjs` (its sibling — the same fake `p4` the extension is
 *  pointed at through `UNIVERSE_P4_PATH`), and the `-Mj` records that come back
 *  are translated into this contract's JSON Lines. Both fakes read and write the
 *  SAME state file (`UNIVERSE_P4_FAKE_STATE`), so "both engines see one world" is
 *  a construction guarantee, not a convention: a spec can collect through δ and
 *  then assert the opened set the native engine would report. The field shapes
 *  below follow `p4delta/docs/json-contract.md` (the single source of truth).
 *
 *  The delegation hides exactly one thing: the child's `UNIVERSE_P4_FAKE_ARGV_LOG`
 *  is stripped (see `delegate()`). That log's contract is "the argv the EXTENSION
 *  handed to the native engine" — the suite's central negative assertion ("no
 *  native reconcile ran") is only provable while δ's internal hand-off cannot
 *  show up in it. The δ side's own log (`UNIVERSE_P4DELTA_ARGV_LOG`) is what
 *  records that the engine was asked at all.
 *
 *  Deliberate divergences from the real tool — each is a thing a future spec
 *  might otherwise assume, so each says what would be needed to model it:
 *   - open mode never emits the `reopen_*` classes: fake-p4's reconcile skips
 *     opened files entirely, so there is no reopen model to translate. The
 *     editor drops opened rows on its own side (`_dropOpenedRows`), so the
 *     consumer-visible answer is the same. A spec that needs `reopen_*` needs a
 *     fake-p4 that models opened-but-changed files.
 *   - `--no-revert-groups` is accepted and ignored: fake-p4's reconcile only ever
 *     reports add/edit/delete, i.e. this fake's open mode is permanently in the
 *     `--no-revert-groups` shape — the shape the editor always asks for. The
 *     default (revert-group) shape is NOT modelled.
 *   - `class:"handoff"` never appears: no file type here is undigestable, and the
 *     hand-off target would be fake-p4 while the real δ hands off to a real p4.
 *   - scope matching is a plain "exists on disk, or has a depot record" test
 *     (`entryMatched`), which is the rule the real tool documents for `unmatched`
 *     (an existing empty directory counts as matched — the real one warns about
 *     that case without failing either).
 *   - sync mode IS consumed (a plain get runs on δ, see `docs/reconcile.md`), so
 *     it mirrors the real contract more closely than the other modes: normal sync
 *     reports the four classes `add`/`update`/`delete`/`resolve` with `stage`
 *     (`preview` / `apply`) and p4's own `nativeAction` word, and `--force` runs
 *     the force repair (`-f` to the delegated call, the force classes). What is
 *     NOT modelled: the `resolve` class. The real tool finds those opened files
 *     through two bounded follow-up queries (`p4 opened` + `p4 fstat`); here they
 *     stay what fake-p4 prints for them, i.e. a message on stderr. A spec that
 *     needs `keptOpen`/`mustResolve` from a δ get needs a fake that models that
 *     follow-up.
 *
 *  Fault injection — `UNIVERSE_P4DELTA_FAKE_FAIL`, one mode per session, every
 *  mode asserted by the e2e suite:
 *   - `crash`      — emit a couple of file records, then exit 1 with NO summary
 *                    (what a killed / crashed engine leaves behind).
 *   - `crash-scan` — the same, but only for runs WITHOUT `-a`, i.e. PREVIEWS: the
 *                    scan and the narrow query. `-a` is the only structural
 *                    difference between a δ preview and a δ write here (the
 *                    editor writes with `-a` and never previews with it), so this
 *                    is how a spec breaks the scan path while the write path
 *                    keeps working.
 *   - `nosummary`  — a complete-looking run (records, exit 0) that never emits a
 *                    summary. THE trap the contract's hard rule 1 is about.
 *   - `exit2`      — usage error at the parse stage, before any work.
 *   - `error`      — records, then an `error` record and `ok:false, reason:"error"`.
 *   - `unmatched`  — every include reported `unmatched`, `ok:false,
 *                    reason:"no-entry-matched"`, exit 1: the ONE `ok:false` shape
 *                    a consumer is allowed to read as a complete answer.
 *  An unknown mode is a usage error (exit 2) — a typo'd fault must not look like
 *  a passing test. `--help` and `--version` are answered BEFORE the fault
 *  handling on purpose: a fault models "a build that rejects our argv", not a
 *  build that cannot say what it is.
 *
 *  `UNIVERSE_P4DELTA_ARGV_LOG` appends one line per spawn — the complete argv,
 *  written before anything else, so a usage error is recorded too. It is the only
 *  evidence for the two claims the SCM panel cannot make: "zero spawn" (the log
 *  stays empty — the `enabled:false` spec) and "every exclusion rode along" (a
 *  `-<dir>/...` entry inside the line). Same technique and same rule as
 *  fake-p4's own argv log: a diagnostic seam must never fail a p4 command, hence
 *  try/catch.
 *
 *  Deliberately dependency-free and pure Node. It runs under Electron-as-node
 *  (spawned by P4deltaService via `process.execPath <script>`) and re-spawns its
 *  sibling the same way, so the whole chain stays in Node.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, existsSync, readFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE_P4 = join(dirname(fileURLToPath(import.meta.url)), 'fake-p4.mjs')

const STATE_PATH = process.env.UNIVERSE_P4_FAKE_STATE
if (!STATE_PATH) {
  process.stderr.write('fake-p4delta: UNIVERSE_P4_FAKE_STATE not set\n')
  process.exit(1)
}

// ---- the seams -----------------------------------------------------------------

// Before parsing, before any work: a usage error (exit 2) must be recorded too —
// "was the engine spawned at all" is the question this log answers.
const argvLogPath = process.env.UNIVERSE_P4DELTA_ARGV_LOG
if (argvLogPath) {
  try {
    appendFileSync(argvLogPath, `${process.argv.slice(2).join(' ')}\n`)
  } catch {
    // A diagnostic seam must never fail a p4 command.
  }
}

/** All output goes through `writeSync`: the crash faults must be able to end the
 *  process immediately with `process.exit`, and on POSIX a pending async
 *  `process.stdout.write` would be dropped there — the partial (pre-crash)
 *  records are exactly what those faults are for. Records are small, so a
 *  synchronous write costs nothing. A dead consumer (watchdog kill) has closed
 *  the pipe; that is the consumer's business, not a crash of this run. */
function writeOut(text) {
  try {
    writeSync(1, text)
  } catch {
    process.exit(0)
  }
}

function writeErr(text) {
  try {
    writeSync(2, text)
  } catch {
    process.exit(0)
  }
}

function emit(record) {
  writeOut(`${JSON.stringify(record)}\n`)
}

/** Progress rides stderr (contract: stdout is JSON Lines only) and is display-only
 *  for the consumer: `step` is the index in the fixed ladder + 1, `total` is its
 *  length. The fake has no digest pass to report, so only the phases it can
 *  honestly claim are emitted. */
const PHASES = ['start', 'analyze', 'digest', 'report', 'done']
/** Normal sync walks a different ladder — no analyze / digest, but the preview and
 *  apply segments the other modes do not have. The real tool swaps its phase table
 *  per mode too, so `step`/`total` stay truthful. */
const SYNC_PHASES = ['start', 'preview', 'filter', 'apply', 'done']
const phasesFor = (mode, forceRun = false) => (mode === 'sync' && !forceRun ? SYNC_PHASES : PHASES)
function emitProgress(phase, message = null, phases = PHASES) {
  writeErr(
    `${JSON.stringify({
      kind: 'progress',
      phase,
      step: phases.indexOf(phase) + 1,
      total: phases.length,
      message,
    })}\n`,
  )
}

function usageError(message) {
  writeErr(`error: ${message}\n\nUsage: p4delta [OPTIONS] [--] [ENTRY]...\n`)
  // Exit 2 is the contract's usage-error code, and the extension reads exactly
  // that code as "wrong argv, not a failed run" — so a mis-parse must land here
  // and nowhere else.
  process.exit(2)
}

function loadState() {
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
}

const toPosix = (p) => p.split(sep).join('/')

/** Posix form with a lower-cased Windows drive letter, mirroring fake-p4's own
 *  normalization (and the extension's `norm`): the drive gets compared
 *  case-insensitively, everything else literally. */
function normPath(p) {
  let s = toPosix(p).replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

// ---- help ----------------------------------------------------------------------

/** Kept clap-shaped only because that is what the real tool prints, and the
 *  contract spec pins the parts the editor's argv relies on. */
function printHelp() {
  writeOut(
    [
      'p4delta (e2e fake) — reconcile / clean / sync answers for the Perforce extension',
      '',
      'Usage: p4delta [OPTIONS] [--] [ENTRY]...',
      '',
      'Options:',
      '      --json',
      '          machine-readable JSON Lines on stdout, report on stderr',
      '',
      '      --no-scope-file',
      '          ignore .p4delta-scope',
      '',
      '      --no-revert-groups',
      '          open mode must equal `p4 reconcile -a -e -d` line for line',
      '',
      '      --client-root <PATH>',
      '          client root, skips the `p4 info` round-trip',
      '',
      '  -a',
      '          apply; without it the run is a preview',
      '',
      '      --clean',
      '          discard working-tree drift (default: open)',
      '',
      '      --sync',
      '          sync files to a target revision',
      '',
      '      --force',
      '          force-repair instead of a normal sync',
      '',
      '      --to <CHANGELIST>',
      '          target change for --sync',
      '',
      '  -c <CHANGELIST>',
      '          changelist the opened files go into',
      '',
      '  -h, --help',
      '          Print help',
      '',
      'Entries after `--`: <path>, <dir>/... and `-`-prefixed exclusions.',
      '',
    ].join('\n'),
  )
}

// ---- argv parsing --------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--no-scope-file',
  '--no-revert-groups',
  '-a',
  '--clean',
  '--sync',
  '--force',
])
const VALUE_FLAGS = new Set(['--client-root', '--to', '-c'])

/**
 * The editor always writes the scope entries after `--`, and an entry that
 * STARTS with `-` (an exclusion) can only be spelled there. So: a bare
 * positional before `--` is accepted (a real CLI does), but a `-`-prefixed token
 * outside the known flag set is a usage error — which is what catches a caller
 * that lost the separator while carrying an exclusion, instead of silently
 * dropping the exclusion and scanning a directory the user excluded.
 */
function parseArgv(argv) {
  const opts = {
    json: false,
    applied: false,
    clean: false,
    sync: false,
    force: false,
    help: false,
    version: false,
    changelist: undefined,
    to: undefined,
    includes: [],
    excludes: [],
  }
  let sawSeparator = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (sawSeparator) {
      pushEntry(opts, arg)
      continue
    }
    if (arg === '--') {
      sawSeparator = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true
      continue
    }
    if (arg === '--version' || arg === '-V') {
      opts.version = true
      continue
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i]
      if (value === undefined) usageError(`the argument '${arg}' requires a value`)
      if (arg === '--client-root') opts.clientRoot = value
      else if (arg === '--to') opts.to = value
      else opts.changelist = value
      continue
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--json') opts.json = true
      else if (arg === '--clean') opts.clean = true
      else if (arg === '--sync') opts.sync = true
      else if (arg === '--force') opts.force = true
      else if (arg === '-a') opts.applied = true
      // --no-scope-file / --no-revert-groups: accepted, deliberately no-ops (see
      // the header). This fake never reads a `.p4delta-scope` — the same answer
      // as a workspace that has none, which is every workspace the editor runs
      // against.
      continue
    }
    if (arg.startsWith('-')) usageError(`unexpected argument '${arg}' found`)
    pushEntry(opts, arg)
  }
  return opts
}

function pushEntry(opts, raw) {
  // `-<dir>/...` is an exclusion; everything else is an include, stored with its
  // trailing `/...` in place (the delegated call needs the filespec spelled the
  // way p4 reads it).
  if (raw.startsWith('-') && raw.length > 1) opts.excludes.push(raw.slice(1))
  else if (raw !== '') opts.includes.push(raw)
}

// ---- delegation ----------------------------------------------------------------

/**
 * Run fake-p4 with `args` and hand back its captured streams.
 *
 * The argv log is stripped from the child env: a delegated call is this engine's
 * internal business (on a real machine δ spawns a real `p4` for its own
 * hand-offs), while the log's contract is "argv the EXTENSION sent to the native
 * engine". Without the strip, every δ scan would also write a native-looking
 * `reconcile` line and the specs' "native never ran" assertion would be
 * unprovable.
 */
function delegate(args) {
  const env = { ...process.env }
  delete env.UNIVERSE_P4_FAKE_ARGV_LOG
  // `process.execPath` is the Electron binary under the extension host, and
  // ELECTRON_RUN_AS_NODE is what keeps it a Node process — p4deltaService re-adds
  // it for the same reason when spawning THIS script. Set it here as well so the
  // delegation does not depend on how this fake was started.
  env.ELECTRON_RUN_AS_NODE = '1'
  const res = spawnSync(process.execPath, [FAKE_P4, ...args], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    // Well above anything a seeded workspace produces, well below the consumer's
    // own 256MB stdout cap (which a real δ would trip before this does).
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) {
    writeErr(`fake-p4delta: delegated p4 failed to start: ${res.error.message}\n`)
    process.exit(1)
  }
  if (res.stderr) writeErr(res.stderr)
  return { records: parseMj(res.stdout ?? '') }
}

/** fake-p4's `-Mj` records: one JSON object per line. Non-JSON lines (its plain
 *  stdout refusals on a sync dry run) are not records. */
function parseMj(stdout) {
  const out = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value)
    } catch {
      // not a record
    }
  }
  return out
}

// ---- scope matching ------------------------------------------------------------

/** Entry → the local path it names. Entries are local paths by construction (the
 *  editor sends the directories it scanned); the depot form is mapped through the
 *  client root so a depot-syntax scope stays answerable. */
function entryLocal(state, entry) {
  const bare = barePath(entry)
  if (bare.startsWith(`${state.depotPrefix}/`)) {
    return join(state.clientRoot, bare.slice(state.depotPrefix.length + 1))
  }
  return bare
}

function depotLocal(state, depotFile) {
  return join(state.clientRoot, depotFile.slice(state.depotPrefix.length + 1))
}

/**
 * An entry matched something: it exists on disk, or the depot has a record at /
 * under it. Same rule the real tool documents for `unmatched` (an existing
 * directory counts as a hit even when empty — the real one warns about that
 * shape without calling it a failure).
 */
function entryMatched(state, entry) {
  const recurse = entry.endsWith('/...')
  const local = normPath(entryLocal(state, entry))
  if (existsSync(entryLocal(state, entry))) return true
  return Object.keys(state.files ?? {}).some((depotFile) => {
    const file = normPath(depotLocal(state, depotFile))
    return recurse ? file === local || file.startsWith(`${local}/`) : file === local
  })
}

/** The entry as the real tool reports it in `unmatched`: the parsed path, i.e.
 *  with the trailing `/...` stripped. */
function barePath(entry) {
  return entry.endsWith('/...') ? entry.slice(0, -'/...'.length) : entry
}

/** Exclusions are applied HERE, in one pass over the delegated answer: the child
 *  must be asked for the union (a `-`-prefixed token is not a filespec it could
 *  filter on), and δ's whole point is that the caller does not carve the scope
 *  into per-directory pieces. `-<dir>/...` excludes the subtree, a bare
 *  `-<path>` exactly that path. */
function isExcluded(state, record, excludes) {
  if (excludes.length === 0) return false
  const local = normPath(depotLocal(state, String(record.depotFile ?? '')))
  return excludes.some((entry) => {
    const recurse = entry.endsWith('/...')
    const base = normPath(entryLocal(state, entry))
    return recurse ? local === base || local.startsWith(`${base}/`) : local === base
  })
}

// ---- record translation --------------------------------------------------------

/** p4 action → this contract's open-mode class. With `--no-revert-groups` the
 *  table is the identity (add/edit/delete), which is the mode the editor asks
 *  for and the only one fake-p4 can answer (see the header). */
function openClass(action) {
  if (action === 'add') return 'add'
  if (action === 'delete') return 'delete'
  return 'edit'
}

/** p4 clean action → clean-mode class. A disk-add deleted by the clean is
 *  `delete`, a drifted edit restored to have is `revert`, a file missing from
 *  disk restored from the depot is `restore` — the same three groups the real
 *  tool reports. */
function cleanClass(action) {
  if (action === 'add') return 'delete'
  if (action === 'delete') return 'restore'
  return 'revert'
}

/**
 * p4 sync action → the class a NORMAL sync reports. The contract's vocabulary is
 * `add` / `update` / `delete` (+ `resolve`, not modelled here): the workspace gets
 * the file, the file is rewritten in place, or the path is removed. `refreshed`
 * (a forced re-fetch of the revision the client already has) means the same thing
 * as `updated` to a consumer — content written to the target — and the real tool
 * folds it in the same way.
 */
function syncClass(action) {
  if (action === 'added') return 'add'
  if (action === 'deleted') return 'delete'
  return 'update'
}

/**
 * p4 sync action → the class the FORCE repair reports. That path shares
 * `mode:"sync"` but has its own two extra classes: `restore` writes back a
 * locally missing file, `revert` puts drifted local content back to the target.
 * Only a `--force` run answers in this vocabulary.
 */
function syncForceClass(action) {
  if (action === 'added') return 'restore'
  if (action === 'refreshing') return 'revert'
  return 'update'
}

const ACTION_FOR_CLASS = {
  open: { add: 'add', edit: 'edit', delete: 'delete' },
  clean: { delete: 'deleting', revert: 'reverting', restore: 'restoring' },
  sync: {
    add: 'adding',
    update: 'updating',
    delete: 'deleting',
    resolve: 'scheduling',
    revert: 'reverting',
    restore: 'restoring',
  },
}

/** p4's own verb -> the contract's `nativeAction`. `refreshing` is the word p4
 *  prints in its human line; the structured word (the only one δ accepts) is
 *  `refreshed`. An opened file has no word at all — p4 answers it with a notice,
 *  so δ looks it up and its record claims none rather than inventing one. */
const NATIVE_ACTION = {
  added: 'added',
  updated: 'updated',
  deleted: 'deleted',
  refreshing: 'refreshed',
}

/** One `kind:"file"` record: the class table's row for this file, plus the run's
 *  own facts. `run` is the whole run's state, never a single file's — `applied`
 *  says whether `-a` was handed over, `stage` which half of normal sync the
 *  record belongs to (absent for the force repair and the other modes), `force`
 *  whether this was a repair at all. */
function fileRecord(mode, classOfAction, record, run) {
  const klass = classOfAction(record)
  const out = {
    kind: 'file',
    mode,
    class: klass,
    action: ACTION_FOR_CLASS[mode][klass],
    depotFile: record.depotFile,
    clientFile: record.clientFile,
    applied: run.applied,
    // Every file record carries it, not just the summary: the force repair shares
    // this mode and part of its class table, so this is what keeps a repair's
    // records from being read as a normal get even mid-stream.
    force: run.force,
  }
  // Absent, not null, for a file with no revision: the readers test for the key.
  if (record.rev !== undefined && record.rev !== null) out.rev = record.rev
  if (run.stage !== undefined) out.stage = run.stage
  // `nativeAction` is normal sync's alone — the other modes' records carry none,
  // and neither does an opened file's (p4 never printed a word for it).
  const native = NATIVE_ACTION[record.action]
  if (native !== undefined && run.stage !== undefined && klass !== 'resolve') {
    out.nativeAction = native
  }
  return out
}

// ---- run -----------------------------------------------------------------------

const KNOWN_FAULTS = new Set(['crash', 'crash-scan', 'nosummary', 'exit2', 'error', 'unmatched'])

/** Ask the delegated p4 for this run's answer and translate it into the
 *  contract's records. `mode` picks the subcommand and the class table; `phases`
 *  is the ladder this run's progress rides. */
function askAndTranslate(state, opts, mode, phases) {
  let delegated
  let classOfAction
  let plan = { records: [] }
  let stage
  const forceRun = opts.force === true
  const openedOf = (record) => state.opened?.[record.depotFile] !== undefined

  if (mode === 'clean') {
    delegated = delegate([
      opts.applied ? 'clean' : 'reconcile',
      opts.applied ? '-a' : '-n',
      '-e',
      '-d',
      ...opts.includes,
    ])
    classOfAction = (record) => cleanClass(record.action)
  } else if (mode === 'sync') {
    const suffix = opts.to !== undefined ? `@${opts.to}` : ''
    const specs = opts.includes.map((spec) => `${spec}${suffix}`)
    if (forceRun) {
      // The force repair is not the preview/filter/apply pipeline: it never
      // previews — there is nothing to ask p4 first — and `-f` is what lets it
      // walk over local content that is not opened.
      delegated = delegate(['-G', 'sync', ...(opts.applied ? [] : ['-n']), '-f', ...specs])
      classOfAction = (record) => syncForceClass(record.action)
    } else {
      emitProgress('preview', null, phases)
      // δ asks p4 what it WOULD do first; that answer is its plan. p4 names an
      // opened file in a notice instead of a record, so δ looks its identity up
      // with a second bounded query (`p4 opened` + `fstat`) — this fake reads it
      // off the plan instead. Either way an opened file is a `resolve` record in
      // BOTH stages: p4 moves its have and schedules the merge, and never writes
      // its content.
      plan = delegate(['-G', 'sync', '-n', ...specs])
      emitProgress('filter', null, phases)
      // δ hands p4 the plan's candidates as EXACT specs (`//depot/f#rev`) — which
      // is also why a file p4 refused in the preview is never mentioned again:
      // it was never handed over. Nothing to do means no second call at all.
      const pinned = plan.records.map((record) =>
        record.rev === undefined || record.rev === null
          ? String(record.depotFile)
          : `${record.depotFile}#${record.rev}`,
      )
      if (opts.applied && pinned.length > 0) {
        // The apply segment is announced the moment the writing starts, which is
        // how a consumer tells "the run died before touching anything" (safe to
        // re-serve elsewhere) from "part of it may already have landed".
        emitProgress('apply', null, phases)
        delegated = delegate(['-G', 'sync', ...pinned])
      } else {
        delegated = plan
      }
      classOfAction = (record) => (openedOf(record) ? 'resolve' : syncClass(record.action))
      stage = opts.applied ? 'apply' : 'preview'
    }
  } else {
    delegated = delegate([
      'reconcile',
      opts.applied ? '-a' : '-n',
      '-e',
      '-d',
      ...(opts.changelist !== undefined ? ['-c', opts.changelist] : []),
      ...opts.includes,
    ])
    classOfAction = (record) => openClass(record.action)
  }

  const records = delegated.records
    // An opened file is in no apply run's records (p4 reports it with notices
    // only), so its record comes from the plan there; in a preview the plan
    // already carries it and the class function names it `resolve`.
    .concat(opts.applied && mode === 'sync' && !forceRun ? plan.records.filter(openedOf) : [])
    .filter((record) => !isExcluded(state, record, opts.excludes))
    .map((record) =>
      fileRecord(mode, classOfAction, record, { applied: opts.applied, stage, force: forceRun }),
    )
  const counts = {}
  for (const record of records) counts[record.class] = (counts[record.class] ?? 0) + 1
  return { records, counts }
}

function main() {
  const opts = parseArgv(process.argv.slice(2))
  if (opts.version) {
    // Clap's `<crate name> <version>` shape (the crate name is compiled in).
    // Nothing in the editor reads this — the version gate is gone — but a real
    // CLI answers it, and a fake that exit-2'd here would be a false signal.
    writeOut('p4delta 0.1.6\n')
    return 0
  }
  if (opts.help) {
    printHelp()
    return 0
  }
  if (opts.clean && opts.sync) usageError('--clean and --sync are mutually exclusive')

  const fail = process.env.UNIVERSE_P4DELTA_FAKE_FAIL
  if (fail !== undefined && fail !== '' && !KNOWN_FAULTS.has(fail)) {
    usageError(`UNIVERSE_P4DELTA_FAKE_FAIL='${fail}' is not a known fault mode`)
  }
  // A build that rejects our argv: the fault lands at the parse stage and leaves
  // the same exit 2 a real clap parse error does.
  if (fail === 'exit2') usageError('unexpected argument found (injected fault)')

  const state = loadState()
  const mode = opts.clean ? 'clean' : opts.sync ? 'sync' : 'open'
  // The phase ladder follows the mode: normal sync's has preview/filter/apply,
  // the others have analyze/digest/report.
  const phases = phasesFor(mode, opts.force === true)
  const started = Date.now()

  emitProgress('start', null, phases)
  const { records, counts } = askAndTranslate(state, opts, mode, phases)

  // Crash: the stream ends mid-flight with no summary. A consumer that reads the
  // partial records as an answer is the bug hard rule 1 exists for.
  if (fail === 'crash' || (fail === 'crash-scan' && !opts.applied)) {
    if (opts.json) for (const record of records.slice(0, 2)) emit(record)
    else writeOut(`${records.length} file(s) — injected crash, no summary\n`)
    process.exit(1)
  }

  // Scope accounting runs on the INCLUDES only. An exclusion matching nothing is
  // the normal state of an exclude entry (the directory may not exist), so it
  // must never turn a run into "nothing matched".
  const unmatchedPaths = opts.includes
    .filter((entry) => fail === 'unmatched' || !entryMatched(state, entry))
    .map(barePath)
  const scopeMatched = opts.includes.length - unmatchedPaths.length
  // Every include landing empty is a COMPLETE answer ("there is nothing there"),
  // not a crash — the contract keeps it apart for consumers that send the
  // `[<path>, <path>/...]` pair of a deleted directory. With zero entries the
  // same reading is the only one that cannot be mistaken for success.
  const noEntryMatched =
    opts.includes.length === 0 || unmatchedPaths.length === opts.includes.length
  const failed = noEntryMatched || fail === 'error'

  // No 'report' segment on the sync ladder — the apply phase already closed the
  // writing half there, and the records below are its outcome.
  if (mode !== 'sync') emitProgress('report', null, phases)
  if (opts.json) for (const record of records) emit(record)
  else
    writeOut(
      `${records.length} file(s) in ${mode} mode${opts.applied ? ' (applied)' : ' (preview)'}\n`,
    )
  for (const path of unmatchedPaths) emit({ kind: 'unmatched', path })

  if (failed) {
    // The real tool also reports a run-level failure as a record (it is the only
    // machine-readable diagnostic for a run that produced none), then the summary.
    emit({
      kind: 'error',
      message: noEntryMatched
        ? `Nothing to work on: ${unmatchedPaths.length} scope entr${unmatchedPaths.length === 1 ? 'y' : 'ies'} matched nothing in the depot or on disk (misspelled?)`
        : 'Injected fault: the run did not conclude (UNIVERSE_P4DELTA_FAKE_FAIL=error)',
    })
    emitSummary(mode, opts, {
      ok: false,
      // `no-entry-matched` is the one failure a consumer may read as an answer;
      // everything else collapses to the catch-all `error`.
      reason: noEntryMatched ? 'no-entry-matched' : 'error',
      counts,
      scopeMatched,
      unmatched: unmatchedPaths.length,
      started,
      summary: fail !== 'nosummary',
    })
    return 1
  }

  emitProgress('done', null, phases)
  emitSummary(mode, opts, {
    ok: true,
    reason: null,
    counts,
    scopeMatched,
    unmatched: unmatchedPaths.length,
    started,
    summary: fail !== 'nosummary',
  })
  return 0
}

function emitSummary(mode, opts, state) {
  if (!state.summary) return // the `nosummary` fault: a run that looks complete and concluded nothing
  const total = Object.values(state.counts).reduce((sum, n) => sum + n, 0)
  emit({
    kind: 'summary',
    mode,
    ok: state.ok,
    applied: opts.applied,
    force: opts.force === true,
    total,
    counts: state.counts,
    scopeMatched: state.scopeMatched,
    unmatched: state.unmatched,
    elapsedMs: Date.now() - state.started,
    reason: state.reason,
  })
}

// A dead consumer (watchdog kill mid-write) closes the pipe under us; writeOut
// already swallows that. Anything else is a bug in this fake and must be loud
// rather than silently produce a stream without a summary.
try {
  // Every write above is synchronous, so nothing needs draining — but the exit
  // code must still come from main().
  process.exitCode = main()
} catch (err) {
  writeErr(`fake-p4delta: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
}
