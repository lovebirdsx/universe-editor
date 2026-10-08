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
 *  ---- scope -----------------------------------------------------------------------
 *
 *  The range has exactly two sources: the POSITIONAL targets the caller names
 *  (each argument is ONE target — a directory with the explicit `<dir>/...`
 *  suffix, a file as its plain local path) and the `.p4delta-scope` file AT THE
 *  CLIENT ROOT. There is no report mode, no request file and no snapshot: this
 *  process reads that one config once, when it starts, and the extension applies
 *  the same algebra to the same file (see `p4delta/docs/json-contract.md`).
 *
 *  `--exclude-dir` / `--exclude-file` (repeatable) are the CALLER's own exclusions
 *  for this run — the reconcile noise — unioned with the config's and winning over
 *  the includes. `--no-scope-file` drops the persistent config only: this run's
 *  exclusions and the client view still apply.
 *
 *  Everything about the config is fail-closed: a path that leaves the root, an
 *  unknown key, a wrong type, bad JSON or an unreadable file fails the WHOLE run
 *  (an `error` record, `ok:false, reason:"error"`, exit 1) — never "no config".
 *  `--client-root` must be the client's own confirmed Root (what `p4 info` reports,
 *  which this fake takes from the shared state file); a mismatch is a failure, not
 *  a different place to look for a config.
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
 *   - the resolution does not model `p4`'s client-view mapping, ignore rules or
 *     symlink classification beyond "directory on disk".
 *   - the POSITIONAL parser refuses a `-`-prefixed token (even after `--`) as a
 *     usage error, where the real one has no `-` syntax and would read it as a
 *     path. Fail-closed on purpose: a lost `--exclude-*` flag must never become a
 *     scanned path. The editor only ever passes absolute local paths.
 *   - sync mode IS consumed (a plain get runs on δ, see `docs/reconcile.md`), so
 *     it mirrors the real contract more closely than the other modes: normal sync
 *     reports the four classes `add`/`update`/`delete`/`resolve` with `stage`
 *     (`preview` / `apply`) and p4's own `nativeAction` word, and `--force` runs
 *     the force repair (`-f` to the delegated call, the force classes). What is
 *     NOT modelled: the `resolve` class for the opened-file follow-up query — the
 *     real tool finds those opened files through two bounded follow-up queries
 *     (`p4 opened` + `p4 fstat`); here they stay what fake-p4 prints for them.
 *
 *  Fault injection — `UNIVERSE_P4DELTA_FAKE_FAIL`, one mode per session:
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
 *  An unknown mode is a usage error (exit 2) — a typo'd fault must not look like a
 *  passing test. `--help` and `--version` are answered BEFORE the fault handling on
 *  purpose: a fault models "a build that rejects our argv", not a build that cannot
 *  say what it is.
 *
 *  Two evidence seams, both append-only and both written before anything else can
 *  fail (try/catch — a diagnostic seam must never fail a p4 command):
 *   - `UNIVERSE_P4DELTA_ARGV_LOG`: one line per spawn, the complete argv.
 *   - `UNIVERSE_P4DELTA_SCOPE_LOG`: one JSON line per spawn that resolved a scope,
 *     with the RESOLVED range (`status`, `includes`, `excludes`, `targets`,
 *     `scopeFile`). The config's path is fixed and the argv only names targets, so
 *     this log is what says WHICH RANGE a call ended up working over.
 *
 *  Deliberately dependency-free and pure Node. It runs under Electron-as-node
 *  (spawned by P4deltaService via `process.execPath <script>`) and re-spawns its
 *  sibling the same way, so the whole chain stays in Node.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs'
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

const scopeLogPath = process.env.UNIVERSE_P4DELTA_SCOPE_LOG
function logScope(entry) {
  if (!scopeLogPath) return
  try {
    appendFileSync(scopeLogPath, `${JSON.stringify(entry)}\n`)
  } catch {
    // Same rule as above.
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
 *  length. */
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

// ---- path helpers --------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/')

/** Platform spelling with a lower-cased Windows drive letter — fake-p4's own
 *  normalization (and the extension's `norm`): the drive is compared
 *  case-insensitively, everything else literally. */
function normPath(p) {
  let s = toPosix(p).replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

/** The comparison key of a local path: platform separators, lower-cased drive —
 *  lower-cased throughout, mirroring the real tool's `local_path_key`. */
function pathKey(p) {
  return normPath(p).toLowerCase()
}

/** Whether `key` is `dir` itself or sits under it. */
function isUnderKey(key, dir) {
  return key === dir || key.startsWith(`${dir}/`)
}

/** How the real tool SPELLS a resolved path: platform separators, upper-cased
 *  drive letter. The editor accepts either spelling (it keys paths through its
 *  own `scopeKey`), but a fake whose output shape differs from the real one
 *  would hide a shape bug in the editor's readers. */
function canonicalPath(p) {
  let s = p.replace(/[\\/]+$/, '')
  if (s === '') s = p
  s = sep === '/' ? s.split('\\').join('/') : s.split('/').join('\\')
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  return s
}

function isAbsoluteLocalPath(raw) {
  if (typeof raw !== 'string' || raw === '') return false
  if (raw.startsWith('//')) return false
  if (raw.startsWith('\\\\')) return true
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return true
  return raw.startsWith('/') || raw.startsWith('\\')
}

/** Whether the entry is a directory or a file: the local type when it exists, and
 *  an explicit `...` suffix when it does not (the real rule — 「a locally deleted
 *  file」 is a legitimate entry, and a directory that exists nowhere cannot be
 *  told from a file). */
function classifyEntry(path, explicitDir) {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'file'
  } catch {
    return explicitDir ? 'directory' : 'file'
  }
}

// ---- scope resolution ----------------------------------------------------------

const SCOPE_FILE_NAME = '.p4delta-scope'

/** A scope the run refuses. Thrown so one failure becomes the contract's `error`
 *  record + `ok:false` summary in one place. */
class ScopeError extends Error {}

/** The one fixed config location: the client root. No upward walk, no nested
 *  config — the extension's `scopeConfig.ts` reads exactly this path, and a fake
 *  that searched would hide a wiring bug in the reader. */
function scopeFilePath(clientRoot) {
  return join(clientRoot, SCOPE_FILE_NAME)
}

/** The config text, or null for ENOENT. Every OTHER read failure is fail-closed:
 *  a permission error or a directory posing as the file is not "no config".
 *
 *  The bytes go through a FATAL UTF-8 decode, exactly like the editor's
 *  `scopeConfig.ts` (and δ's `String::from_utf8`): a literal U+FFFD (EF BF BD) is
 *  a legal character a user may put in a name, so "the text contains a
 *  replacement character" is not how a broken file is spotted. `ignoreBOM` keeps
 *  the BOM byte in the text (δ does too), so a BOM-prefixed config still fails as
 *  invalid JSON instead of being silently accepted. */
function readConfigText(path) {
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return null
    throw new ScopeError(`${SCOPE_FILE_NAME}: cannot read ${path} — ${err.message}`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ScopeError(`${SCOPE_FILE_NAME}: ${path} is not valid UTF-8`)
  }
}

/** The config's own path grammar, which is the editor's: `/`-separated relative
 *  POSIX paths, normalized component by component, and anything that is not a
 *  plain relative name (or that leaves the root) refused rather than
 *  reinterpreted. */
function normalizeRelative(value, at) {
  if (value === '') throw new ScopeError(`${at} must not be empty`)
  if (value.includes('\\')) {
    throw new ScopeError(`${at} must use "/" separators; "\\" is not a path spelling here`)
  }
  if (value.includes('\0')) throw new ScopeError(`${at} must not contain NUL`)
  if (/[*?]/.test(value)) throw new ScopeError(`${at} must not contain a wildcard`)
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    throw new ScopeError(`${at} must be relative to the client root`)
  }
  const parts = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new ScopeError(`${at} leaves the client root`)
      parts.pop()
      continue
    }
    if (part === '...') {
      throw new ScopeError(
        `${at} contains "..."; that is p4's recursive wildcard, not a path component — a ` +
          `directory is written as {"dir": "…"}, with the type declared rather than spelled`,
      )
    }
    parts.push(part)
  }
  return parts.join('/')
}

/** One config entry → an absolute local path. `dir` / `file` is a DECLARATION:
 *  the kind is never stat-ed for, because "a build directory that does not exist
 *  yet" is one of the commonest entries. */
function configEntry(raw, at, clientRoot) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScopeError(`${at} must be an object`)
  }
  const keys = Object.keys(raw)
  if (keys.length !== 1 || (keys[0] !== 'dir' && keys[0] !== 'file')) {
    throw new ScopeError(`${at} must carry exactly one of "dir" or "file"`)
  }
  const kind = keys[0] === 'dir' ? 'directory' : 'file'
  const value = raw[keys[0]]
  if (typeof value !== 'string') throw new ScopeError(`${at}: "${keys[0]}" must be a string`)
  const relative = normalizeRelative(value, `${at}: "${keys[0]}"`)
  if (relative === '' && kind === 'file') {
    throw new ScopeError(`${at}: "file" cannot name the client root itself; use "dir": "."`)
  }
  return {
    path: canonicalPath(relative === '' ? clientRoot : join(clientRoot, ...relative.split('/'))),
    kind,
  }
}

/** `.p4delta-scope` text → its two entry arrays. Every rule here is fail-closed:
 *  an unknown key, a wrong type or a bad path refuses the WHOLE config, because a
 *  machine-given set must never be silently widened. */
/** `JSON.parse` keeps the LAST of two identical keys while both real parsers
 *  refuse such a config outright, so the raw text is scanned first — otherwise
 *  the fake would run on a file the editor and the engine both reject. */
function assertNoDuplicateKeys(text, what) {
  const frames = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const start = i + 1
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      const raw = text.slice(start, i)
      i++
      let j = i
      while (j < text.length && /\s/.test(text[j])) j++
      const frame = frames[frames.length - 1]
      if (text[j] === ':' && frame !== undefined && frame.kind === 'object') {
        let name = raw
        try {
          name = JSON.parse(`"${raw}"`)
        } catch {
          /* not a name JSON can round-trip; JSON.parse below reports it */
        }
        if (frame.keys.has(name)) throw new ScopeError(`${what}: duplicate key "${name}"`)
        frame.keys.add(name)
      }
      continue
    }
    if (ch === '{') frames.push({ kind: 'object', keys: new Set() })
    else if (ch === '[') frames.push({ kind: 'array' })
    else if (ch === '}' || ch === ']') frames.pop()
    i++
  }
}

function parseScopeConfig(text, configPath, clientRoot) {
  const what = `${SCOPE_FILE_NAME} (${configPath})`
  assertNoDuplicateKeys(text, what)
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new ScopeError(`${what}: not valid JSON — ${err.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScopeError(`${what}: expected a JSON object`)
  }
  for (const key of Object.keys(value)) {
    if (key !== 'include' && key !== 'exclude')
      throw new ScopeError(`${what}: unknown field "${key}"`)
  }
  const arrayOf = (key) => {
    const raw = value[key]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) throw new ScopeError(`${what}: "${key}" must be an array`)
    return raw.map((item, i) => configEntry(item, `${what}: ${key}[${i}]`, clientRoot))
  }
  return { include: arrayOf('include'), exclude: arrayOf('exclude') ?? [] }
}

/** One entry ∩ another, or undefined. Directories intersect by containment (the
 *  deeper path wins), a file only intersects a path it sits on. */
function intersectEntry(a, b) {
  const ka = pathKey(a.path)
  const kb = pathKey(b.path)
  if (a.kind === 'directory' && b.kind === 'directory') {
    if (isUnderKey(ka, kb)) return a
    if (isUnderKey(kb, ka)) return b
    return undefined
  }
  if (a.kind === 'directory') return isUnderKey(kb, ka) ? b : undefined
  if (b.kind === 'directory') return isUnderKey(ka, kb) ? a : undefined
  return ka === kb ? a : undefined
}

function intersectEntries(left, right) {
  const out = []
  for (const a of left) {
    for (const b of right) {
      const entry = intersectEntry(a, b)
      if (entry !== undefined) out.push(entry)
    }
  }
  return out
}

function excludedKey(excludes, key) {
  return excludes.some((entry) =>
    entry.kind === 'directory' ? isUnderKey(key, pathKey(entry.path)) : pathKey(entry.path) === key,
  )
}

/** Dedupe (a directory entry swallows everything under it) and drop everything an
 *  exclusion covers, then sort — the real `dedupe_entries`. */
function dedupeEntries(entries, excludes) {
  const out = []
  for (const entry of entries) {
    const key = pathKey(entry.path)
    if (excludedKey(excludes, key)) continue
    let covered = false
    for (const existing of out) {
      const existingKey = pathKey(existing.path)
      if (existingKey === key || (existing.kind === 'directory' && isUnderKey(key, existingKey))) {
        covered = true
        break
      }
    }
    if (covered) continue
    if (entry.kind === 'directory') {
      for (let i = out.length - 1; i >= 0; i--) {
        if (isUnderKey(pathKey(out[i].path), key)) out.splice(i, 1)
      }
    }
    out.push(entry)
  }
  out.sort((a, b) =>
    pathKey(a.path) < pathKey(b.path) ? -1 : pathKey(a.path) > pathKey(b.path) ? 1 : 0,
  )
  return out
}

/** Exclusions dedupe but keep their insertion order (config order, then the
 *  caller's, then the config file's own entry) — the real `build_exclude_set` only
 *  drops repeats. Nested entries are NOT collapsed: an exclusion inside an
 *  exclusion stays listed, exactly as written. */
function dedupeExcludes(entries) {
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    const key = `${entry.kind}:${pathKey(entry.path)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * Evaluate this run's range: `config includes ∩ targets`, minus the config's
 * exclusions, minus this run's own, minus the config file itself.
 *
 * The algebra and the failure rules are the real tool's (`p4delta/src/scope.rs`,
 * `combine_scope`): a target no config entry covers, a target an exclusion eats
 * whole, and a config that cannot be read are all refusals — none of them is
 * quietly an empty set, and none of them widens to the client root. The one
 * shape that IS a refusal with a different sentence is "no config and no target
 * either": a run given no range at all must never default to the whole client.
 */
function resolveScope(request, state) {
  const clientRoot = request.clientRoot ?? state.clientRoot
  if (!clientRoot || typeof clientRoot !== 'string') {
    throw new ScopeError('no client root: pass --client-root (the confirmed Root of the client)')
  }
  // A root that is not this client's own is a different depot mapping for the
  // same local paths — a change of MEANING, not of config location.
  if (state.clientRoot !== undefined && state.clientRoot !== null) {
    if (pathKey(state.clientRoot) !== pathKey(clientRoot)) {
      throw new ScopeError(
        `--client-root ${clientRoot} is not the Root of client ${state.client ?? '<ambient>'} (${state.clientRoot})`,
      )
    }
  }

  const targets = request.targets ?? []
  let config = null
  let configPath = null
  if (request.noScopeFile !== true) {
    const path = scopeFilePath(clientRoot)
    const text = readConfigText(path)
    if (text !== null) {
      config = parseScopeConfig(text, path, clientRoot)
      configPath = path
    }
  }

  if (config === null && targets.length === 0) {
    throw new ScopeError('No path given; pass the folder to work on.')
  }

  const configIncludes =
    config === null
      ? undefined
      : (config.include ?? [{ path: canonicalPath(clientRoot), kind: 'directory' }])
  let includes =
    configIncludes === undefined
      ? targets
      : targets.length === 0
        ? configIncludes
        : intersectEntries(configIncludes, targets)

  const excludes = dedupeExcludes([
    ...(config === null ? [] : config.exclude),
    ...(request.cliExcludes ?? []),
    // The config file itself, as an explicit `file` exclusion appended LAST — the
    // real tool's implicit key, which is why a config-bearing scope always has at
    // least one exclusion.
    ...(configPath === null ? [] : [{ path: canonicalPath(configPath), kind: 'file' }]),
  ])

  includes = dedupeEntries(includes, excludes)
  // An empty intersection is NOT thrown here: the caller logs the range it
  // resolved (including an empty one — that is the evidence "the config left
  // nothing to work on" rather than "the engine never got that far") and then
  // bails on the executing path.
  return {
    status: includes.length === 0 ? 'empty' : 'resolved',
    includes,
    excludes,
    targets,
    scopeFile: configPath === null ? null : canonicalPath(configPath),
    clientRoot: canonicalPath(clientRoot),
  }
}

/** What to log for a resolved scope: the RANGE, not the caller's bookkeeping. The
 *  argv log can prove a call happened; only this says what it covered. */
function scopeLogEntry(mode, resolved) {
  return {
    kind: 'scope-resolution',
    mode,
    status: resolved.status,
    includes: resolved.includes.map((e) => `${e.kind}:${e.path}`),
    excludes: resolved.excludes.map((e) => `${e.kind}:${e.path}`),
    targets: resolved.targets.map((e) => `${e.kind}:${e.path}`),
    scopeFile: resolved.scopeFile,
  }
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
      '      --client-root <PATH>',
      '          the confirmed Root of this client: the scope config lives there',
      '',
      '      --no-scope-file',
      "          ignore the client root's .p4delta-scope (this run's --exclude-* stay)",
      '',
      '      --exclude-dir <PATH>',
      '          exclude a subtree for THIS run (repeatable, relative to the root)',
      '',
      '      --exclude-file <PATH>',
      '          exclude one file for THIS run (repeatable, exact match)',
      '',
      '      --no-revert-groups',
      '          open mode must equal `p4 reconcile -a -e -d` line for line',
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
      'Entries: each argument is ONE target — <path> for a file, <dir>/... for a',
      'directory. Exclusions go through --exclude-dir / --exclude-file.',
      '',
    ].join('\n'),
  )
}
// ---- argv parsing --------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--no-scope-file',
  '--no-revert-groups',
  '--no-prune-ignored-dirs',
  '--verify-all',
  '-a',
  '--clean',
  '--sync',
  '--force',
])
const VALUE_FLAGS = new Set([
  '--client-root',
  '--to',
  '-c',
  '-w',
  '--workspace',
  '--charset',
  '--exclude-dir',
  '--exclude-file',
])

function parseArgv(argv) {
  const opts = {
    json: false,
    applied: false,
    clean: false,
    sync: false,
    force: false,
    help: false,
    version: false,
    noScopeFile: false,
    verifyAll: false,
    changelist: undefined,
    to: undefined,
    targets: [],
    excludes: [],
  }
  let sawSeparator = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (sawSeparator) {
      pushTarget(opts, arg)
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
      else if (arg === '-c') opts.changelist = value
      else if (arg === '--exclude-dir') opts.excludes.push({ raw: value, kind: 'directory' })
      else if (arg === '--exclude-file') opts.excludes.push({ raw: value, kind: 'file' })
      // -w / --workspace / --charset: accepted, not modelled (the extension pins
      // the client through its own connection options).
      continue
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--json') opts.json = true
      else if (arg === '--clean') opts.clean = true
      else if (arg === '--sync') opts.sync = true
      else if (arg === '--force') opts.force = true
      else if (arg === '-a') opts.applied = true
      else if (arg === '--no-scope-file') opts.noScopeFile = true
      else if (arg === '--verify-all') opts.verifyAll = true
      // --no-revert-groups / --no-prune-ignored-dirs: accepted, deliberately
      // no-ops (see the header).
      continue
    }
    if (arg.startsWith('-')) usageError(`unexpected argument '${arg}' found`)
    pushTarget(opts, arg)
  }
  return opts
}

function pushTarget(opts, raw) {
  // A `-`-prefixed token is a usage error even after `--`. The real tool would
  // read it as a path here (its positional parser has no `-` syntax at all), so
  // this is a deliberate fail-closed divergence: the caller's exclusions have
  // their own flags, and quietly reading a lost exclusion flag as a path is how a
  // scanned subtree gets reported as a match. The editor never emits one.
  if (raw.startsWith('-')) usageError(`unexpected argument '${raw}' found`)
  if (raw.trim() !== '') opts.targets.push(raw)
}

/** One positional entry → a typed target: a trailing `/...` marks a directory
 *  that may not exist locally yet, otherwise the local type decides — the real
 *  classification rule (only the separator-preceded suffix is a wildcard; a name
 *  that merely ends in dots keeps them). */
function cliTarget(raw) {
  const explicitDir = /[\\/]\.\.\.$/.test(raw)
  const path = explicitDir ? raw.replace(/[\\/]\.\.\.$/, '') : raw
  return { path: canonicalPath(path), kind: classifyEntry(path, explicitDir) }
}

/** This run's typed targets. */
function typedTargets(opts) {
  return opts.targets.map(cliTarget)
}

/** This run's own exclusions, typed by the flag that declared them. A relative
 *  spelling is taken against the client root — the base the contract fixes — and
 *  anything that lands outside the root is refused rather than quietly pointing
 *  at a directory the client cannot see.
 *
 *  The kind is decided by the FLAG, never stat-ed for, and the directories come
 *  first as a block: the real tool walks its two `Vec`s in that order, so the
 *  order the exclusions appear in is a flag grouping and not the argv's. */
function typedExcludes(opts, clientRoot) {
  const out = []
  for (const kind of ['directory', 'file']) {
    for (const entry of opts.excludes) {
      if (entry.kind !== kind) continue
      const path = canonicalPath(
        isAbsoluteLocalPath(entry.raw) ? entry.raw : join(clientRoot, entry.raw),
      )
      if (clientRoot !== '' && !isUnderKey(pathKey(path), pathKey(clientRoot))) {
        throw new ScopeError(
          `--exclude-${kind === 'directory' ? 'dir' : 'file'} ${entry.raw} leaves the client root`,
        )
      }
      out.push({ path, kind })
    }
  }
  return out
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

/** The filespec the delegated p4 is asked with: a directory is its recursive
 *  `<dir>/...` form, a file its own path (posix spelling — fake-p4 normalizes). */
function specOf(entry) {
  const path = toPosix(entry.path)
  return entry.kind === 'directory' ? `${path}/...` : path
}

/** Entry → the local path it names. Entries are local paths by construction (the
 *  editor sends the directories it scanned). */
function entryLocal(state, entry) {
  const bare = entry.path
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
  const local = normPath(entryLocal(state, entry))
  if (existsSync(entryLocal(state, entry))) return true
  return Object.keys(state.files ?? {}).some((depotFile) => {
    const file = normPath(depotLocal(state, depotFile))
    return entry.kind === 'directory' ? isUnderKey(file, local) : file === local
  })
}

/** Exclusions are applied HERE, in one pass over the delegated answer: the
 *  caller must not carve the scope into per-directory pieces, and δ takes the
 *  exclusions as scope entries in the same call. A directory exclusion covers
 *  its subtree, a file exclusion exactly that path. The carve below (which keeps
 *  a write run's child from walking the excluded subtree in the first place) is
 *  the other half of the promise, not a replacement for this one. */
function isExcluded(state, record, excludes) {
  if (excludes.length === 0) return false
  const local = pathKey(depotLocal(state, String(record.depotFile ?? '')))
  return excludes.some((entry) =>
    entry.kind === 'directory'
      ? isUnderKey(local, pathKey(entryLocal(state, entry)))
      : pathKey(entryLocal(state, entry)) === local,
  )
}

/** Directory names fake-p4's own disk walk never enters — a carve must not spend
 *  a readdir on them (`<sub>/...` over one is harmless but pointless). */
const WALK_SKIP_DIRS = new Set(['.git', '.p4fake', 'node_modules'])

/**
 * The filespec list a WRITE run hands the delegated p4, with the exclusions
 * carved out BEFORE the call. The child walks exactly what it is handed and
 * mutates as it goes (opened for open, disk for clean), so filtering its answer
 * afterwards — which this engine still does as a second net — would be too late:
 * the excluded subtree would already have been opened or cleaned on the way
 * through. The real tool does not hand the union over either: it drops the
 * excluded paths before analysis and gives p4 the surviving files.
 *
 * A directory no exclusion sits under keeps its recursive `<dir>/...`. A touched
 * one becomes its level spec `<dir>/*` — kept because a locally deleted file is
 * absent from readdir and only the level spec still reaches it — plus, per
 * direct child directory, either a clean `<sub>/...` or the same carve,
 * recursively. An include that is itself excluded, and a file exclusion, are
 * simply dropped.
 *
 * Residual, the same one the editor's own carve documents: `<dir>/*` matches a
 * FILE the exclusions name at that exact level (p4 has no negating spec). δ
 * reports the config file itself as an exclusion, so a config-bearing scope has
 * one; the child may still see it, while the records this engine reports have it
 * filtered out above.
 */
function carveWriteSpecs(state, includes, excludes) {
  const excludedKeys = excludes.map((entry) => pathKey(entryLocal(state, entry)))
  const isExcludedPath = (local) => excludedKeys.includes(pathKey(local))
  const holdsExclusion = (local) => {
    const prefix = `${pathKey(local)}/`
    return excludedKeys.some((key) => key.startsWith(prefix))
  }
  const carveDir = (local, specs) => {
    specs.push(`${toPosix(local)}/*`)
    let entries
    try {
      entries = readdirSync(local, { withFileTypes: true })
    } catch {
      return // the level spec still covers this directory's own files
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || WALK_SKIP_DIRS.has(entry.name)) continue
      const child = `${local}${sep}${entry.name}`
      if (isExcludedPath(child)) continue
      if (holdsExclusion(child)) carveDir(child, specs)
      else specs.push(`${toPosix(child)}/...`)
    }
  }

  const specs = []
  for (const entry of includes) {
    const local = entryLocal(state, entry)
    if (isExcludedPath(local)) continue
    if (entry.kind === 'directory' && holdsExclusion(local)) carveDir(local, specs)
    else specs.push(specOf(entry))
  }
  return specs
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
 * `add` / `update` / `delete` (+ `resolve`): the workspace gets the file, the
 * file is rewritten in place, or the path is removed. `refreshed` (a forced
 * re-fetch of the revision the client already has) means the same thing as
 * `updated` to a consumer — content written to the target — and the real tool
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
 *  contract's records. `mode` picks the subcommand, the spec list and the class
 *  table; `phases` is the ladder this run's progress rides. */
function askAndTranslate(state, opts, mode, phases) {
  let delegated
  let classOfAction
  let plan = { records: [] }
  let stage
  const forceRun = opts.force === true
  const openedOf = (record) => state.opened?.[record.depotFile] !== undefined

  // Sync previews over the union and post-filters its plan (its apply is handed
  // exact per-file specs from that filtered plan, so an excluded path never
  // reaches a write). Open/clean are one walking, mutating pass instead — their
  // exclusions must leave the spec list before the child is called at all.
  const specs =
    mode === 'sync'
      ? opts.resolved.includes.map(specOf)
      : carveWriteSpecs(state, opts.resolved.includes, opts.resolved.excludes)
  // An empty spec list would be read by the child as the WHOLE client (p4's own
  // rule), which is the one outcome an exclusion may never produce.
  if (mode !== 'sync' && specs.length === 0) return { records: [], counts: {} }

  if (mode === 'clean') {
    delegated = delegate([
      opts.applied ? 'clean' : 'reconcile',
      opts.applied ? '-a' : '-n',
      '-e',
      '-d',
      ...specs,
    ])
    classOfAction = (record) => cleanClass(record.action)
  } else if (mode === 'sync') {
    const suffix = opts.to !== undefined ? `@${opts.to}` : ''
    const versioned = specs.map((spec) => `${spec}${suffix}`)
    if (forceRun) {
      // The force repair is not the preview/filter/apply pipeline: it never
      // previews — there is nothing to ask p4 first — and `-f` is what lets it
      // walk over local content that is not opened.
      delegated = delegate(['-G', 'sync', ...(opts.applied ? [] : ['-n']), '-f', ...versioned])
      classOfAction = (record) => syncForceClass(record.action)
    } else {
      emitProgress('preview', null, phases)
      // δ asks p4 what it WOULD do first; that answer is its plan. p4 names an
      // opened file in a notice instead of a record, so δ looks its identity up
      // with a second bounded query (`p4 opened` + `fstat`) — this fake reads it
      // off the plan instead. Either way an opened file is a `resolve` record in
      // BOTH stages: p4 moves its have and schedules the merge, and never writes
      // its content.
      plan = delegate(['-G', 'sync', '-n', ...versioned])
      emitProgress('filter', null, phases)
      // δ hands p4 the plan's candidates as EXACT specs (`//depot/f#rev`) — which
      // is also why a file p4 refused in the preview is never mentioned again:
      // it was never handed over. Nothing to do means no second call at all.
      // The excluded paths leave the plan here, before any spec exists for them:
      // δ's exclusion is a scope rule over the analysis, not a filter over the
      // answer, so a `-a` run can never write a path the scope left out.
      const pinned = plan.records
        .filter((record) => !isExcluded(state, record, opts.resolved.excludes))
        .map((record) =>
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
      ...specs,
    ])
    classOfAction = (record) => openClass(record.action)
  }

  const records = delegated.records
    // An opened file is in no apply run's records (p4 reports it with notices
    // only), so its record comes from the plan there; in a preview the plan
    // already carries it and the class function names it `resolve`.
    .concat(opts.applied && mode === 'sync' && !forceRun ? plan.records.filter(openedOf) : [])
    .filter((record) => !isExcluded(state, record, opts.resolved.excludes))
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

  // Normal sync's range IS the client view: a one-off exclusion would change the
  // question asked of native p4, so the real CLI refuses the pair outright (a
  // clap conflict, exit 2). A persistent boundary belongs in the config.
  if (mode === 'sync' && opts.force !== true && opts.excludes.length > 0) {
    usageError('--exclude-dir / --exclude-file are not accepted by a normal sync')
  }
  if (opts.verifyAll && opts.force !== true) usageError('--verify-all requires --force')

  // The range is resolved BEFORE anything else, out of the client root's config
  // and this run's own targets/exclusions. A config that cannot be read — or a
  // target no exclusion may swallow — fails the run closed here, before any p4.
  let resolved
  try {
    const clientRoot = opts.clientRoot ?? state.clientRoot
    resolved = resolveScope(
      {
        ...(clientRoot !== undefined ? { clientRoot } : {}),
        targets: typedTargets(opts),
        cliExcludes: typedExcludes(opts, clientRoot ?? state.clientRoot ?? ''),
        noScopeFile: opts.noScopeFile,
      },
      state,
    )
  } catch (err) {
    if (!(err instanceof ScopeError)) throw err
    emit({ kind: 'error', message: err.message })
    emitSummary(mode, opts, {
      ok: false,
      reason: 'error',
      counts: {},
      scopeMatched: 0,
      unmatched: 0,
      started: Date.now(),
      summary: fail !== 'nosummary',
    })
    return 1
  }
  opts.resolved = resolved
  logScope(scopeLogEntry(mode, resolved))

  // An empty range on the EXECUTING path is an error, exactly like the real
  // tool's bail: an error record and `ok:false`. It never falls back to the whole
  // workspace — under `--clean -a` that fallback would be destructive.
  if (resolved.status === 'empty') {
    emit({
      kind: 'error',
      message: 'Nothing to work on: the given paths do not overlap the configured scope.',
    })
    emitSummary(mode, opts, {
      ok: false,
      reason: 'error',
      counts: {},
      scopeMatched: 0,
      unmatched: 0,
      started: Date.now(),
      summary: fail !== 'nosummary',
    })
    return 1
  }

  // The phase ladder follows the mode: normal sync's has preview/filter/apply,
  // the others have analyze/digest/report.
  const phases = phasesFor(mode, opts.force === true)
  const started = Date.now()

  emitProgress('start', null, phases)
  const { records, counts } = askAndTranslate(state, opts, mode, phases)

  // Crash: the stream ends mid-flight with no summary. A consumer that reads the
  // partial records as an answer is the bug hard rule 1 exists for.
  if (fail === 'crash' || (fail === 'crash-scan' && !opts.applied)) {
    if (opts.json) {
      for (const record of records.slice(0, 2)) emit(record)
    } else writeOut(`${records.length} file(s) — injected crash, no summary\n`)
    process.exit(1)
  }
  // Scope accounting runs on the INCLUDES only. An exclusion matching nothing is
  // the normal state of an exclude entry (the directory may not exist), so it
  // must never turn a run into "nothing matched".
  const unmatchedPaths = resolved.includes
    .filter((entry) => fail === 'unmatched' || !entryMatched(state, entry))
    .map((entry) => entry.path)
  const scopeMatched = resolved.includes.length - unmatchedPaths.length
  // Every include landing empty is a COMPLETE answer ("there is nothing there"),
  // not a crash — the contract keeps it apart for consumers that send the
  // `[<path>, <path>/...]` pair of a deleted directory. With zero entries the
  // same reading is the only one that cannot be mistaken for success.
  const noEntryMatched =
    resolved.includes.length === 0 || unmatchedPaths.length === resolved.includes.length
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
