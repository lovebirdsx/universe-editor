#!/usr/bin/env node
/**
 * DESTRUCTIVE real-server probe for the extensions/perforce sync + resolve
 * round. Zero dependencies, plain Node (>= 18). Sister script of
 * probe-real-workspace.mjs (the read-only one): this one really syncs to disk,
 * triggers clobber refusals, creates conflicts and resolves them — all inside
 * a THROWAWAY temp client, so the real workspace is only ever READ from.
 *
 * What it verifies (results in e2e/fixtures/PROBE-FINDINGS.md §11):
 *   S1. Real `p4 sync` to-disk line shapes → parseSyncOutput's counters
 *       (applied / keptOpen / mustResolve / upToDate) + the `unrecognized` trap.
 *   S2. `p4 sync -f` on a clean file: `- refreshing <local>` (no `as`).
 *   S3. Clobber refusal: local edit (not opened) + sync → exact message, exact
 *       exit code, stdout vs stderr; `-f` does clobber the local draft.
 *   S4. keptOpen trigger ("is opened and not being changed" + a co-emitted
 *       "must resolve #N" line) and whether it schedules a resolve (it does);
 *       the `unresolved` bare key in `p4 opened` (absent!) vs `p4 fstat`
 *       (present); sync -f / sync on an unresolved file.
 *   S5a. resolve -am on the keptOpen-scheduled state: full `merging` /
 *        `Diff chunks` / `merge from` transcript, exit 0.
 *   S5b. Genuine conflicting resolve (built by editing the same line the head
 *        rev changed): -am skips with `resolve skipped.` and exits 0 (the
 *        phase-5 premise), -am on a mergeable edit lands, -ay / -at
 *        transcripts.
 *   S5c. shelve+unshelve: unshelve does NOT schedule a resolve on this server
 *        (opens at the shelf's base rev; `resolve -n` reports nothing).
 *   S6. open-for-add fstat: haveRev key absent vs string 'none' (decides
 *       whether the status bar's `action === 'add'` branch fires), in both
 *       -ztag and -Mj (the production path).
 *   S7. Mixed transcript: clobber + must-resolve + kept-open lines in one run
 *       → which counters fire; a clobber aborts the whole run (exit 1).
 *
 * Usage:
 *   node probe-real-sync.mjs --workspace <dir> --narrow <relDir> [--file <depotFile>] [--keep-temp]
 *   env overrides: UNIVERSE_P4_PROBE_WORKSPACE / UNIVERSE_P4_PROBE_NARROW /
 *                  UNIVERSE_P4_PROBE_FILE
 *   --keep-temp skips cleanup (debug only; the default reverts + deletes the
 *   throwaway client and removes the temp dir).
 *
 * Isolation (red lines, enforced by assertCommandSafe — a violation throws and
 * aborts the whole run):
 *   - The workspace (REQUIRED — pass --workspace or the env var; no default) is
 *     READ ONLY: any command run with
 *     cwd = workspace must be on the read-only whitelist; write commands only
 *     ever run with cwd inside the temp dir.
 *   - Every write command must pin `-c <tmp_probe_*>` and must not mention the
 *     workspace path or the ambient client name in any argument.
 *   - A throwaway client `tmp_probe_<pid>` maps a tiny depot dir (plus at most
 *     one single file) into an os-tmpdir root. The finally block + a sync
 *     process-exit handler revert everything, delete shelves + their emptied
 *     changelists, delete the client (plain `-d` — measured, `-f` is
 *     permission-denied for non-admins on this server) and rm the temp dir.
 *     Stale `tmp_probe_*` clients from crashed runs are reverted + deleted at
 *     startup.
 *   - No `-p`/`-P`/`-u`/`-H` global options ever; no login/tickets commands at
 *     all, so no ticket/password is ever printed. Connection config is copied
 *     from the workspace's own P4CONFIG file (only P4PORT/P4USER/P4CHARSET)
 *     into a P4CONFIG inside the temp dir — the temp client connects exactly
 *     the way the real one does.
 *   - No depot writes: submit / integrate / delete / obliterate / ... are
 *     refused outright.
 *
 * The P4CONFIG trap applies here too (see probe-real-workspace.mjs header):
 * p4 on Windows resolves the config file from the PWD env var when present, so
 * every spawn strips PWD/MSYS* and passes an explicit cwd.
 *
 * Real values (depot paths, client names, users, ports) DO appear in this
 * tool's local output. Findings documents must substitute placeholders
 * (//depot/branch_x/..., tmp_probe_N, testclient, testuser).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

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
  'the real p4 workspace dir to READ from',
)
const NARROW = requiredArg(
  'UNIVERSE_P4_PROBE_NARROW',
  '--narrow',
  'a relative dir inside the workspace with pending updates',
)
const PINNED_FILE = envOrArg('UNIVERSE_P4_PROBE_FILE', '--file', '')
const TEMP_BASE = envOrArg('UNIVERSE_P4_PROBE_TEMP', '--temp', tmpdir())
const KEEP_TEMP = process.argv.includes('--keep-temp')

const clientName = `tmp_probe_${process.pid}`
const tempRoot = join(TEMP_BASE, clientName)

// --- verbatim mirror of src/syncParser.ts regexes (keep in sync) ------------

const APPLIED_LINE = / - (updated|added|deleted|refreshing|refreshed|updating)( as)? /i
const KEPT_OPEN_LINE = /is opened and (can't be replaced|not being changed)/i
const MUST_RESOLVE_LINE = / must resolve /i
const UP_TO_DATE_LINE = /file\(s\) up-to-date/i
const LANDED_LINE = / - (copy from|merged) /i
const SKIPPED_LINE = /resolve skipped/i

function parseSyncOutput(stdout, stderr) {
  let applied = 0
  let keptOpen = 0
  let mustResolve = 0
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (APPLIED_LINE.test(line)) applied++
    else if (KEPT_OPEN_LINE.test(line)) keptOpen++
    else if (MUST_RESOLVE_LINE.test(line)) mustResolve++
  }
  const upToDate = UP_TO_DATE_LINE.test(`${stdout}\n${stderr}`)
  const unrecognized =
    stdout.trim() !== '' && applied === 0 && keptOpen === 0 && mustResolve === 0 && !upToDate
  return { applied, keptOpen, mustResolve, upToDate, unrecognized }
}

function parseResolveOutput(stdout) {
  let merged = 0
  let remaining = 0
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (LANDED_LINE.test(line)) merged++
    else if (SKIPPED_LINE.test(line)) remaining++
  }
  const unrecognized = stdout.trim() !== '' && merged === 0 && remaining === 0
  return { merged, remaining, unrecognized }
}

const bucketSyncLines = (stdout) => {
  const buckets = { applied: [], keptOpen: [], mustResolve: [], unrecognized: [] }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (APPLIED_LINE.test(line)) buckets.applied.push(line)
    else if (KEPT_OPEN_LINE.test(line)) buckets.keptOpen.push(line)
    else if (MUST_RESOLVE_LINE.test(line)) buckets.mustResolve.push(line)
    else buckets.unrecognized.push(line)
  }
  return buckets
}

const bucketResolveLines = (stdout) => {
  const buckets = { merged: [], skipped: [], unrecognized: [] }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (LANDED_LINE.test(line)) buckets.merged.push(line)
    else if (SKIPPED_LINE.test(line)) buckets.skipped.push(line)
    else buckets.unrecognized.push(line)
  }
  return buckets
}

const showSyncVerdict = (title, res) => {
  const summary = parseSyncOutput(res.stdout, res.stderr)
  console.log(
    `  → ${title}: applied=${summary.applied} keptOpen=${summary.keptOpen} mustResolve=${summary.mustResolve} upToDate=${summary.upToDate} unrecognized=${summary.unrecognized}`,
  )
  if (summary.unrecognized) {
    const b = bucketSyncLines(res.stdout)
    for (const line of b.unrecognized)
      console.log(`    UNRECOGNIZED-LINE: |${line.slice(0, 160)}|`)
  }
  return summary
}

const showResolveVerdict = (title, res) => {
  const summary = parseResolveOutput(res.stdout)
  console.log(
    `  → ${title}: merged=${summary.merged} remaining=${summary.remaining} unrecognized=${summary.unrecognized}`,
  )
  if (summary.unrecognized) {
    const b = bucketResolveLines(res.stdout)
    for (const line of b.unrecognized)
      console.log(`    UNRECOGNIZED-LINE: |${line.slice(0, 160)}|`)
  }
  return summary
}

// --- safety guards ----------------------------------------------------------

const READ_ONLY_COMMANDS = new Set([
  'info',
  'changes',
  'opened',
  'fstat',
  'clients',
  'where',
  'print',
  'set',
  'filelog',
  'files',
  'diff',
  'diff2',
  'describe',
])

const WRITE_COMMANDS = new Set([
  'sync',
  'edit',
  'add',
  'revert',
  'client',
  'resolve',
  'shelve',
  'unshelve',
  'change',
  'reopen',
])

/** Anything that writes to the DEPOT, touches credentials, or is simply out of
 *  scope for this probe — refused outright, in every phase. */
const FORBIDDEN = new Set([
  'submit',
  'integrate',
  'copy',
  'merge',
  'obliterate',
  'delete',
  'rename',
  'move',
  'labelsync',
  'label',
  'branch',
  'user',
  'passwd',
  'login',
  'tickets',
  'protect',
  'stream',
  'streams',
  'verify',
  'configure',
  'workspace',
  'clean',
])

let AMBIENT_CLIENT = ''
let CLIENT_CREATED = false
const SHELVED_CLS = []

const commandOf = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-c') {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return a
  }
  return undefined
}

function assertCommandSafe(args, phase, cwd) {
  const cmd = commandOf(args)
  if (!cmd) throw new Error(`REFUSED: no command found in ${JSON.stringify(args)}`)
  if (FORBIDDEN.has(cmd))
    throw new Error(`REFUSED: '${cmd}' writes to the depot / touches credentials — red line`)
  if (!READ_ONLY_COMMANDS.has(cmd) && !WRITE_COMMANDS.has(cmd))
    throw new Error(`REFUSED: '${cmd}' is not on the probe's allowlist`)
  if (args.includes('-p') || args.includes('-P') || args.includes('-u') || args.includes('-H'))
    throw new Error('REFUSED: global option -p/-P/-u/-H is banned (red line: no derived port)')
  if (phase === 'workspace-ro') {
    if (!READ_ONLY_COMMANDS.has(cmd))
      throw new Error(`REFUSED: '${cmd}' is a write command but the cwd is the real workspace`)
    return
  }
  if (phase !== 'temp') throw new Error(`REFUSED: unknown phase '${phase}'`)
  if (resolve(cwd).toLowerCase() !== resolve(tempRoot).toLowerCase())
    throw new Error('REFUSED: write-capable phase must run with cwd = the temp dir')
  if (WRITE_COMMANDS.has(cmd)) {
    const ci = args.indexOf('-c')
    const pinned = ci !== -1 ? args[ci + 1] : undefined
    const isCreate = cmd === 'client' && args.includes('-i')
    if (!isCreate && !(pinned === clientName || /^tmp_probe_/.test(pinned ?? '')))
      throw new Error(`REFUSED: write command '${cmd}' is not pinned to a tmp_probe_* client (-c)`)
    for (const a of args) {
      if (typeof a !== 'string' || a.startsWith('-')) continue
      const lower = a.toLowerCase()
      if (WORKSPACE.length > 3 && lower.includes(WORKSPACE.toLowerCase()))
        throw new Error(`REFUSED: argument '${a}' mentions the real workspace path`)
      if (AMBIENT_CLIENT && lower.includes(AMBIENT_CLIENT.toLowerCase()))
        throw new Error(`REFUSED: argument '${a}' mentions the ambient client name`)
      if (!a.startsWith('//') && !/[#@]/.test(a)) {
        // A bare local path argument must live under the temp dir.
        const abs = resolve(cwd, a).toLowerCase()
        if (!abs.startsWith(resolve(tempRoot).toLowerCase()))
          throw new Error(`REFUSED: local path argument '${a}' resolves outside the temp dir`)
      }
    }
  }
}

// --- runner -----------------------------------------------------------------

const MS = 1024 * 1024

function childEnv(phase) {
  const env = { ...process.env }
  delete env.PWD // p4 keys P4CONFIG lookup off PWD when present (measured)
  for (const key of Object.keys(env)) if (key.startsWith('MSYS')) delete env[key]
  if (phase === 'temp') {
    // The temp dir's P4CONFIG is the single source of connection truth; any
    // inherited override would make the temp client connect differently from
    // the real workspace.
    for (const key of [
      'P4PORT',
      'P4USER',
      'P4CLIENT',
      'P4CHARSET',
      'P4CONFIG',
      'P4PASSWD',
      'P4TICKETS',
      'P4ENVIRO',
    ])
      delete env[key]
  }
  return env
}

/** Run one p4 command with timing. Returns { args, exitCode, stdout, stderr,
 *  elapsedMs, timedOut } — never rejects for a non-zero exit. */
async function run(args, { cwd, phase, timeoutMs = 60_000, echo = true, stdin, label } = {}) {
  assertCommandSafe(args, phase, cwd)
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let aborted = false
  const child = spawn('p4', args, {
    cwd,
    shell: false,
    env: childEnv(phase),
    windowsHide: true,
  })
  if (stdin !== undefined) {
    child.stdin.write(stdin)
    child.stdin.end()
  }
  const timer = setTimeout(() => {
    aborted = true
    child.kill()
  }, timeoutMs)
  child.stdout.on('data', (c) => {
    if (stdout.length < 4 * MS) stdout += c.toString('utf8')
  })
  child.stderr.on('data', (c) => {
    if (stderr.length < 64 * 1024) stderr += c.toString('utf8')
  })
  const exitCode = await new Promise((res) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      res(code)
    })
    // A spawn failure (ENOENT / cwd gone) must settle the promise — never let
    // the 'error' event escape (the product's p4Service has the same rule).
    child.on('error', (err) => {
      clearTimeout(timer)
      stderr += `[spawn failed: ${err.code}]`
      res(1)
    })
  })
  const elapsedMs = Date.now() - started
  if (echo) {
    console.log(`\n  > p4 ${args.join(' ')}${label ? `  [${label}]` : ''}`)
    console.log(`    exit ${exitCode} in ${elapsedMs}ms${aborted ? ' (TIMEOUT/killed)' : ''}`)
    for (const line of stdout.trimEnd().split(/\r?\n/).slice(0, 30))
      console.log(`    | ${line.length > 160 ? line.slice(0, 157) + '...' : line}`)
    for (const line of stderr.trimEnd().split(/\r?\n/).slice(0, 8))
      console.log(`    ! ${line.slice(0, 160)}`)
  }
  return { args, exitCode, stdout, stderr, elapsedMs, timedOut: aborted }
}

const tag = (title) => console.log(`\n=== ${title} ===`)

// --- small helpers ----------------------------------------------------------

const ztagBlocks = (stdout) =>
  stdout
    .split(/\r?\n\r?\n|\n\n/)
    .map((b) => b.trim())
    .filter((b) => b.includes('depotFile'))

const field = (block, key) => block.match(new RegExp(`\\.\\.\\. ${key} (.*)`))?.[1]

function makeWritableTree(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) makeWritableTree(p)
    else {
      try {
        chmodSync(p, 0o666)
      } catch {}
    }
  }
  try {
    chmodSync(dir, 0o777)
  } catch {}
}

function fatal(msg) {
  console.error(`FATAL: ${msg}`)
  process.exit(2)
}

// --- connection + client setup ----------------------------------------------

async function discoverConnection() {
  const info = await run(['info'], { cwd: WORKSPACE, phase: 'workspace-ro', echo: false })
  const grab = (k) => info.stdout.match(new RegExp(`^${k}: (.*)`, 'm'))?.[1]?.trim()
  const ambient = { client: grab('Client name'), user: grab('User name'), root: grab('Client root') }
  AMBIENT_CLIENT = ambient.client ?? ''
  console.log(
    `ambient (read-only source): user=${ambient.user} client=${ambient.client} root=${ambient.root}`,
  )
  if (info.exitCode !== 0 || !ambient.client)
    fatal('p4 info failed — is p4 logged in and the server reachable?')
  if (ambient.root && resolve(ambient.root).toLowerCase() !== resolve(WORKSPACE).toLowerCase())
    fatal('resolved client root does not match the workspace dir; aborting to avoid probing the wrong client')

  const cfgName = process.env['P4CONFIG'] || '.p4config'
  let cfgFile
  let dir = resolve(WORKSPACE)
  for (;;) {
    const candidate = join(dir, cfgName)
    if (existsSync(candidate)) {
      cfgFile = candidate
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const cfg = { P4PORT: '', P4USER: '', P4CHARSET: '' }
  if (cfgFile) {
    for (const line of readFileSync(cfgFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
      if (m && m[1] in cfg) cfg[m[1]] = m[2].trim()
    }
    console.log(`connection config copied from ${cfgFile} (keys P4PORT/P4USER/P4CHARSET; values not echoed)`)
  } else {
    for (const key of ['P4PORT', 'P4USER', 'P4CHARSET']) {
      const r = await run(['set', key], { cwd: WORKSPACE, phase: 'workspace-ro', echo: false })
      const m = r.stdout.match(new RegExp(`^${key}=(.*)$`, 'm'))
      cfg[key] = (m?.[1] ?? '').replace(/\s*\(.*\)\s*$/, '').trim()
    }
    console.log(`connection config taken from 'p4 set <key>' (no P4CONFIG file found; values not echoed)`)
  }
  if (!cfg.P4PORT || !cfg.P4USER) fatal('could not discover P4PORT/P4USER — cannot build the temp P4CONFIG')
  return { ambient, cfgName, cfg }
}

async function cleanStaleClients() {
  const r = await run(['-ztag', 'clients', '-e', 'tmp_probe_*'], {
    cwd: WORKSPACE,
    phase: 'workspace-ro',
    echo: false,
  })
  const names = [...r.stdout.matchAll(/\.\.\. client (.*)/g)].map((m) => m[1])
  const stale = names.filter((n) => n !== clientName)
  if (stale.length === 0) {
    console.log('no stale tmp_probe_* clients found')
    return
  }
  console.log(`stale tmp_probe_* client(s) found: ${stale.join(', ')} — reverting + deleting`)
  for (const name of stale) {
    await run(['-c', name, 'revert', '//...'], { cwd: tempRoot, phase: 'temp', label: 'stale revert' })
    // Plain -d first: measured, `-f` is permission-denied for non-admins here.
    const d = await run(['-c', name, 'client', '-d', name], { cwd: tempRoot, phase: 'temp' })
    if (d.exitCode !== 0) {
      const d2 = await run(['-c', name, 'client', '-d', '-f', name], { cwd: tempRoot, phase: 'temp' })
      if (d2.exitCode !== 0) console.log(`!! could not delete stale client ${name} (owner/admin needed?)`)
    }
  }
}

async function discoverDepotDir() {
  const w = await run(['-ztag', 'where', join(WORKSPACE, NARROW)], {
    cwd: WORKSPACE,
    phase: 'workspace-ro',
    label: 'map narrow dir to depot',
  })
  const depot = w.stdout.match(/\.\.\. depotFile (.*)/)?.[1]?.replace(/\/+$/, '')
  if (!depot || !depot.startsWith('//'))
    fatal(`could not map ${WORKSPACE}/${NARROW} to a depot dir (not in client view?) — pass --narrow pointing at a dir that exists in the workspace`)
  return depot
}

/** Pick up to two small multi-rev text files: the primary (clobber/keptOpen/
 *  resolve scenarios) and an extra one (the mixed-transcript clobber victim).
 *  Runs BEFORE the client exists, via the ambient client (read-only): a capped
 *  `p4 files` scan of the narrow dir first, then of the parent scope. Out-of-
 *  scope files are mapped into the temp client with single-file view lines. */
async function discoverConflictFiles(depotDir) {
  const out = []
  const take = (depotFile, rev, inDir) => {
    out.push({ depotFile, headRev: rev, inDir })
    console.log(
      `  chosen candidate #${out.length}: ${depotFile} headRev=${rev}${inDir ? ' (in narrow view)' : ' (single-file view mapping)'}`,
    )
  }
  if (PINNED_FILE && PINNED_FILE.startsWith('//')) {
    const f = await run(['-ztag', 'fstat', PINNED_FILE], {
      cwd: WORKSPACE,
      phase: 'workspace-ro',
      label: 'fstat the pinned file',
    })
    const b = ztagBlocks(f.stdout)[0] ?? ''
    const headRev = Number(field(b, 'headRev'))
    const headType = field(b, 'headType') ?? ''
    if (headRev >= 2 && /^text/.test(headType)) {
      take(PINNED_FILE, headRev, depotDir !== undefined && PINNED_FILE.startsWith(`${depotDir}/`))
    } else {
      console.log(`  !! pinned file is not a multi-rev text file (headRev=${headRev} type=${headType})`)
    }
    return out
  }
  const scopes = [`${depotDir}/...`, `${depotDir.slice(0, depotDir.lastIndexOf('/'))}/...`]
  for (const scope of scopes) {
    const r = await run(['-ztag', 'files', '-m', '2000', scope], {
      cwd: WORKSPACE,
      phase: 'workspace-ro',
      timeoutMs: 120_000,
      echo: false,
      label: `files scan ${scope}`,
    })
    const cands = ztagBlocks(r.stdout)
      .map((b) => ({ depotFile: field(b, 'depotFile'), rev: Number(field(b, 'rev')), type: field(b, 'type') ?? '' }))
      .filter((c) => c.depotFile && c.rev >= 2 && /^text/.test(c.type))
    console.log(`  ${scope}: ${cands.length} multi-rev text candidate(s) in the first 2000 records`)
    for (const c of cands) {
      if (out.some((o) => o.depotFile === c.depotFile)) continue
      // The head rev must differ in CONTENT from the previous one, otherwise
      // unshelve would auto-merge and no resolve state could be created.
      // Measured: this server's `p4 diff2` (no -u) prints ed-style output —
      // change commands are lines starting with a digit (`3c3` + `<`/`>`);
      // identical content prints `==== ... ==== identical` and nothing else.
      const d = await run(['diff2', `${c.depotFile}#${c.rev - 1}`, `${c.depotFile}#${c.rev}`], {
        cwd: WORKSPACE,
        phase: 'workspace-ro',
        echo: false,
      })
      if (!/^[0-9]/m.test(d.stdout)) continue
      take(c.depotFile, c.rev, c.depotFile.startsWith(`${depotDir}/`))
      if (out.length >= 2) return out
    }
  }
  if (out.length === 0)
    console.log('  !! no multi-rev text file found — conflict scenarios skipped (recorded as unverified)')
  return out
}

// --- cleanup ----------------------------------------------------------------

let cleanupDone = false
async function cleanup() {
  if (cleanupDone) return
  cleanupDone = true
  if (!CLIENT_CREATED && !existsSync(tempRoot)) {
    console.log('\ncleanup: nothing to clean (client was never created)')
    return
  }
  console.log('\n=== cleanup ===')
  if (!existsSync(tempRoot)) {
    console.log('  temp dir already gone — skipping p4 cleanup steps')
    return
  }
  await run(['-c', clientName, 'revert', '//...'], {
    cwd: tempRoot,
    phase: 'temp',
    timeoutMs: 120_000,
    label: 'revert everything opened in the throwaway client',
  })
  for (const cl of SHELVED_CLS) {
    await run(['-c', clientName, 'shelve', '-d', '-c', cl], {
      cwd: tempRoot,
      phase: 'temp',
      label: 'delete probe shelf',
    })
    // Delete the emptied numbered CL too — pending changelists survive their
    // client's deletion and would linger as server-side garbage.
    await run(['-c', clientName, 'change', '-d', cl], {
      cwd: tempRoot,
      phase: 'temp',
      label: 'delete emptied probe changelist',
    })
  }
  // Measured on this server: `client -d -f` is DENIED for non-admin users
  // ("You don't have permission for this operation."), while plain `client -d`
  // works for the owner. So: plain first, -f only as a best-effort fallback.
  let d = await run(['-c', clientName, 'client', '-d', clientName], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'delete throwaway client',
  })
  if (d.exitCode !== 0) {
    console.log('  plain delete failed — trying -f (may be permission-denied on this server)')
    d = await run(['-c', clientName, 'client', '-d', '-f', clientName], {
      cwd: tempRoot,
      phase: 'temp',
      label: 'delete throwaway client (-f)',
    })
  }
  if (d.exitCode !== 0) {
    console.error(`!! CLIENT DELETE FAILED (exit ${d.exitCode}) — manual cleanup required: p4 -c ${clientName} client -d ${clientName}`)
  } else {
    console.log(`  client ${clientName} deleted (exit 0)`)
  }
  const check = await run(['-ztag', 'clients', '-e', 'tmp_probe_*'], {
    cwd: WORKSPACE,
    phase: 'workspace-ro',
    echo: false,
    label: 'verify deletion',
  })
  const remaining = [...check.stdout.matchAll(/\.\.\. client (.*)/g)].map((m) => m[1])
  console.log(`  remaining tmp_probe_* clients: ${remaining.length === 0 ? 'NONE' : remaining.join(', ')}`)
  makeWritableTree(tempRoot)
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    console.log(`  temp dir removed: ${tempRoot}`)
  } catch (err) {
    console.error(`  !! temp dir removal failed: ${err.message}`)
  }
}

// Belt-and-braces: even a hard crash / Ctrl+C / process.exit mid-run reverts
// and deletes the throwaway client (sync spawnSync, safe inside 'exit').
let exitHandlerArmed = false
function armExitHandler() {
  if (exitHandlerArmed) return
  exitHandlerArmed = true
  process.on('exit', () => {
    try {
      if (CLIENT_CREATED && existsSync(tempRoot)) {
        const env = childEnv('temp')
        spawnSync('p4', ['-c', clientName, 'revert', '//...'], {
          cwd: tempRoot,
          env,
          stdio: 'ignore',
          windowsHide: true,
        })
        for (const cl of SHELVED_CLS) {
          spawnSync('p4', ['-c', clientName, 'shelve', '-d', '-c', cl], {
            cwd: tempRoot,
            env,
            stdio: 'ignore',
            windowsHide: true,
          })
          spawnSync('p4', ['-c', clientName, 'change', '-d', cl], {
            cwd: tempRoot,
            env,
            stdio: 'ignore',
            windowsHide: true,
          })
        }
        // Plain -d first (this server denies -f for non-admins); -f fallback
        // is best-effort only.
        const del = spawnSync('p4', ['-c', clientName, 'client', '-d', clientName], {
          cwd: tempRoot,
          env,
          stdio: 'ignore',
          windowsHide: true,
        })
        if (del.status !== 0)
          spawnSync('p4', ['-c', clientName, 'client', '-d', '-f', clientName], {
            cwd: tempRoot,
            env,
            stdio: 'ignore',
            windowsHide: true,
          })
      }
      makeWritableTree(tempRoot)
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // best effort — the next run's stale scan catches leftovers
    }
  })
}

// --- scenarios --------------------------------------------------------------

async function scenarioS1InitialSync(scope) {
  tag('S1 real sync to disk — line shapes + parseSyncOutput counts')
  const s1 = await run(['-c', clientName, 'sync', scope], {
    cwd: tempRoot,
    phase: 'temp',
    timeoutMs: 240_000,
    label: 'initial full sync (fresh client)',
  })
  const summary = showSyncVerdict('initial sync parse', s1)
  const totalLines = s1.stdout.trim().split(/\r?\n/).filter(Boolean).length
  console.log(`  raw stdout lines: ${totalLines} (fresh client ⇒ expect all 'added as')`)
  tag('S1b up-to-date re-check (stderr + exit 0?)')
  const s2 = await run(['-c', clientName, 'sync', scope], {
    cwd: tempRoot,
    phase: 'temp',
    timeoutMs: 120_000,
    label: 'second sync (nothing to do)',
  })
  showSyncVerdict('up-to-date parse', s2)
  return summary
}

async function scenarioS2SyncForce(local) {
  tag('S2 sync -f on a clean file — refreshing line shape')
  const r = await run(['-c', clientName, 'sync', '-f', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'force sync clean file',
  })
  showSyncVerdict('sync -f parse', r)
  return r
}

async function scenarioS3Clobber(depotFile, local, headRev) {
  tag('S3 clobber refusal — local edit (not opened) + sync while have < head')
  await run(['-c', clientName, 'sync', `${depotFile}#${headRev - 1}`], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync down to #N-1 (so the server has something to write)',
  })
  try {
    chmodSync(local, 0o666) // clear the read-only bit
  } catch {}
  const marker = '--probe-local-draft--\n'
  writeFileSync(local, marker, { flag: 'a' })
  const r1 = await run(['-c', clientName, 'sync', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync over a writable modified file',
  })
  console.log(
    `  classifySyncError('can't clobber writable file' match): ${`${r1.stderr}\n${r1.stdout}`.toLowerCase().includes("can't clobber writable file") ? 'MATCHES' : 'NO MATCH'}`,
  )
  const r2 = await run(['-c', clientName, 'sync', '-f', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync -f over the same file (clobbers the local draft)',
  })
  showSyncVerdict('sync -f clobber parse', r2)
  const restored = !readFileSync(local, 'utf8').includes('--probe-local-draft--')
  console.log(`  local draft overwritten by -f: ${restored ? 'YES (content restored)' : 'NO (draft survived!)'}`)
  return { r1, r2 }
}

async function scenarioS4KeptOpen(depotFile, local, headRev) {
  tag('S4 keptOpen trigger (sync on an opened file with have < head)')
  const prev = headRev - 1
  const rSyncDown = await run(['-c', clientName, 'sync', `${depotFile}#${prev}`], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync down to #N-1',
  })
  showSyncVerdict('backward sync parse', rSyncDown)
  await run(['-c', clientName, 'edit', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'open for edit at #N-1',
  })
  writeFileSync(local, '--probe-kept-open-edit--\n', { flag: 'a' })
  const rSync = await run(['-c', clientName, 'sync', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync while opened (keptOpen trigger)',
  })
  showSyncVerdict('keptOpen sync parse', rSync)
  const rResolveN = await run(['-c', clientName, 'resolve', '-n'], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -n after the keptOpen sync',
  })
  const scheduled = /merging|must resolve|resolving/i.test(rResolveN.stdout)
  console.log(`  needs-resolve scheduled by the keptOpen sync: ${scheduled ? 'YES' : 'NO'}`)
  const rOpened = await run(['-c', clientName, '-ztag', 'opened', local], {
    cwd: tempRoot,
    phase: 'temp',
    echo: false,
    label: 'opened record (keptOpen state)',
  })
  const block = ztagBlocks(rOpened.stdout)[0] ?? ''
  console.log(
    `  opened record: action=${field(block, 'action')} rev=${field(block, 'rev')} haveRev=${field(block, 'haveRev')} unresolvedKeyPresent=${block.includes('... unresolved')}`,
  )
  const rForce = await run(['-c', clientName, 'sync', '-f', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync -f while opened (fake-p4 model: updates + schedules resolve)',
  })
  showSyncVerdict('sync -f on opened parse', rForce)
  const rResolveN2 = await run(['-c', clientName, 'resolve', '-n'], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -n after sync -f',
  })
  console.log(
    `  still needs-resolve after sync -f: ${/merging|must resolve|resolving/i.test(rResolveN2.stdout) ? 'YES' : 'NO'}`,
  )
  return { scheduled, block }
}

async function scenarioS5aResolveKeptOpenState(local) {
  tag('S5a resolve on the keptOpen-scheduled state (append edit vs head line change = mergeable)')
  const rFstat = await run(['-c', clientName, '-ztag', 'fstat', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'fstat of the unresolved file',
  })
  const keys = [...rFstat.stdout.matchAll(/^\.\.\. (\w+)(?: |$)/gm)].map((m) => m[1])
  console.log(`  fstat keys: [${keys.join(', ')}]`)
  await run(['-c', clientName, 'resolve', '-n'], { cwd: tempRoot, phase: 'temp', label: 'resolve -n preview' })
  const rSyncUnresolved = await run(['-c', clientName, 'sync', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'sync on an unresolved file (mustResolve sync line?)',
  })
  showSyncVerdict('sync-on-unresolved parse', rSyncUnresolved)
  const rAm = await run(['-c', clientName, 'resolve', '-am', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -am (mergeable conflict)',
  })
  showResolveVerdict('resolve -am (mergeable) parse', rAm)
  const rAm2 = await run(['-c', clientName, 'resolve', '-am', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -am again (nothing left)',
  })
  showResolveVerdict('resolve -am (already resolved) parse', rAm2)
}

/** Build a local content whose edit overlaps the head change on a changed
 *  line: both sides modify line X (the first line where #N-1 and #N differ),
 *  so the resolve merge must report a CONFLICTING chunk. Fallback: append. */
function conflictingLocalContent(prev, head) {
  const p = prev.split(/\r?\n/)
  const h = head.split(/\r?\n/)
  for (let i = 0; i < Math.min(p.length, h.length); i++) {
    if (p[i] !== h[i]) {
      const out = h.slice()
      out[i] = `${h[i]} --probe-conflicting-edit--`
      return { content: out.join('\n'), line: i + 1 }
    }
  }
  return { content: head + '--probe-conflicting-append--\n', line: 'append' }
}

async function scenarioS5bResolveRealConflict(depotFile, local, headRev) {
  tag('S5b genuine conflicting resolve — -am skip, -am merged, -ay, -at')
  const printRev = async (rev) =>
    (
      await run(['-c', clientName, 'print', '-q', `${depotFile}#${rev}`], {
        cwd: tempRoot,
        phase: 'temp',
        echo: false,
        label: `print #${rev}`,
      })
    ).stdout
  const prevContent = await printRev(headRev - 1)
  const headContent = await printRev(headRev)
  const { content: conflictContent, line } = conflictingLocalContent(prevContent, headContent)
  console.log(`  conflicting edit constructed on line ${line} (both sides modify it)`)
  // Depot content may be CRLF while our writes are LF — compare normalized.
  const readNorm = () => readFileSync(local, 'utf8').replace(/\r\n/g, '\n')

  // Deterministic conflict builder: open at #N-1 → keptOpen sync (have bumped
  // to head, resolve scheduled, merge base = the opened rev) → write the
  // overlapping local edit. No depot writes, no shelves.
  const buildConflict = async (label) => {
    await run(['-c', clientName, 'revert', local], { cwd: tempRoot, phase: 'temp', echo: false, label: `${label}: revert` })
    await run(['-c', clientName, 'sync', `${depotFile}#${headRev - 1}`], {
      cwd: tempRoot,
      phase: 'temp',
      echo: false,
      label: `${label}: sync #N-1`,
    })
    await run(['-c', clientName, 'edit', local], { cwd: tempRoot, phase: 'temp', echo: false, label: `${label}: edit` })
    await run(['-c', clientName, 'sync', local], { cwd: tempRoot, phase: 'temp', echo: false, label: `${label}: keptOpen sync` })
    // Open for edit ⇒ read-only bit cleared ⇒ the write succeeds.
    writeFileSync(local, conflictContent)
  }

  await buildConflict('conflict')
  const rOpened = await run(['-c', clientName, '-ztag', 'opened', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'opened record (genuine conflict state)',
  })
  const block = ztagBlocks(rOpened.stdout)[0] ?? ''
  console.log(
    `  opened record: action=${field(block, 'action')} rev=${field(block, 'rev')} haveRev=${field(block, 'haveRev')} unresolvedKeyPresent=${block.includes('... unresolved')}`,
  )
  const rFstat = await run(['-c', clientName, '-ztag', 'fstat', local], {
    cwd: tempRoot,
    phase: 'temp',
    echo: false,
    label: 'fstat (genuine conflict state)',
  })
  console.log(`  fstat unresolvedKeyPresent=${rFstat.stdout.includes('... unresolved')}`)
  await run(['-c', clientName, 'resolve', '-n', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -n preview (genuine conflict)',
  })

  const rAm = await run(['-c', clientName, 'resolve', '-am', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -am on a genuine conflict',
  })
  showResolveVerdict('resolve -am (conflict) parse', rAm)
  console.log(`  KEY CLAIM: -am with files left unresolved exits ${rAm.exitCode} (phase-5 premise: exit 0)`)
  const rFstat2 = await run(['-c', clientName, '-ztag', 'fstat', local], {
    cwd: tempRoot,
    phase: 'temp',
    echo: false,
    label: 'fstat after skipped -am',
  })
  console.log(`  after skipped -am: fstat unresolvedKeyPresent=${rFstat2.stdout.includes('... unresolved')}`)

  // Rewrite the local file as head + an appended line: a cleanly mergeable
  // edit (base #N-1, our delta touches a fresh line) — then -am should land.
  await run(['-c', clientName, 'revert', local], { cwd: tempRoot, phase: 'temp', echo: false, label: 'mergeable: revert' })
  await run(['-c', clientName, 'sync', `${depotFile}#${headRev - 1}`], {
    cwd: tempRoot,
    phase: 'temp',
    echo: false,
    label: 'mergeable: sync #N-1',
  })
  await run(['-c', clientName, 'edit', local], { cwd: tempRoot, phase: 'temp', echo: false, label: 'mergeable: edit' })
  await run(['-c', clientName, 'sync', local], { cwd: tempRoot, phase: 'temp', echo: false, label: 'mergeable: keptOpen sync' })
  writeFileSync(local, headContent + '--probe-auto-merge-append--\n')
  const rAm2 = await run(['-c', clientName, 'resolve', '-am', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -am on a mergeable edit',
  })
  showResolveVerdict('resolve -am (mergeable) parse', rAm2)
  console.log(`  after mergeable -am: local content == head+append: ${readNorm() === headContent.replace(/\r\n/g, '\n') + '--probe-auto-merge-append--\n' ? 'YES' : 'NO'}`)

  await buildConflict('-ay setup')
  const rAy = await run(['-c', clientName, 'resolve', '-ay', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -ay (accept yours)',
  })
  showResolveVerdict('resolve -ay parse', rAy)
  console.log(`  after -ay: local content == our conflicting edit: ${readNorm() === conflictContent.replace(/\r\n/g, '\n') ? 'YES' : 'NO'}`)

  await buildConflict('-at setup')
  const rAt = await run(['-c', clientName, 'resolve', '-at', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -at (accept theirs)',
  })
  showResolveVerdict('resolve -at parse', rAt)
  console.log(`  after -at: local content == depot head: ${readNorm() === headContent.replace(/\r\n/g, '\n') ? 'YES' : 'NO'}`)
}

/** Measured on this server: unshelving a full-file-replacement shelf does NOT
 *  create a resolve state — the file opens at the shelf's base rev (opened
 *  record shows `rev <N-1>` and `haveRev <N-1>`), and `resolve -n` reports
 *  nothing to do. Kept here so the observation stays reproducible; the genuine
 *  conflict scenarios (S5b) therefore use the keptOpen-sync builder instead. */
async function scenarioS5cUnshelveObservation(depotFile, local, headRev) {
  tag('S5c shelve+unshelve — unshelve does NOT schedule a resolve on this server')
  await run(['-c', clientName, 'revert', local], { cwd: tempRoot, phase: 'temp', echo: false, label: 'revert to clean state' })
  await run(['-c', clientName, 'sync', `${depotFile}#${headRev - 1}`], {
    cwd: tempRoot,
    phase: 'temp',
    echo: false,
    label: 'sync down to #N-1',
  })
  await run(['-c', clientName, 'edit', local], { cwd: tempRoot, phase: 'temp', label: 'open for edit (full replacement)' })
  writeFileSync(local, '--probe-shelf-v1--\n--probe-shelf-second-line--\n')
  // `p4 shelve` WITHOUT -c pops the CL-spec editor and blocks forever here
  // (this machine's P4EDITOR is node, which then crashes on the spec file) —
  // so the shelf goes into a numbered CL created via `change -i` (stdin).
  const rChange = await run(['-c', clientName, 'change', '-i'], {
    cwd: tempRoot,
    phase: 'temp',
    stdin: `Change: new\n\nClient: ${clientName}\n\nStatus: new\n\nDescription:\n\tprobe-shelf-changelist\n`,
    label: 'create numbered CL for the shelf (stdin spec, no editor)',
  })
  const shelvedCl = rChange.stdout.match(/Change (\d+) created/)?.[1]
  if (!shelvedCl) {
    console.log(`  !! could not create a numbered changelist (exit ${rChange.exitCode}) — S5c aborted (recorded as unverified)`)
    return
  }
  SHELVED_CLS.push(shelvedCl)
  console.log(`  shelf CL: ${shelvedCl} (change -i + reopen + shelve -c)`)
  await run(['-c', clientName, 'reopen', '-c', shelvedCl, local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'reopen the edit into the shelf CL',
  })
  await run(['-c', clientName, 'shelve', '-c', shelvedCl, local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'shelve the replacement edit',
  })
  await run(['-c', clientName, 'revert', local], { cwd: tempRoot, phase: 'temp', label: 'revert after shelve' })
  await run(['-c', clientName, 'sync', local], { cwd: tempRoot, phase: 'temp', label: 'sync to head' })
  const rUnshelve = await run(['-c', clientName, 'unshelve', '-s', shelvedCl, local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'unshelve onto head',
  })
  console.log(
    `  unshelve reported must-resolve: ${/must resolve/i.test(`${rUnshelve.stdout}\n${rUnshelve.stderr}`) ? 'YES' : 'NO'}`,
  )
  const rOpened = await run(['-c', clientName, '-ztag', 'opened', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'opened record after unshelve',
  })
  const block = ztagBlocks(rOpened.stdout)[0] ?? ''
  console.log(
    `  opened after unshelve: action=${field(block, 'action')} rev=${field(block, 'rev')} haveRev=${field(block, 'haveRev')} unresolvedKeyPresent=${block.includes('... unresolved')}`,
  )
  const rRn = await run(['-c', clientName, 'resolve', '-n', local], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'resolve -n after unshelve',
  })
  console.log(`  resolve -n after unshelve: ${rRn.stdout.trim() || rRn.stderr.trim()}`)
}

async function scenarioS6OpenForAdd() {
  tag('S6 open-for-add fstat — haveRev absent vs string "none" (status bar action===add premise)')
  const newLocal = join(tempRoot, 'probe_new_file.txt')
  writeFileSync(newLocal, 'probe add content\n')
  await run(['-c', clientName, 'add', newLocal], { cwd: tempRoot, phase: 'temp', label: 'add a brand-new file' })
  for (const mode of ['-ztag', '-Mj']) {
    const r = await run(['-c', clientName, mode, 'fstat', newLocal], {
      cwd: tempRoot,
      phase: 'temp',
      label: `fstat ${mode} on own open-for-add`,
    })
    if (mode === '-ztag') {
      const haveLine = r.stdout.match(/\.\.\. haveRev .*/)
      console.log(
        `  -ztag: haveRev=${haveLine ? `"${haveLine[0].replace(/^\.\.\. haveRev /, '')}"` : 'KEY ABSENT'} action=${r.stdout.match(/\.\.\. action (.*)/)?.[1] ?? 'ABSENT'} headRev=${r.stdout.match(/\.\.\. headRev (.*)/)?.[1] ?? 'KEY ABSENT'}`,
      )
    } else {
      const j = r.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return undefined
          }
        })
        .find((o) => o && o['depotFile'])
      console.log(
        `  -Mj: ${j ? `action=${j['action'] ?? 'ABSENT'} haveRev=${'haveRev' in j ? `"${j['haveRev']}"` : 'KEY ABSENT'} headRev=${'headRev' in j ? `"${j['headRev']}"` : 'KEY ABSENT'}` : 'NO RECORD PARSED'}`,
      )
    }
  }
  const rOpened = await run(['-c', clientName, '-ztag', 'opened', newLocal], {
    cwd: tempRoot,
    phase: 'temp',
    label: 'opened record of the add (haveRev "none" string lives here?)',
  })
  const block = ztagBlocks(rOpened.stdout)[0] ?? ''
  console.log(`  opened: haveRev=${block.match(/\.\.\. haveRev (.*)/)?.[1] ?? 'ABSENT'} action=${field(block, 'action')}`)
  await run(['-c', clientName, 'revert', newLocal], { cwd: tempRoot, phase: 'temp', label: 'revert the add' })
  try {
    rmSync(newLocal, { force: true })
  } catch {}
}

async function scenarioS7MixedTranscript(conflictDepotFile, conflictLocal, conflictHeadRev, extraDepotFile, extraLocal, extraHeadRev) {
  tag('S7 mixed transcript: clobber + keptOpen/must-resolve in one sync run')
  // File A: sync #N-1 → edit → modify → the sync will refuse it as opened and
  // print the must-resolve reminder (measured in S4).
  await run(['-c', clientName, 'revert', conflictLocal], { cwd: tempRoot, phase: 'temp', echo: false, label: 'reset conflict file' })
  await run(['-c', clientName, 'sync', `${conflictDepotFile}#${conflictHeadRev - 1}`], {
    cwd: tempRoot,
    phase: 'temp',
    echo: false,
    label: 'conflict file back to #N-1',
  })
  await run(['-c', clientName, 'edit', conflictLocal], { cwd: tempRoot, phase: 'temp', echo: false, label: 're-open conflict file' })
  writeFileSync(conflictLocal, '--probe-mixed-open--\n', { flag: 'a' })
  // File B: sync #N-1 → writable + modified (clobber victim).
  if (extraDepotFile && extraLocal && extraHeadRev) {
    await run(['-c', clientName, 'sync', `${extraDepotFile}#${extraHeadRev - 1}`], {
      cwd: tempRoot,
      phase: 'temp',
      echo: false,
      label: 'clobber victim back to #N-1',
    })
    try {
      chmodSync(extraLocal, 0o666)
      writeFileSync(extraLocal, '--probe-mixed-draft--\n', { flag: 'a' })
      console.log(`  clobber victim prepared: ${extraLocal}`)
    } catch (err) {
      console.log(`  !! could not prepare the clobber victim: ${err.message}`)
    }
  }
  const targets = extraLocal ? [conflictLocal, extraLocal] : [conflictLocal]
  const r = await run(['-c', clientName, 'sync', ...targets], {
    cwd: tempRoot,
    phase: 'temp',
    timeoutMs: 120_000,
    label: 'mixed sync (opened file + clobber victim in one run)',
  })
  showSyncVerdict('mixed sync parse', r)
  console.log(
    `  NOTE: does the clobber abort the whole run (single stderr line, exit 1) or skip that file and continue (exit 0)?`,
  )
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`workspace (read-only source): ${WORKSPACE}`)
  console.log(`narrow dir (view scope): ${NARROW}`)
  console.log(`throwaway client: ${clientName}  temp root: ${tempRoot}`)
  if (!existsSync(WORKSPACE)) fatal(`workspace ${WORKSPACE} does not exist`)

  const { ambient, cfgName, cfg } = await discoverConnection()
  await cleanStaleClients()
  const depotDir = PINNED_FILE && PINNED_FILE.startsWith('//')
    ? undefined
    : await discoverDepotDir()
  const multiRev = await discoverConflictFiles(depotDir)
  const conflict = multiRev[0]
  const extra = multiRev[1]

  mkdirSync(tempRoot, { recursive: true })
  const cfgLines = [
    `P4PORT=${cfg.P4PORT}`,
    `P4USER=${cfg.P4USER}`,
    `P4CLIENT=${clientName}`,
    ...(cfg.P4CHARSET ? [`P4CHARSET=${cfg.P4CHARSET}`] : []),
  ]
  writeFileSync(join(tempRoot, cfgName), cfgLines.join('\n') + '\n')
  armExitHandler()

  const viewLines = []
  if (depotDir) viewLines.push(`${depotDir}/... //${clientName}/...`)
  for (const f of multiRev) if (!f.inDir) viewLines.push(`${f.depotFile} //${clientName}/${basename(f.depotFile)}`)
  if (PINNED_FILE && PINNED_FILE.startsWith('//') && !multiRev.some((f) => f.depotFile === PINNED_FILE))
    viewLines.push(`${PINNED_FILE} //${clientName}/${basename(PINNED_FILE)}`)
  if (viewLines.length === 0) fatal('no view mapping (need --narrow mapping or --file)')
  const localOf = (f) =>
    f.inDir
      ? join(tempRoot, ...f.depotFile.slice(depotDir.length + 1).split('/'))
      : join(tempRoot, basename(f.depotFile))
  const conflictLocal = conflict ? localOf(conflict) : undefined
  const extraLocal = extra ? localOf(extra) : undefined
  // Owner is explicit: on this server a spec without Owner saved fine but it is
  // belt-and-braces for deletion rights anyway (plain `client -d` needs the
  // creator; `-f` needs admin and is only a fallback).
  const spec = `Client:\t${clientName}\n\nOwner:\t${ambient.user}\n\nRoot:\t${tempRoot}\n\nView:\n${viewLines
    .map((v) => `\t${v}`)
    .join('\n')}\n`
  tag('create the throwaway client')
  let created = await run(['-c', clientName, 'client', '-i'], {
    cwd: tempRoot,
    phase: 'temp',
    stdin: spec,
    label: 'p4 client -i (pinned -c)',
  })
  if (created.exitCode !== 0) {
    // Some servers refuse `-c <nonexistent>`; retry without P4CLIENT in the
    // temp config (the spec's Client field still names the throwaway client —
    // `client -i` only ever saves what stdin says).
    writeFileSync(
      join(tempRoot, cfgName),
      cfgLines.filter((l) => !l.startsWith('P4CLIENT=')).join('\n') + '\n',
    )
    created = await run(['client', '-i'], {
      cwd: tempRoot,
      phase: 'temp',
      stdin: spec,
      label: 'p4 client -i (retry, no P4CLIENT)',
    })
    writeFileSync(join(tempRoot, cfgName), cfgLines.join('\n') + '\n')
  }
  if (created.exitCode !== 0) {
    console.error('!! client creation refused by the server (protect settings?) — recorded as blocked; nothing was written anywhere')
    await cleanup()
    return
  }
  CLIENT_CREATED = true
  const verify = await run(['-ztag', 'info'], { cwd: tempRoot, phase: 'temp', echo: false, label: 'verify temp client' })
  const vGrab = (k) => verify.stdout.match(new RegExp(`\\.\\.\\. ${k} (.*)`))?.[1]?.trim()
  console.log(
    `  verified: client=${vGrab('clientName')} user=${vGrab('userName')} root=${vGrab('clientRoot')}${vGrab('clientName') === clientName ? ' ✓' : ' ✗ MISMATCH — aborting'}`,
  )
  if (vGrab('clientName') !== clientName) {
    await cleanup()
    return
  }

  try {
    const syncScope = depotDir ? `${depotDir}/...` : PINNED_FILE
    await scenarioS1InitialSync(syncScope)

    // Pick the file for the destructive scenarios: first synced text file, or
    // the multi-rev conflict candidate.
    const pick = await run(['-c', clientName, '-ztag', 'fstat', '-m', '5', syncScope], {
      cwd: tempRoot,
      phase: 'temp',
      echo: false,
      label: 'pick a synced file',
    })
    const first = ztagBlocks(pick.stdout)
      .map((b) => ({ depotFile: field(b, 'depotFile'), local: field(b, 'clientFile') ?? '' }))
      .find((e) => e.local && existsSync(e.local))
    if (!first) console.log('  !! no synced file found on disk — S2 skipped')
    if (first) {
      await scenarioS2SyncForce(first.local)
    }

    if (conflict && conflictLocal) {
      await scenarioS3Clobber(conflict.depotFile, conflictLocal, conflict.headRev)
      await scenarioS4KeptOpen(conflict.depotFile, conflictLocal, conflict.headRev)
      await scenarioS5aResolveKeptOpenState(conflictLocal)
      await scenarioS5bResolveRealConflict(conflict.depotFile, conflictLocal, conflict.headRev)
      await scenarioS5cUnshelveObservation(conflict.depotFile, conflictLocal, conflict.headRev)
      await scenarioS7MixedTranscript(
        conflict.depotFile,
        conflictLocal,
        conflict.headRev,
        extra?.depotFile,
        extraLocal,
        extra?.headRev,
      )
    } else {
      console.log('  !! conflict file unavailable — S3/S4/S5/S7 skipped (recorded as unverified)')
    }

    await scenarioS6OpenForAdd()
  } finally {
    await cleanup()
  }
  console.log('\ndone.')
}

main().catch(async (err) => {
  console.error(err)
  try {
    await cleanup()
  } catch {}
  process.exit(1)
})
