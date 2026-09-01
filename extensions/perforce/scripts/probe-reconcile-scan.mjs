#!/usr/bin/env node
/**
 * Read-only real-workspace probe for the extensions/perforce background
 * reconcile scan (`client.ts` `runReconcileScan` / `_reconcileScanBatch`).
 * Zero dependencies, plain Node (>= 18).
 *
 * Usage:
 *   node probe-reconcile-scan.mjs --workspace <dir>
 *   env overrides: UNIVERSE_P4_PROBE_WORKSPACE
 *                  UNIVERSE_P4_PROBE_SKIP_ROOT=1            skip the slow whole-root scan (A/D)
 *                  UNIVERSE_P4_PROBE_MAX_SUBDIRS=<n>        cap first-level subdir probes (default 15)
 *                  UNIVERSE_P4_PROBE_SUBDIR_TIMEOUT_MS=...  per-subdir ceiling (default 90000)
 *                  UNIVERSE_P4_PROBE_ROOT_TIMEOUT_MS=...    root ceiling (default 300000)
 *                  UNIVERSE_P4_PROBE_MAX_TOTAL_MS=...       whole-script budget (default 540000)
 *
 * The workspace is REQUIRED (no default) — this script only runs on a machine
 * with a real p4 client, so the workspace must be passed in; missing → usage
 * error. The script NEVER issues a write command. Whitelist: `reconcile`
 * (dry-run `-n` mandatory — a reconcile without `-n` is refused with a hard
 * error), `info`, `fstat`, `where`, `opened`, `changes`. `tickets`/`login`
 * cannot run at all, so ticket/password output can never appear (a defensive
 * redact set is kept anyway). Spawns run with cwd = workspace; PWD and MSYS*
 * are stripped from the child env so the client that owns the workspace is the
 * one p4 resolves (see note below).
 *
 * Real values (depot paths, client names, users, hostnames) DO appear in this
 * tool's local output. Findings documents must substitute placeholders
 * (//depot/branch_x/..., testclient, testuser, DESKTOP-TEST).
 *
 * Note on client resolution: p4 on Windows resolves the P4CONFIG file from the
 * PWD environment variable when it is present (measured: a POSIX-form PWD like
 * /e/... breaks the lookup; an absent PWD falls back to the cwd). This script
 * spawns p4 with cwd = the workspace and strips PWD/MSYS* from the child env,
 * so the client that owns the workspace is always the one that resolves.
 *
 * Questions answered (each maps to a probe section below):
 *   A  per-directory batch timing: root + first-level subdirs — does the 10s
 *      ceiling (`perforce.reconcileScan.maxBatchDurationMs`) split the root,
 *      and do subdirs converge?
 *   B  empty / clean / non-depot directory behaviour: exit code + which of
 *      stdout/stderr carries "no file(s) to reconcile" (the clean-vs-failed
 *      judgement in `_reconcileScanBatch` depends on it).
 *   C  `buildScopeFilespec(dir, true)` products: the exact product bytes
 *      (Windows mixed separators, e.g. `X:\workspace\Source/...`), the
 *      forward-slash variant, client syntax `//client/dir/...` and depot
 *      syntax `//depot/dir/...`; paths with spaces; add/edit/delete coverage
 *      with `-a -e -d`.
 *   D  whole-root feasibility: full-scan timing under a 5-minute cap.
 *   E  record shape: is `clientFile` client syntax (so `parseReconcile`'s
 *      clientRoot translation fires)? Does `-Mj` collapse on this server?
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const envOrArg = (envName, flag, dflt) => {
  const fromEnv = process.env[envName]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const i = process.argv.indexOf(flag)
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1]
  return dflt
}

/** Required input: pass it or die with the usage hint. */
const requiredArg = (envName, flag, what) => {
  const value = envOrArg(envName, flag, undefined)
  if (value !== undefined) return value
  console.error(`FATAL: ${flag} is required (${what}) — pass ${flag} <value> or set ${envName}`)
  process.exit(2)
}

const WORKSPACE = requiredArg(
  'UNIVERSE_P4_PROBE_WORKSPACE',
  '--workspace',
  'the real p4 workspace dir to probe',
)
const SKIP_ROOT = process.env['UNIVERSE_P4_PROBE_SKIP_ROOT'] === '1'
const MAX_SUBDIRS = Number(process.env['UNIVERSE_P4_PROBE_MAX_SUBDIRS'] ?? 15)
const SUBDIR_TIMEOUT_MS = Number(process.env['UNIVERSE_P4_PROBE_SUBDIR_TIMEOUT_MS'] ?? 90_000)
const ROOT_TIMEOUT_MS = Number(process.env['UNIVERSE_P4_PROBE_ROOT_TIMEOUT_MS'] ?? 300_000)
const MAX_TOTAL_MS = Number(process.env['UNIVERSE_P4_PROBE_MAX_TOTAL_MS'] ?? 540_000)
const T0 = Date.now()

/** The product ceiling one directory batch is compared against
 *  (`perforce.reconcileScan.maxBatchDurationMs` default). */
const CEILING_MS = 10_000

// --- safety -----------------------------------------------------------------

const ALLOWED_COMMANDS = new Set(['reconcile', 'info', 'fstat', 'where', 'opened', 'changes'])

/** Defensive only — the whitelist refuses `tickets`/`login` outright, so their
 *  output can never be captured or printed in the first place. */
const REDACT_STDOUT = new Set(['tickets', 'login'])

/** The p4 subcommand: args[0] after any leading global output flags. */
const commandOf = (args) => {
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-ztag' || a === '-Mj') continue
    if (!a.startsWith('-')) return a
    return undefined // unknown flag in command position
  }
  return undefined
}

function assertReadOnly(args) {
  const cmd = commandOf(args)
  if (!cmd || !ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`REFUSED: '${cmd ?? '<empty>'}' is not a read-only whitelisted command`)
  }
  if (cmd === 'reconcile' && !args.includes('-n')) {
    throw new Error("REFUSED: 'reconcile' without '-n' would write to the workspace/depot")
  }
}

// --- product-mirror helpers (verbatim from src/p4Filespec.ts) ---------------

const escapeFilespecPath = (path) =>
  path.replace(/%/g, '%25').replace(/@/g, '%40').replace(/#/g, '%23').replace(/\*/g, '%2A')

const buildScopeFilespec = (path, isDirectory) => {
  if (!isDirectory) return escapeFilespecPath(path)
  const trimmed = path.replace(/[/\\]+$/, '')
  return `${escapeFilespecPath(trimmed)}/...`
}

// --- runner -----------------------------------------------------------------

const MS = 1024 * 1024

function childEnv() {
  const env = { ...process.env }
  delete env.PWD // p4 keys P4CONFIG lookup off PWD when present (measured)
  for (const key of Object.keys(env)) {
    if (key.startsWith('MSYS')) delete env[key]
  }
  return env
}

/**
 * Run one p4 command read-only with timing. Returns { args, exitCode, stdout,
 * stderr, elapsedMs, timedOut, stdoutBytes } — never rejects for a non-zero
 * exit (mirrors the extension's P4Service contract).
 */
async function run(args, { timeoutMs = 60_000, maxStdout = 4 * MS, echo = true } = {}) {
  assertReadOnly(args)
  const redact = REDACT_STDOUT.has(commandOf(args) ?? '')
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let aborted = false
  const child = spawn('p4', args, {
    cwd: WORKSPACE,
    shell: false,
    env: childEnv(),
    windowsHide: true,
  })
  const timer = setTimeout(() => {
    aborted = true
    child.kill()
  }, timeoutMs)
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length
    if (!redact && stdout.length < maxStdout) stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
  })
  const exitCode = await new Promise((resolveExit) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  const elapsedMs = Date.now() - started
  const timedOut = aborted || elapsedMs >= timeoutMs
  if (echo) {
    console.log(`  > p4 ${args.join(' ')}`)
    console.log(
      `    exit ${exitCode} in ${elapsedMs}ms${timedOut ? ' (TIMEOUT/killed)' : ''}, ${stdoutBytes} stdout bytes`,
    )
    if (redact) {
      console.log(`    [stdout redacted: ${stdoutBytes} bytes]`)
    } else if (stdout.trim()) {
      const lines = stdout.trimEnd().split(/\r?\n/)
      const shown = lines.slice(0, 12)
      for (const line of shown) {
        console.log(`    | ${line.length > 160 ? line.slice(0, 157) + '...' : line}`)
      }
      if (lines.length > shown.length) console.log(`    | … ${lines.length - shown.length} more line(s)`)
    }
    if (stderr.trim()) {
      const errLines = stderr.trimEnd().split(/\r?\n/).slice(0, 3)
      for (const line of errLines) console.log(`    ! ${line.slice(0, 160)}`)
    }
  }
  return { args, exitCode, stdout, stderr, elapsedMs, timedOut, stdoutBytes }
}

const tag = (title) => console.log(`\n=== ${title} ===`)

// --- output parsing ---------------------------------------------------------

/** Parse `-ztag` output into records (blocks split on blank lines), keeping
 *  only those with a depotFile. */
function ztagRecords(stdout) {
  const out = []
  for (const block of stdout.split(/\r?\n\r?\n|\n\n/)) {
    const rec = {}
    let hasDepot = false
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\.\.\. (\S+) (.*)$/)
      if (!m) continue
      rec[m[1]] = m[2]
      if (m[1] === 'depotFile') hasDepot = true
    }
    if (hasDepot) out.push(rec)
  }
  return out
}

/** Count `... depotFile` lines regardless of block separation (survives
 *  truncated output where the last block is incomplete). */
function countDepotLines(stdout) {
  return (stdout.match(/^\.\.\. depotFile /gm) ?? []).length
}

/** Parse `-Mj` output (one JSON object per line). */
function mjRecords(stdout) {
  const out = []
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip non-JSON tail (truncated) */
    }
  }
  return out
}

/** The product's collapse test: every record carries only a `data` blob. */
function isCollapsed(records) {
  if (records.length === 0) return false
  return records.every((r) => {
    const keys = Object.keys(r)
    return keys.length === 1 && keys[0] === 'data'
  })
}

const actionTally = (records) => {
  const tally = {}
  for (const r of records) {
    const a = String(r.action ?? '?')
    tally[a] = (tally[a] ?? 0) + 1
  }
  return tally
}

const fmtTally = (tally) =>
  Object.entries(tally)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')

// --- filesystem helpers -----------------------------------------------------

/** Direct subdirectories of `dir` — mirrors the product's `_listSubdirs`
 *  (withFileTypes, no symlink follow, no filter). */
function listDirectSubdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/** BFS for the first directory matching `pred` (default depth 3, cap 2000). */
function findDir(root, pred, { maxDepth = 3, cap = 2000 } = {}) {
  const queue = [{ path: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < cap) {
    const { path, depth } = queue.shift()
    for (const full of listDirectSubdirs(path)) {
      visited++
      if (pred(full)) return full
      if (depth + 1 < maxDepth) queue.push({ path: full, depth: depth + 1 })
    }
  }
  return undefined
}

const isEmptyDir = (d) => {
  try {
    return readdirSync(d).length === 0
  } catch {
    return false
  }
}

const hasSpace = (d) => d.split(/[\\/]/).pop()?.includes(' ') ?? false

const relOf = (dir, root) => relative(root, dir).split(sep).join('/')

/** One timed reconcile -n batch over a directory filespec; returns records +
 *  timing. The filespec is built exactly like the product does. */
async function reconcileDir(filespec, { timeoutMs = SUBDIR_TIMEOUT_MS } = {}) {
  const r = await run(['-ztag', 'reconcile', '-n', '-a', '-e', '-d', filespec], {
    timeoutMs,
    echo: false,
  })
  const records = ztagRecords(r.stdout)
  return { ...r, records, count: records.length }
}

// --- probes -----------------------------------------------------------------

/** A/D: whole-root batch — the timing that decides whether the product splits
 *  the root, and whether a non-split full scan is feasible at all. */
async function probeRootScan(mine, subdirs) {
  tag('A/D whole-root reconcile -n (the split trigger + full-scan feasibility)')
  if (SKIP_ROOT) {
    console.log('  skipped (UNIVERSE_P4_PROBE_SKIP_ROOT=1)')
    return undefined
  }
  const fs = buildScopeFilespec(mine.root, true)
  console.log(`  filespec (exact product bytes): ${fs}`)
  const r = await reconcileDir(fs, { timeoutMs: ROOT_TIMEOUT_MS })
  console.log(`  exit=${r.exitCode} elapsed=${r.elapsedMs}ms timedOut=${r.timedOut}`)
  console.log(`  stdout=${r.stdoutBytes} bytes, records=${r.count} (depotFile lines=${countDepotLines(r.stdout)})`)
  console.log(`  action tally: ${fmtTally(actionTally(r.records))}`)
  if (r.stderr.trim())
    console.log(`  stderr head: ${r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 160)}`)
  if (r.timedOut) {
    console.log(
      `  verdict: TIMED OUT under ${ROOT_TIMEOUT_MS}ms — without splitting, a full scan is infeasible`,
    )
  } else if (r.elapsedMs > CEILING_MS) {
    console.log(
      `  verdict: ${r.elapsedMs}ms > ${CEILING_MS}ms ceiling → the product WOULD split the root into its ${subdirs.length} direct subdirectories`,
    )
  } else {
    console.log(`  verdict: within the ${CEILING_MS}ms ceiling — no split`)
  }
  return r
}

/** A: first-level subdirectory batches — do they converge under the ceiling? */
async function probeSubdirTimings(mine, subdirs) {
  tag('A first-level subdirectory batch timings')
  console.log(
    `  ${subdirs.length} direct subdirectories; probing up to ${MAX_SUBDIRS} (env UNIVERSE_P4_PROBE_MAX_SUBDIRS)`,
  )
  const results = []
  for (const dir of subdirs.slice(0, MAX_SUBDIRS)) {
    if (Date.now() - T0 > MAX_TOTAL_MS) {
      console.log('  !! whole-script budget hit — stopping subdir probes')
      break
    }
    const rel = relOf(dir, WORKSPACE)
    const fs = buildScopeFilespec(dir, true)
    const r = await reconcileDir(fs)
    const over = r.elapsedMs > CEILING_MS
    results.push({
      dir,
      rel,
      fs,
      elapsedMs: r.elapsedMs,
      count: r.count,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      over,
      records: r.records,
      stderr: r.stderr,
    })
    console.log(
      `    [${rel}] exit=${r.exitCode} ${r.elapsedMs}ms records=${r.count}${r.timedOut ? ' TIMEOUT' : ''}${over ? `  > ceiling ${CEILING_MS}ms` : ''} | ${fmtTally(actionTally(r.records))}`,
    )
    if (r.exitCode !== 0 && r.stderr.trim())
      console.log(`        stderr: ${r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 160)}`)
  }
  const overCount = results.filter((r) => r.over || r.timedOut).length
  const slowest = results.reduce((a, b) => (b.elapsedMs > a.elapsedMs ? b : a), results[0])
  console.log(
    `  ceiling summary: ${overCount}/${results.length} probed subdirs exceed ${CEILING_MS}ms (each would split one level deeper)`,
  )
  if (slowest) console.log(`  slowest subdir: [${slowest.rel}] ${slowest.elapsedMs}ms ${slowest.count} records`)
  return results
}

/** C: the three filespec syntaxes + a path with a space. */
async function probeFilespecSyntax(mine, subResults) {
  tag('C filespec acceptance: product-local / forward-slash / client / depot syntax')
  const base = subResults.find((r) => r.count > 0 && !r.timedOut) ?? subResults[0]
  if (!base) {
    console.log('  no subdir results — skipping')
    return undefined
  }
  const rel = base.rel
  console.log(`  baseline: [${rel}] local product form, ${base.elapsedMs}ms, ${base.count} records (from A)`)
  console.log(`    filespec was: ${base.fs}`)

  const fwdFs = `${base.dir.replace(/\\/g, '/')}/...`
  const fwd = await reconcileDir(fwdFs)
  console.log(`  forward-slash form ${fwdFs}: exit=${fwd.exitCode} ${fwd.elapsedMs}ms records=${fwd.count}`)
  console.log(`    counts match baseline: ${fwd.count === base.count ? 'YES' : `NO (${base.count} vs ${fwd.count})`}`)

  const clientFs = `//${mine.client}/${rel}/...`
  const client = await reconcileDir(clientFs)
  console.log(`  client form ${clientFs}: exit=${client.exitCode} ${client.elapsedMs}ms records=${client.count}`)
  console.log(`    counts match baseline: ${client.count === base.count ? 'YES' : `NO (${base.count} vs ${client.count})`}`)

  // Depot syntax: derive the depot dir from a record (clientFile strip) and
  // cross-check with `p4 where` on the dir filespec.
  const sample = base.records.find((r) => typeof r.clientFile === 'string' && r.clientFile.startsWith('//'))
  let depotFs
  if (sample) {
    const relPath = sample.clientFile.replace(/^\/\/[^/]+\//, '')
    const depotDir = sample.depotFile
      .slice(0, sample.depotFile.length - relPath.length)
      .replace(/\/+$/, '')
    depotFs = `${depotDir}/...`
    console.log(`  depot form derived from record: ${depotFs}`)
  }
  if (depotFs) {
    const depot = await reconcileDir(depotFs)
    console.log(`  depot form: exit=${depot.exitCode} ${depot.elapsedMs}ms records=${depot.count}`)
    console.log(`    counts match baseline: ${depot.count === base.count ? 'YES' : `NO (${base.count} vs ${depot.count})`}`)
  }
  const where = await run(['-ztag', 'where', base.fs], { timeoutMs: 30_000, echo: false })
  const whereDepot = where.stdout.match(/\.\.\. depotFile (.*)/)?.[1]
  console.log(`  p4 where on the dir filespec: exit=${where.exitCode} depotFile=${whereDepot ?? '(absent)'}`)

  const spaceDir = findDir(WORKSPACE, hasSpace)
  if (!spaceDir) {
    console.log('  space path: no directory with a space found (depth 3) — cannot probe')
  } else {
    const sRel = relOf(spaceDir, WORKSPACE)
    const sFs = buildScopeFilespec(spaceDir, true)
    const sRun = await reconcileDir(sFs)
    console.log(`  space path [${sRel}]: local ${sFs} → exit=${sRun.exitCode} ${sRun.elapsedMs}ms records=${sRun.count}`)
    const sClient = await reconcileDir(`//${mine.client}/${sRel}/...`)
    console.log(`  space path [${sRel}]: client //${mine.client}/${sRel}/... → exit=${sClient.exitCode} ${sClient.elapsedMs}ms records=${sClient.count}`)
    console.log(`    space-path counts agree: ${sRun.count === sClient.count ? 'YES' : `NO (${sRun.count} vs ${sClient.count})`}`)
  }
  return base
}

/** E: record shape (clientFile syntax) + -Mj collapse behaviour. */
async function probeRecordShape(mine, base) {
  tag('E reconcile -n record shape + -Mj collapse on this server')
  if (!base) {
    console.log('  no baseline dir — skipping')
    return
  }
  const samples = base.records.slice(0, 3)
  for (const r of samples) {
    console.log(`  sample: depotFile=${r.depotFile}`)
    console.log(`    clientFile=${r.clientFile} action=${r.action} rev=${r.rev ?? 'ABSENT'}`)
  }
  const clientSyntax = base.records.filter(
    (r) => typeof r.clientFile === 'string' && r.clientFile.startsWith('//'),
  ).length
  console.log(
    `  clientFile syntax: ${clientSyntax}/${base.records.length} records start with '//' ` +
      `(client syntax → parseReconcile's clientRoot translation fires)`,
  )
  // Translate like the product does (clientToLocalPath) and check disk reality.
  let checked = 0
  let onDisk = 0
  for (const r of samples) {
    if (typeof r.clientFile !== 'string' || !r.clientFile.startsWith('//')) continue
    const local = join(mine.root, r.clientFile.replace(/^\/\/[^/]+\//, '').split('/').join(sep))
    const exists = existsSync(local)
    checked++
    if (exists) onDisk++
    console.log(`    translated to ${local} → exists on disk: ${exists}`)
  }
  if (checked > 0)
    console.log(`  translation lands on real files: ${onDisk}/${checked}`)

  console.log(`  -- -Mj vs -ztag on [${base.rel}] (the execRecords primary/fallback path)`)
  const mj = await run(['-Mj', 'reconcile', '-n', '-a', '-e', '-d', base.fs], {
    timeoutMs: SUBDIR_TIMEOUT_MS,
    echo: false,
  })
  const mjRecs = mjRecords(mj.stdout)
  const withDepot = mjRecs.filter((r) => r.depotFile !== undefined).length
  console.log(
    `  -Mj: exit=${mj.exitCode} ${mj.elapsedMs}ms jsonLines=${mjRecs.length} ` +
      `withDepot=${withDepot} collapsed=${isCollapsed(mjRecs)}`,
  )
  console.log(
    `    verdict: ${isCollapsed(mjRecs) ? 'COLLAPSED → execRecords re-runs with -ztag (2× server work per batch)' : 'structured → single -Mj run'}`,
  )
}

/** B: where does "no file(s) to reconcile" land, and with what exit code?
 *  This is the clean-vs-failed judgement `_reconcileScanBatch` relies on. */
async function probeEmptyCleanDir(mine, subResults) {
  tag('B empty / clean / non-depot directory behaviour (the clean-vs-failed judgement)')
  const targets = []

  const empty = findDir(WORKSPACE, isEmptyDir)
  if (empty) targets.push({ kind: 'EMPTY dir (no entries)', dir: empty })
  else console.log('  no empty directory found (depth 3, cap 2000)')

  const clean = subResults.find((r) => r.count === 0 && r.exitCode === 0)
  if (clean) targets.push({ kind: 'CLEAN dir (in depot, zero drift)', dir: clean.dir })
  else console.log('  no clean (0-record, exit 0) first-level subdir found')

  const git = join(WORKSPACE, '.git')
  if (existsSync(git)) targets.push({ kind: 'NON-DEPOT dir (.git — not in client view)', dir: git })
  else targets.push({ kind: '(no .git in workspace — non-depot case skipped)', dir: undefined })

  for (const t of targets) {
    if (!t.dir) continue
    const rel = relOf(t.dir, WORKSPACE)
    const fs = buildScopeFilespec(t.dir, true)
    console.log(`  -- ${t.kind}: [${rel}] filespec ${fs}`)
    const plain = await run(['reconcile', '-n', '-a', '-e', '-d', fs], { timeoutMs: 30_000, echo: false })
    console.log(
      `    plain: exit=${plain.exitCode} ${plain.elapsedMs}ms stdout=${JSON.stringify(plain.stdout.trim())} stderr=${JSON.stringify(plain.stderr.trim())}`,
    )
    const mj = await run(['-Mj', 'reconcile', '-n', '-a', '-e', '-d', fs], { timeoutMs: 30_000, echo: false })
    console.log(
      `    -Mj:   exit=${mj.exitCode} ${mj.elapsedMs}ms stdout=${JSON.stringify(mj.stdout.trim().slice(0, 200))} stderr=${JSON.stringify(mj.stderr.trim())}`,
    )
    const zt = await run(['-ztag', 'reconcile', '-n', '-a', '-e', '-d', fs], { timeoutMs: 30_000, echo: false })
    console.log(
      `    -ztag: exit=${zt.exitCode} ${zt.elapsedMs}ms stdout=${JSON.stringify(zt.stdout.trim().slice(0, 200))} stderr=${JSON.stringify(zt.stderr.trim())}`,
    )
    const matches =
      plain.stderr.toLowerCase().includes('no file(s) to reconcile') ||
      plain.stderr.toLowerCase().includes('- no such file') ||
      plain.stdout.toLowerCase().includes('no file(s) to reconcile')
    console.log(
      `    product check (stderr includes 'no file(s) to reconcile' | '- no such file'): ` +
        `${matches ? 'MATCHES — treated as clean []' : 'NO MATCH on plain output — would read as FAILED → dir never checkpointed, retried every session'}`,
    )
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`workspace: ${WORKSPACE}`)
  if (!existsSync(WORKSPACE)) {
    console.error(`FATAL: workspace ${WORKSPACE} does not exist`)
    process.exit(2)
  }
  const info = await run(['info'], { timeoutMs: 30_000, echo: false })
  const grab = (k) => info.stdout.match(new RegExp(`^${k}: (.*)`, 'm'))?.[1]?.trim()
  const mine = {
    client: grab('Client name'),
    user: grab('User name'),
    root: grab('Client root'),
  }
  console.log(`resolved: user=${mine.user} client=${mine.client} root=${mine.root}`)
  if (info.exitCode !== 0 || !mine.client) {
    console.error('FATAL: p4 info failed — is p4 logged in and the server reachable?')
    process.exit(2)
  }
  if (mine.root && resolve(mine.root).toLowerCase() !== resolve(WORKSPACE).toLowerCase()) {
    console.error(
      'FATAL: resolved client root does not match the workspace dir; aborting to avoid probing the wrong client',
    )
    process.exit(2)
  }

  const subdirs = listDirectSubdirs(WORKSPACE)
  console.log(`direct subdirectories of the workspace: ${subdirs.length} (${subdirs.map((d) => relOf(d, WORKSPACE)).join(', ')})`)

  await probeRootScan(mine, subdirs)
  const subResults = await probeSubdirTimings(mine, subdirs)
  const base = await probeFilespecSyntax(mine, subResults)
  await probeRecordShape(mine, base)
  await probeEmptyCleanDir(mine, subResults)
  console.log(`\ndone. total wall time ${Math.round((Date.now() - T0) / 1000)}s`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
