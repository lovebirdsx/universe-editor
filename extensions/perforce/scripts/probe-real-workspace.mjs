#!/usr/bin/env node
/**
 * Read-only real-workspace probe for the extensions/perforce two-tier behind
 * check, opened-by-others scan, fstat shapes, status-bar data and client
 * listing. Zero dependencies, plain Node (>= 18).
 *
 * Usage:
 *   node probe-real-workspace.mjs --workspace <dir> --narrow <relDir> --behind-scope <relDir>
 *   env overrides: UNIVERSE_P4_PROBE_WORKSPACE / UNIVERSE_P4_PROBE_NARROW /
 *                  UNIVERSE_P4_PROBE_BEHIND_SCOPE
 *   UNIVERSE_P4_PROBE_SKIP_SLOW=1 skips the two slowest probes (client-root
 *   `sync -n` and `<scope>#have`) for quick re-runs.
 *
 * All three inputs are REQUIRED (no defaults): this script only runs on a
 * machine with a real p4 client, so the workspace must be passed in — the
 * script exits with a usage error when one is missing. All paths are relative
 * dirs inside the workspace. The script NEVER issues a write command — see the
 * whitelist in `run()`; any command outside the whitelist, and any `sync`
 * without `-n`, is refused with a hard error. Tickets/passwords are never
 * echoed (tickets/login output is redacted).
 *
 * No other real values are hardcoded: the open-for-add fstat probe discovers
 * its target from `opened -a` records at run time.
 *
 * Real values (depot paths, client names, users, hostnames) DO appear in this
 * tool's local output. Findings documents must substitute placeholders
 * (//depot/branch_x/..., testclient, otherclient, testuser, DESKTOP-TEST).
 *
 * Note on client resolution: p4 on Windows resolves the P4CONFIG file from the
 * PWD environment variable when it is present (measured: a POSIX-form PWD like
 * /e/... breaks the lookup; an absent PWD falls back to the cwd). This script
 * spawns p4 with cwd = the workspace and strips PWD/MSYS* from the child env,
 * so the client that owns the workspace is always the one that resolves.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
const NARROW = requiredArg(
  'UNIVERSE_P4_PROBE_NARROW',
  '--narrow',
  'a relative dir inside the workspace for narrow-scope probes',
)
// A scope known to have pending updates (relative dir inside the workspace) —
// feeds the "with updates" sync -n timing and the behind-file discovery.
const BEHIND_SCOPE = requiredArg(
  'UNIVERSE_P4_PROBE_BEHIND_SCOPE',
  '--behind-scope',
  'a relative dir inside the workspace known to have pending updates',
)
// 1 to skip the two slowest probes (client-root sync -n, <scope>#have) for quick re-runs.
const SKIP_SLOW = process.env['UNIVERSE_P4_PROBE_SKIP_SLOW'] === '1'

// --- safety -----------------------------------------------------------------

const ALLOWED_COMMANDS = new Set([
  'info',
  'changes',
  'sync', // -n only, enforced below
  'opened',
  'fstat',
  'clients',
  'where',
  'print',
  'filelog',
  'login', // -s only, enforced below
  'tickets', // output never echoed
])

const REDACT_STDOUT = new Set(['tickets', 'login'])

/** Global flags that take a value — their value must not be mistaken for the command. */
const VALUE_FLAGS = new Set(['-c', '-u', '-p', '-x', '-C', '-v', '-d'])

/** The p4 subcommand = the first arg that isn't a global flag (or a flag's value). */
const commandOf = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (VALUE_FLAGS.has(a)) {
      i++
      continue
    }
    if (!a.startsWith('-')) return a
  }
  return undefined
}

function assertReadOnly(args) {
  const cmd = commandOf(args)
  if (!cmd || !ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`REFUSED: '${cmd ?? '<empty>'}' is not a read-only whitelisted command`)
  }
  if (cmd === 'sync' && !args.includes('-n')) {
    throw new Error("REFUSED: 'sync' without '-n' would write to the workspace")
  }
  if (cmd === 'login' && !args.includes('-s')) {
    throw new Error("REFUSED: 'login' without '-s' would prompt for / consume a password")
  }
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
    console.log(`    exit ${exitCode} in ${elapsedMs}ms${timedOut ? ' (TIMEOUT/killed)' : ''}`)
    if (redact) {
      console.log(`    [stdout redacted: ${stdoutBytes} bytes]`)
    } else if (stdout.trim()) {
      const lines = stdout.trimEnd().split(/\r?\n/)
      const shown = lines.slice(0, 12)
      for (const line of shown) {
        console.log(`    | ${line.length > 160 ? line.slice(0, 157) + '...' : line}`)
      }
      if (lines.length > shown.length)
        console.log(`    | … ${lines.length - shown.length} more line(s)`)
    }
    if (stderr.trim()) {
      const errLines = stderr.trimEnd().split(/\r?\n/).slice(0, 3)
      for (const line of errLines) console.log(`    ! ${line.slice(0, 160)}`)
    }
  }
  return { args, exitCode, stdout, stderr, elapsedMs, timedOut, stdoutBytes }
}

const tag = (title) => console.log(`\n=== ${title} ===`)

// --- helpers ----------------------------------------------------------------

const ztagBlocks = (stdout) =>
  stdout
    .split(/\r?\n\r?\n|\n\n/)
    .map((b) => b.trim())
    .filter((b) => b.includes('depotFile'))

const field = (block, key) => block.match(new RegExp(`\\.\\.\\. ${key} (.*)`))?.[1]

/** First regular file at or under `dir` (capped walk) — for the fstat probe. */
function firstFileUnder(dir) {
  const queue = [dir]
  let visited = 0
  while (queue.length > 0 && visited < 400) {
    const current = queue.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      visited++
      const full = join(current, e.name)
      if (e.isFile()) return full
      if (e.isDirectory()) queue.push(full)
    }
  }
  return undefined
}

// --- probes -----------------------------------------------------------------

async function probeG1Timings(mine) {
  tag('G1 two-tier probe timings (the core numbers)')
  console.log('  -- cheap gate: changes -m 1 -s submitted, 3 runs each')
  const depotScope = '//...'
  const narrowScope = `${NARROW}/...`
  const depotRuns = []
  const narrowRuns = []
  for (let i = 0; i < 3; i++) {
    const r = await run(['changes', '-m', '1', '-s', 'submitted', depotScope], {
      timeoutMs: 15_000,
      echo: false,
    })
    const cl = r.stdout.trim().split(/\s+/)[1]
    depotRuns.push({ cl, elapsedMs: r.elapsedMs })
    console.log(`    ${depotScope}: ${r.elapsedMs}ms latest=${cl} exit=${r.exitCode}`)
  }
  for (let i = 0; i < 3; i++) {
    const r = await run(['changes', '-m', '1', '-s', 'submitted', narrowScope], {
      timeoutMs: 15_000,
      echo: false,
    })
    const cl = r.stdout.trim().split(/\s+/)[1]
    narrowRuns.push({ cl, elapsedMs: r.elapsedMs })
    console.log(`    ${narrowScope}: ${r.elapsedMs}ms latest=${cl} exit=${r.exitCode}`)
  }
  const depotStable = depotRuns.every((r) => r.cl === depotRuns[0].cl)
  const narrowStable = narrowRuns.every((r) => r.cl === narrowRuns[0].cl)
  console.log(
    `  marker stability: depot scope ${depotStable ? 'STABLE' : 'MOVING between consecutive runs'} (${depotRuns.map((r) => r.cl).join(' -> ')})`,
  )
  console.log(
    `                    narrow scope ${narrowStable ? 'STABLE' : 'MOVING'} (${narrowRuns.map((r) => r.cl).join(' -> ')})`,
  )

  console.log(
    '  -- two-tier simulation on the narrow markers just measured (product logic: skip iff marker unchanged)',
  )
  let last
  for (const r of [...narrowRuns, narrowRuns[0]]) {
    const verdict =
      last === r.cl ? 'SKIP sync -n (steady state — zero expensive work)' : 'would RUN sync -n'
    console.log(`    gate marker ${r.cl}: ${verdict}`)
    last = r.cl
  }

  console.log('  -- the rejected alternative: <scope>#have (capped at 90s)')
  if (SKIP_SLOW) {
    console.log('    skipped (UNIVERSE_P4_PROBE_SKIP_SLOW=1)')
  } else {
    const have = await run(['changes', '-m', '1', '-s', 'submitted', `${depotScope}#have`], {
      timeoutMs: 90_000,
      echo: false,
    })
    console.log(
      `    ${depotScope}#have: ${have.elapsedMs}ms exit=${have.exitCode}${have.timedOut ? ' TIMED OUT' : ''}`,
    )
    if (have.stdout.trim())
      console.log(`    | ${have.stdout.trim().split(/\r?\n/)[0]?.slice(0, 120)}`)
  }

  console.log(
    `  -- expensive tier on the narrow scope (up-to-date): sync -n -m 501 ${narrowScope} (capped 120s)`,
  )
  const syncNarrow = await run(['-ztag', 'sync', '-n', '-m', '501', narrowScope], {
    timeoutMs: 120_000,
    echo: false,
  })
  console.log(
    `    exit=${syncNarrow.exitCode} ${syncNarrow.elapsedMs}ms ${syncNarrow.stdoutBytes} bytes${syncNarrow.timedOut ? ' TIMED OUT' : ''}`,
  )
  if (syncNarrow.stderr.trim())
    console.log(`    stderr: ${syncNarrow.stderr.trim().split(/\r?\n/)[0]?.slice(0, 120)}`)
  const tc = syncNarrow.stdout.match(/totalFileCount (\d+)/)
  const tfs = syncNarrow.stdout.match(/totalFileSize (\d+)/)
  console.log(`    totalFileCount=${tc?.[1] ?? '?'} totalFileSize=${tfs?.[1] ?? '?'}`)
  const recs = ztagBlocks(syncNarrow.stdout)
  console.log(`    records=${recs.length} (cap 501)`)

  console.log(
    `  -- expensive tier with actual updates: sync -n -m 501 ${BEHIND_SCOPE}/... (capped 120s)`,
  )
  const syncBehind = await run(['-ztag', 'sync', '-n', '-m', '501', `${BEHIND_SCOPE}/...`], {
    timeoutMs: 120_000,
    echo: false,
  })
  console.log(
    `    exit=${syncBehind.exitCode} ${syncBehind.elapsedMs}ms ${syncBehind.stdoutBytes} bytes${syncBehind.timedOut ? ' TIMED OUT' : ''}`,
  )
  const btc = syncBehind.stdout.match(/totalFileCount (\d+)/)
  const brecs = ztagBlocks(syncBehind.stdout)
  console.log(`    totalFileCount=${btc?.[1] ?? '?'} records=${brecs.length}; first record:`)
  if (brecs[0]) console.log(`    | ${brecs[0].split(/\r?\n/).slice(0, 8).join(' / ')}`)

  console.log(
    '  -- expensive tier at CLIENT ROOT (runs ONCE, hard cap 150s; expect >120s / 0 bytes)',
  )
  if (SKIP_SLOW) {
    console.log('    skipped (UNIVERSE_P4_PROBE_SKIP_SLOW=1)')
  } else {
    const syncRoot = await run(
      ['-ztag', 'sync', '-n', '-m', '501', `${mine.root.replace(/\\/g, '/')}/...`],
      {
        timeoutMs: 150_000,
        echo: false,
      },
    )
    console.log(
      `    exit=${syncRoot.exitCode} ${syncRoot.elapsedMs}ms ${syncRoot.stdoutBytes} bytes${syncRoot.timedOut ? ' TIMED OUT' : ''}`,
    )
  }
}

async function probeG2OpenedByOthers(mine) {
  tag('G2 opened -a clientFile trap')
  console.log('  -- opened -a -m 50 over the whole depot (product default scope //...)')
  const all = await run(['-ztag', 'opened', '-a', '-m', '50', '//...'], {
    timeoutMs: 60_000,
    echo: false,
  })
  console.log(`    exit=${all.exitCode} ${all.elapsedMs}ms`)
  const recs = ztagBlocks(all.stdout)
  const others = []
  for (const block of recs) {
    const entry = {
      depotFile: field(block, 'depotFile'),
      clientFile: field(block, 'clientFile'),
      client: field(block, 'client') ?? '',
      user: field(block, 'user'),
      action: field(block, 'action'),
      haveRev: field(block, 'haveRev'),
      change: field(block, 'change'),
    }
    if (entry.client !== mine.client) others.push(entry)
  }
  console.log(`    records=${recs.length} others=${others.length}`)
  for (const e of others.slice(0, 6)) {
    const cs = e.clientFile?.startsWith('//') ? 'client-syntax' : 'local-path'
    console.log(
      `    other: ${e.depotFile} <- clientFile [${cs}] ${e.clientFile} (${e.user}@${e.client} ${e.action} haveRev=${e.haveRev} change=${e.change})`,
    )
  }
  const allClientSyntax = others.length > 0 && others.every((e) => e.clientFile?.startsWith('//'))
  console.log(
    `    verdict: every other-client record's clientFile is${allClientSyntax ? '' : ' NOT'} client syntax`,
  )
  const haveRevNone = others.filter((e) => e.haveRev === 'none').length
  const changeDefault = others.filter((e) => e.change === 'default').length
  console.log(
    `    haveRev none: ${haveRevNone}/${others.length}; change default: ${changeDefault}/${others.length}`,
  )

  if (others.length > 0) {
    console.log(
      '  -- phantom-path demonstration: translating the other clientFile with MY client root',
    )
    const sample = others[0]
    const phantom = join(
      WORKSPACE,
      sample.clientFile.replace(/^\/\/[^/]+\//, '').replace(/\//g, '\\'),
    )
    console.log(`    other clientFile ${sample.clientFile}`)
    console.log(`    root-translated ${phantom} -> exists on disk: ${existsSync(phantom)}`)
    console.log(
      '  -- the product path: p4 where on the depotFile (correct local path, in or out of view)',
    )
    for (const e of others.slice(0, 3)) {
      const w = await run(['-ztag', 'where', e.depotFile], { timeoutMs: 30_000, echo: false })
      const pathLine = w.stdout.match(/\.\.\. path (.*)/)
      console.log(`    ${e.depotFile} -> ${pathLine?.[1] ?? `(not in view, exit ${w.exitCode})`}`)
    }
  }

  console.log(`  -- opened -a scoped to this client's stream (the focus-folder case)`)
  const streamScope = `${mine.stream}/...`
  const branch = await run(['-ztag', 'opened', '-a', '-m', '40', streamScope], {
    timeoutMs: 60_000,
    echo: false,
  })
  const branchOthers = ztagBlocks(branch.stdout)
    .map((b) => ({ depotFile: field(b, 'depotFile'), client: field(b, 'client') ?? '' }))
    .filter((e) => e.client !== mine.client)
  console.log(`    exit=${branch.exitCode} ${branch.elapsedMs}ms others=${branchOthers.length}`)
  if (branchOthers.length > 0) {
    // Prefer a record whose local path actually exists on this disk (a sparse
    // workspace may not have every mapped file synced).
    let sample
    for (const e of branchOthers.slice(0, 5)) {
      const w = await run(['-ztag', 'where', e.depotFile], { timeoutMs: 30_000, echo: false })
      const local = w.stdout.match(/\.\.\. path (.*)/)?.[1]
      if (local && existsSync(local)) {
        sample = { depotFile: e.depotFile, local }
        break
      }
      if (!sample) sample = { depotFile: e.depotFile, local }
    }
    console.log(
      `    sample in-stream record: ${sample.depotFile} -> ${sample.local ?? '(not in view)'} (exists on disk: ${sample.local ? existsSync(sample.local) : false})`,
    )
  }
  return others
}

async function probeG3Fstat(others) {
  tag('G3 fstat field shapes')
  const localFile = firstFileUnder(join(WORKSPACE, NARROW))
  if (!localFile) {
    console.log(`  !! no file found under ${NARROW} — skipping the local-fstat probe`)
  } else {
    const rel = localFile.replace(WORKSPACE.replace(/\\/g, '/'), '').replace(/^\//, '')
    console.log(`  -- fstat on an in-view local file (${rel})`)
    const f = await run(['-ztag', 'fstat', localFile.replace(/\\/g, '/')], { timeoutMs: 30_000 })
    const have = f.stdout.match(/\.\.\. haveRev (.*)/)?.[1]
    const head = f.stdout.match(/\.\.\. headRev (.*)/)?.[1]
    const clientFile = f.stdout.match(/\.\.\. clientFile (.*)/)?.[1]
    const action = f.stdout.match(/\.\.\. action (.*)/)?.[1]
    console.log(
      `    haveRev=${have ?? 'ABSENT'} headRev=${head ?? 'ABSENT'} action=${action ?? 'ABSENT'}`,
    )
    console.log(
      `    clientFile=${clientFile} (${clientFile?.startsWith('//') ? 'client syntax!' : 'local path'})`,
    )
    if (have && head) {
      const verdict =
        Number(have) < Number(head)
          ? `BEHIND — the status bar would show #${have} / ↓#${head}`
          : `current — #${have} / #${head}`
      console.log(`    status-bar verdict: ${verdict}`)
    }
  }

  console.log(
    '  -- fstat AS the other client on a file they hold open-for-add (read-only -c, target auto-discovered)',
  )
  const addRecord = others.find((e) => e.action === 'add')
  if (!addRecord) {
    console.log('    no open-for-add record in opened -a — cannot probe this shape right now')
  } else {
    const fa = await run(['-ztag', '-c', addRecord.client, 'fstat', addRecord.depotFile], {
      timeoutMs: 30_000,
      echo: false,
    })
    const addHave = fa.stdout.match(/\.\.\. haveRev (.*)/)?.[1]
    const addAction = fa.stdout.match(/\.\.\. action (.*)/)?.[1]
    const addHead = fa.stdout.match(/\.\.\. headRev (.*)/)?.[1]
    console.log(
      `    target: ${addRecord.depotFile} (open-for-add by ${addRecord.user}@${addRecord.client})`,
    )
    console.log(`    exit=${fa.exitCode} ${fa.elapsedMs}ms`)
    console.log(
      `    open-for-add fstat: action=${addAction ?? 'ABSENT'} headRev=${addHead ?? 'ABSENT'} haveRev=${addHave === undefined ? 'KEY ABSENT (not the string "none")' : `"${addHave}"`}`,
    )
    console.log(
      `    => the falsy-guard !haveRev catches this shape; a haveRev === 'none' branch would never fire from fstat`,
    )
  }
}

async function probeG4StatusBarData(behindFile) {
  tag('G4 status-bar #have/#head data (the three branches, driven by G3/G6 records)')
  if (behindFile) {
    const f = await run(['-ztag', 'fstat', behindFile.local], { timeoutMs: 30_000, echo: false })
    const have = f.stdout.match(/\.\.\. haveRev (.*)/)?.[1]
    const head = f.stdout.match(/\.\.\. headRev (.*)/)?.[1]
    console.log(`  behind file fstat: ${behindFile.depotFile}`)
    console.log(`    haveRev=${have ?? 'ABSENT'} headRev=${head ?? 'ABSENT'}`)
    console.log(
      `    status bar would show: ${Number(have) < Number(head) ? `#${have} / ↓#${head} (behind, clickable)` : `#${have} / #${head} (current)`}`,
    )
  }
  console.log('  normal branch: see G3 (have == head → #h / #h, not clickable)')
  console.log('  open-for-add branch: see G3 (action add, no haveRev → no "#/#" pair)')
}

async function probeG5Clients(mine) {
  tag('G5 clients -u: -Mj collapse and -ztag casing')
  const user = mine.user
  const mj = await run(['-Mj', 'clients', '-u', user], { timeoutMs: 30_000, echo: false })
  console.log(`  -Mj clients -u ${user}: exit=${mj.exitCode} ${mj.elapsedMs}ms`)
  const mjLines = mj.stdout.trim().split(/\r?\n/).filter(Boolean)
  const collapsed =
    mjLines.length > 0 &&
    mjLines.every((l) => {
      try {
        const o = JSON.parse(l)
        return !('client' in o) && Object.keys(o).length >= 1
      } catch {
        return false
      }
    })
  console.log(`    first line: ${mjLines[0]?.slice(0, 140)}`)
  console.log(
    `    verdict: ${mjLines.length} line(s), ${collapsed ? 'COLLAPSED to data blobs' : 'structured'}`,
  )
  const zt = await run(['-ztag', 'clients', '-u', user], { timeoutMs: 30_000, echo: false })
  console.log(`  -ztag clients -u ${user}: exit=${zt.exitCode} ${zt.elapsedMs}ms`)
  const first = zt.stdout.trim().split(/\r?\n/).slice(0, 18)
  for (const line of first) console.log(`    | ${line.slice(0, 140)}`)
  const keys = first
    .filter((l) => l.startsWith('... '))
    .map((l) => l.replace(/^\.\.\. /, '').split(' ')[0])
  const lower = keys.filter((k) => k[0] === k[0]?.toLowerCase())
  console.log(`    lowercase keys: [${lower.join(', ')}] — the rest are Capitalized`)
}

async function probeG6PreviewSync() {
  tag(`G6 previewSync record shape on ${BEHIND_SCOPE}/...`)
  const r = await run(['-ztag', 'sync', '-n', '-m', '20', `${BEHIND_SCOPE}/...#head`], {
    timeoutMs: 120_000,
    echo: false,
  })
  console.log(`  exit=${r.exitCode} ${r.elapsedMs}ms ${r.stdoutBytes} bytes`)
  const blocks = ztagBlocks(r.stdout)
  let behindFile
  for (const b of blocks.slice(0, 5)) {
    const cf = field(b, 'clientFile') ?? ''
    console.log(
      `    ${field(b, 'depotFile')} action=${field(b, 'action')} rev=${field(b, 'rev')} clientFile=${cf} (${cf.startsWith('//') ? 'client syntax' : 'local path'})`,
    )
    if (!behindFile && cf && existsSync(cf)) {
      behindFile = { depotFile: field(b, 'depotFile'), local: cf }
    }
  }
  console.log(`  records=${blocks.length}`)
  return behindFile
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`workspace: ${WORKSPACE}`)
  console.log(`narrow scope: ${NARROW}/...`)
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
    stream: grab('Client stream'),
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

  await probeG1Timings(mine)
  const others = await probeG2OpenedByOthers(mine)
  await probeG3Fstat(others)
  const behindFile = await probeG6PreviewSync()
  await probeG4StatusBarData(behindFile)
  await probeG5Clients(mine)
  console.log('\ndone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
