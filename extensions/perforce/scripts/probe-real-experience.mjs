#!/usr/bin/env node
/**
 * probe-real-experience.mjs — real-workspace EXPERIENCE probe for the perforce
 * extension. Drives the packaged editor (`apps/editor/out/main/index.js`) with
 * Playwright `_electron` against the real p4 workspace, and measures the four
 * experience dimensions the product questions asked:
 *
 *   C1  interactive reads while background scans fly (ConcurrencyGate reserved
 *       slot) + the new `fstat -Ru` refresh-stage cost, real machine
 *   C1b same, but with a deterministic >20s sync -n flight (a big subtree
 *       opened as the workspace — default scope walks the whole tree; the
 *       subtree comes from --c1b-dir, no default)
 *   C2  status-bar "N files behind" end-to-end latency (cold start → count)
 *   C3  supplementary grey text in a large Explorer directory + the
 *       500/300-decoration cap behaviour (count-only + loud log, never silent)
 *   C4  error-guidance chain — command layer only; the real-machine button
 *       click needs a throwaway client (PROBE-FINDINGS §11.2), so this script
 *       reports the boundary instead of faking it
 *
 * Usage:
 *   node extensions/perforce/scripts/probe-real-experience.mjs
 *     --workspace <dir> [--target-dirs a,b] [--behind-candidates a,b,c]
 *     [--c1b-dir <relDir>] [--scenarios c1,c1b,c2,c3a,c3b] [--interval <sec>]
 *   env overrides: UNIVERSE_P4_PROBE_WORKSPACE / UNIVERSE_P4_PROBE_TARGET_DIRS /
 *                  UNIVERSE_P4_PROBE_BEHIND_CANDIDATES / UNIVERSE_P4_PROBE_C1B_DIR /
 *                  UNIVERSE_P4_PROBE_SCENARIOS / UNIVERSE_P4_PROBE_INTERVAL /
 *                  UNIVERSE_P4_PROBE_SKIP_CHECKOUT
 *
 * Required (no defaults — real machine values never ship in the script):
 * --workspace = the real p4 workspace dir; --target-dirs = comma-separated
 * relative dirs to pick small openChange targets from; --behind-candidates =
 * comma-separated relative dirs the discovery step probes to pick the
 * small/big/cap behind scopes. Missing any of the three → hard usage error.
 * --c1b-dir is only needed for the c1b scenario (it skips with a hint
 * otherwise).
 *
 * Prereqs: `pnpm --filter @universe-editor/perforce build && pnpm --filter
 * @universe-editor/editor build` (the probe drives the out/ + dist/ outputs).
 *
 * Safety: the workspace is READ-ONLY except for ONE `p4 edit` on a small text
 * file, needed to make the zero-opened workspace run the `fstat -Ru` stage at
 * all (C1). The edit is wrapped in try/finally with a hard post-run `p4
 * opened` verification; `--skip-checkout` / UNIVERSE_P4_PROBE_SKIP_CHECKOUT=1
 * skips it when the workspace already has files open. `p4 edit`/`p4 revert`
 * are only ever issued for that single file — every other command goes through
 * the read-only whitelist (same as probe-real-workspace.mjs). No `-p` flag,
 * no submit, no sync-without-`-n`; tickets/login output never echoed.
 *
 * The editor runs with a throwaway `--user-data-dir` (tmp) whose seeded user
 * settings pin language=en-US and can pre-enable `workspace.focusEnabled` /
 * `workspace.focusFolders` — the same settings a user would have. Nothing in
 * the workspace directory itself is written (focus settings live in the tmp
 * user-data layer, not the project layer).
 *
 * Workspace opening: the folder is opened via the `openWorkspace` probe after
 * boot, NOT as a positional arg. Positional-arg startup is deterministically
 * broken in dev-mode launches: playwright prepends `--inspect=0
 * --remote-debugging-port=0` before the app entry, so main's parseFileToOpen
 * (`argv.slice(2)`, cliArgs.ts) returns `out/main/index.js` itself as the
 * "file to open" and the folder arg is dropped — every window opens with
 * `workspace=<none>` (verified in window.log of multiple runs). Product
 * issue, reported in PROBE-FINDINGS §12; not fixed here (probe must not touch
 * src/). The script therefore boots an empty window and settles the folder
 * via openWorkspace, waiting for the renderer workspace pin AND the
 * extension-host re-pin (the host restarts with UNIVERSE_WORKSPACE_ROOT set).
 *
 * Real values (depot paths, client names, users) DO appear in this tool's
 * local output. Findings documents must substitute placeholders
 * (//depot/branch_x/..., testclient, testuser, DESKTOP-TEST).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')
const APP_ROOT = join(REPO_ROOT, 'apps/editor')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')
// Single physical playwright: resolve from the e2e-harness package (same tree
// its dist resolves from — two playwright copies break _electron).
const harnessRequire = createRequire(join(REPO_ROOT, 'packages/e2e-harness/package.json'))
const { _electron } = harnessRequire('@playwright/test')
const ELECTRON = createRequire(join(APP_ROOT, 'package.json'))('electron')

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
/** Relative dirs to pick small openChange targets from (comma-separated). */
const TARGET_DIRS = requiredArg(
  'UNIVERSE_P4_PROBE_TARGET_DIRS',
  '--target-dirs',
  'comma-separated relative dirs with small text files to openChange',
)
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean)
/** Relative dirs the discovery step probes to pick small/big/cap behind scopes
 *  (comma-separated). */
const BEHIND_CANDIDATES = requiredArg(
  'UNIVERSE_P4_PROBE_BEHIND_CANDIDATES',
  '--behind-candidates',
  'comma-separated relative dirs to probe for behind scopes',
)
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean)
/** Big subtree for the C1b deterministic sync -n flight; only c1b needs it. */
const C1B_DIR = envOrArg('UNIVERSE_P4_PROBE_C1B_DIR', '--c1b-dir', '')
const SCENARIOS = (envOrArg('UNIVERSE_P4_PROBE_SCENARIOS', '--scenarios', 'all') ?? 'all')
  .split(',')
  .filter(Boolean)
const INTERVAL_SEC = Number(envOrArg('UNIVERSE_P4_PROBE_INTERVAL', '--interval', '30') ?? '30')
const SKIP_CHECKOUT = process.env['UNIVERSE_P4_PROBE_SKIP_CHECKOUT'] === '1'
const wants = (name) => SCENARIOS.includes('all') || SCENARIOS.includes(name)

const CHANNEL = 'Perforce'
const BEHIND_PROBE = 501 // SYNC_PREVIEW_MAX_DECORATIONS + 1
const OTHERS_PROBE = 301 // OPENED_BY_OTHERS_MAX_DECORATIONS + 1

// --- node-side p4 runner (read-only whitelist, same discipline as the other probes) ----------

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
])
const VALUE_FLAGS = new Set(['-c', '-u', '-p', '-x', '-C', '-v', '-d'])

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
}

function childEnv() {
  const env = { ...process.env }
  delete env.PWD // p4 keys P4CONFIG lookup off PWD when present (PROBE-FINDINGS §10.1)
  delete env.UNIVERSE_P4_PATH // never let the fake p4 stand in
  delete env.UNIVERSE_P4_FAKE_STATE
  for (const key of Object.keys(env)) {
    if (key.startsWith('MSYS')) delete env[key]
  }
  return env
}

async function runP4(args, { timeoutMs = 60_000, echo = true } = {}) {
  assertReadOnly(args)
  const started = Date.now()
  let stdout = ''
  let stderr = ''
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
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const exitCode = await new Promise((resolveExit) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  const elapsedMs = Date.now() - started
  if (echo) console.log(`  > p4 ${args.join(' ')}  exit ${exitCode} in ${elapsedMs}ms`)
  return { args, exitCode, stdout, stderr, elapsedMs, timedOut: aborted }
}

/** The ONLY write path in this probe: edit/revert of the single C1 checkout
 *  file, never anything else. Every other argv is refused. */
function runCheckedWrite(args) {
  const cmd = commandOf(args)
  const target = checkoutState.file
  const okShape =
    (cmd === 'edit' || cmd === 'revert') &&
    target !== undefined &&
    args.length === 2 &&
    args[1] === target
  if (!okShape) {
    throw new Error(
      `REFUSED: the only permitted writes are 'p4 edit ${target ?? '<checkout>'}' / 'p4 revert ${target ?? '<checkout>'}'`,
    )
  }
  const started = Date.now()
  const { status, stdout, stderr } = spawnSync('p4', args, {
    cwd: WORKSPACE,
    shell: false,
    env: childEnv(),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const tail = `${stdout.trim() ? `\n    ${stdout.trim().slice(0, 200)}` : ''}${stderr.trim() ? `\n    ! ${stderr.trim().slice(0, 200)}` : ''}`
  console.log(`  > p4 ${args.join(' ')}  exit ${status} in ${Date.now() - started}ms${tail}`)
  if (status !== 0) throw new Error(`p4 ${cmd} failed: ${stderr.slice(0, 300)}`)
  return { exitCode: status, stdout, stderr }
}

// --- misc helpers -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rel = (p) => p.replace(/\\/g, '/')
const nowMs = () => Date.now()
const ms = (n) => `${Math.round(n)}ms`
const tag = (title) => console.log(`\n===== ${title} =====`)

const checkoutState = { file: undefined }

/** First regular file at or under `dir` (capped walk) matching the predicate. */
function findFileUnder(dir, predicate, cap = 600) {
  const queue = [dir]
  let visited = 0
  while (queue.length > 0 && visited < cap) {
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
      if (e.isFile()) {
        if (!predicate || predicate(full)) return full
      } else if (e.isDirectory()) {
        queue.push(full)
      }
    }
  }
  return undefined
}

// --- phase 0: node-side discovery --------------------------------------------------------------

async function discover() {
  tag('discovery (node-side, read-only)')
  const info = await runP4(['info'], { echo: false })
  const grab = (k) => info.stdout.match(new RegExp(`^${k}: (.*)`, 'm'))?.[1]?.trim()
  const mine = {
    client: grab('Client name'),
    user: grab('User name'),
    root: grab('Client root'),
    stream: grab('Client stream'),
  }
  console.log(`resolved: user=${mine.user} client=${mine.client} root=${mine.root}`)
  if (info.exitCode !== 0 || !mine.client) throw new Error('p4 info failed — server reachable?')
  if (mine.root && resolve(mine.root).toLowerCase() !== resolve(WORKSPACE).toLowerCase()) {
    throw new Error('resolved client root does not match the workspace dir — aborting')
  }

  const opened = await runP4(['opened'], { echo: false })
  const openedCount = opened.stdout.trim() ? opened.stdout.trim().split(/\r?\n/).length : 0
  console.log(`opened files right now: ${openedCount}`)

  // Small synced text files for openChange + the C1 checkout target.
  const targets = []
  for (const dir of TARGET_DIRS) {
    const f = findFileUnder(join(WORKSPACE, dir), (p) => {
      try {
        return statSync(p).size < 64 * 1024 && /\.(txt|ini|py|bat|lua)$/i.test(p)
      } catch {
        return false
      }
    })
    if (f) targets.push(f)
    if (targets.length >= 3) break
  }
  if (targets.length === 0) {
    console.log(
      '  WARNING: no openChange targets found under --target-dirs — burst timing probes will be skipped',
    )
  } else {
    console.log(`interactive targets: ${targets.map((t) => rel(t)).join(' | ')}`)
  }

  // Behind scopes: the small one (count 1..500, fast — C2 happy path), the big
  // one (C3a: many files on disk, 1..500 behind), the cap one (C3b: >500
  // behind AND completes inside the product's 20s ceiling so the count can
  // actually publish).
  const candidates = BEHIND_CANDIDATES
  const scopes = []
  for (const dir of candidates) {
    const r = await runP4(['-ztag', 'sync', '-n', '-m', String(BEHIND_PROBE), `${dir}/...`], {
      timeoutMs: 120_000,
      echo: false,
    })
    const records = (r.stdout.match(/\.\.\. depotFile/g) ?? []).length
    const total = r.stdout.match(/totalFileCount (\d+)/)?.[1]
    const clientFiles = [...r.stdout.matchAll(/\.\.\. clientFile (.*)/g)].map((m) => m[1])
    scopes.push({ dir, records, total, elapsedMs: r.elapsedMs, timedOut: r.timedOut, clientFiles })
    console.log(
      `  sync -n -m ${BEHIND_PROBE} ${dir}/...: ${records} record(s) / totalFileCount=${total ?? '?'} in ${r.elapsedMs}ms${r.timedOut ? ' (TIMED OUT)' : ''}`,
    )
  }
  const small = scopes.find((s) => s.records > 0 && s.records < BEHIND_PROBE)
  const big = scopes.find((s) => s.records >= 40 && s.records < BEHIND_PROBE)
  const cap = scopes.find((s) => s.records >= BEHIND_PROBE && !s.timedOut && s.elapsedMs < 15_000)
  if (!small) throw new Error('no small behind scope found — the depot moved? re-run discovery')
  if (!cap) console.log('  WARNING: no cap scope (501 records <15s) found — c3b will be skipped')
  if (!big) console.log('  WARNING: no big scope found — c3a will be skipped')

  // The big scope's disk shape: how many direct children does its widest dir have.
  let widest = { dir: '', count: 0 }
  if (big) {
    const counts = new Map()
    const walk = (d, depth) => {
      if (depth > 8) return
      let entries
      try {
        entries = readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      let files = 0
      const sub = []
      for (const e of entries) {
        if (e.isDirectory()) sub.push(join(d, e.name))
        else files++
      }
      if (files >= 300) counts.set(d, files)
      for (const s of sub) walk(s, depth + 1)
    }
    walk(join(WORKSPACE, big.dir), 0)
    for (const [d, c] of counts) if (c > widest.count) widest = { dir: d, count: c }
    console.log(
      `  widest dir under ${big.dir}: ${widest.count} direct children (${rel(widest.dir)})`,
    )
  }

  // Others in each scope (the grey "in use by others" source).
  for (const s of [small, big, cap].filter(Boolean)) {
    const r = await runP4(['-ztag', 'opened', '-a', '-m', String(OTHERS_PROBE), `${s.dir}/...`], {
      timeoutMs: 60_000,
      echo: false,
    })
    console.log(
      `  opened -a -m ${OTHERS_PROBE} ${s.dir}/...: ${(r.stdout.match(/\.\.\. depotFile/g) ?? []).length} record(s) in ${r.elapsedMs}ms`,
    )
  }

  // The REAL check scope: this workspace carries its own workspace-layer
  // settings (`.universe-editor/settings.json` — the machine's owner actually
  // uses focus folders), which BEAT any user-layer seed for the same keys.
  // The probe must measure what a real session would do, so the scenarios are
  // driven by these dirs. Read-only: the workspace must not be written here.
  const workspaceLayer = (() => {
    try {
      const raw = readFileSync(join(WORKSPACE, '.universe-editor', 'settings.json'), 'utf8')
      // The file is JSONC: strip comments AND trailing commas before parsing.
      const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'))
      const enabled = parsed['workspace.focusEnabled'] === true
      const folders = parsed['workspace.focusFolders']
      const dirs = []
      if (enabled && folders && typeof folders === 'object') {
        for (const [k, v] of Object.entries(folders)) {
          if (v === true && typeof k === 'string' && k.length > 0) dirs.push(k.replace(/^\.\//, ''))
        }
      }
      return { enabled, dirs, other: Object.keys(parsed).filter((k) => k.startsWith('perforce.')) }
    } catch {
      return { enabled: false, dirs: [], other: [] }
    }
  })()
  console.log(
    `  workspace layer: focusEnabled=${workspaceLayer.enabled} focusDirs=[${workspaceLayer.dirs.join(', ')}]${workspaceLayer.other.length > 0 ? ` perforceKeys=[${workspaceLayer.other.join(', ')}]` : ''}`,
  )

  // Behind/others probes for the REAL check scope (the focus dirs).
  const userFocus = {
    behind: 0,
    capped: false,
    clientFiles: [],
    dirs: [],
    trueBehind: 0,
    trueOthers: 0,
  }
  if (workspaceLayer.dirs.length > 0) {
    // Product-form probe: ONE `sync -n -m 501 <dir>...#head ...` with every
    // focus dir as a filespec — exactly what runSyncPreviewScan runs. The -m
    // semantics differ from per-filespec runs (measured: with #head +
    // multiple filespecs the server truncates earlier filespecs too, so the
    // per-dir sum OVERCOUNTS what the product will report). Only this form
    // predicts the product's count, cap flag and decoration set.
    const syncCombo = await runP4(
      ['-ztag', 'sync', '-n', '-m', String(BEHIND_PROBE), ...workspaceLayer.dirs.map((d) => `${d}/...#head`)],
      { timeoutMs: 120_000, echo: false },
    )
    userFocus.behind = (syncCombo.stdout.match(/\.\.\. depotFile/g) ?? []).length
    userFocus.capped = userFocus.behind > BEHIND_PROBE - 1
    userFocus.clientFiles.push(
      ...[...syncCombo.stdout.matchAll(/\.\.\. clientFile (.*)/g)].map((m) => m[1]),
    )
    const syncTotal = syncCombo.stdout.match(/totalFileCount (\d+)/)?.[1]
    console.log(
      `  focus sync -n -m ${BEHIND_PROBE} <${workspaceLayer.dirs.length} dirs>#head (product form): ${userFocus.behind} record(s) / totalFileCount=${syncTotal ?? '?'} in ${syncCombo.elapsedMs}ms${syncCombo.timedOut ? ' (TIMED OUT)' : ''}`,
    )
    // Ground truth: the same scopes with NO -m (the per-dir sum the product
    // would report if -m were per-filespec).
    for (const dir of workspaceLayer.dirs) {
      const r = await runP4(['-ztag', 'sync', '-n', `${dir}/...`], {
        timeoutMs: 300_000,
        echo: false,
      })
      const records = (r.stdout.match(/\.\.\. depotFile/g) ?? []).length
      userFocus.trueBehind += records
      userFocus.dirs.push({ dir, records, elapsedMs: r.elapsedMs, timedOut: r.timedOut })
      console.log(
        `  focus sync -n ${dir}/... (true, no -m): ${records} record(s) in ${r.elapsedMs}ms${r.timedOut ? ' (TIMED OUT)' : ''}`,
      )
    }
    // Product-form others probe: ONE `opened -a -m 301 <dirs>` (no #head).
    const othersCombo = await runP4(
      ['-ztag', 'opened', '-a', '-m', String(OTHERS_PROBE), ...workspaceLayer.dirs.map((d) => `${d}/...`)],
      { timeoutMs: 60_000, echo: false },
    )
    userFocus.others = (othersCombo.stdout.match(/\.\.\. depotFile/g) ?? []).length
    userFocus.othersCapped = userFocus.others > OTHERS_PROBE - 1
    userFocus.othersDepotFiles = [...othersCombo.stdout.matchAll(/\.\.\. depotFile (.*)/g)]
      .map((m) => m[1])
      .slice(0, 6)
    console.log(
      `  focus opened -a -m ${OTHERS_PROBE} <${workspaceLayer.dirs.length} dirs> (product form): ${userFocus.others} record(s) in ${othersCombo.elapsedMs}ms`,
    )
    for (const dir of workspaceLayer.dirs) {
      const r = await runP4(['-ztag', 'opened', '-a', `${dir}/...`], {
        timeoutMs: 300_000,
        echo: false,
      })
      const records = (r.stdout.match(/\.\.\. depotFile/g) ?? []).length
      userFocus.trueOthers += records
      console.log(
        `  focus opened -a ${dir}/... (true, no -m): ${records} record(s) in ${r.elapsedMs}ms`,
      )
    }

    // Widest dir under the focus dirs, for the C3a explorer navigation.
    let widestFocus = { dir: '', count: 0 }
    const counts = new Map()
    const walk = (d, depth) => {
      if (depth > 8) return
      let entries
      try {
        entries = readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      let files = 0
      const sub = []
      for (const e of entries) {
        if (e.isDirectory()) sub.push(join(d, e.name))
        else files++
      }
      if (files >= 300) counts.set(d, files)
      for (const s of sub) walk(s, depth + 1)
    }
    for (const dir of workspaceLayer.dirs) walk(join(WORKSPACE, dir), 0)
    for (const [d, c] of counts) if (c > widestFocus.count) widestFocus = { dir: d, count: c }
    if (widestFocus.count > 0) {
      userFocus.widest = widestFocus
      console.log(
        `  widest dir under focus: ${widestFocus.count} direct children (${rel(widestFocus.dir)})`,
      )
    }
    console.log(
      `  focus scope summary: product-form ${userFocus.behind} behind (cap${userFocus.capped ? '' : ' not'} hit, true ${userFocus.trueBehind}), ${userFocus.others} others (cap${userFocus.othersCapped ? '' : ' not'} hit, true ${userFocus.trueOthers})`,
    )
  }

  const checkoutFile = openedCount === 0 && !SKIP_CHECKOUT ? targets[0] : undefined
  if (openedCount === 0 && !SKIP_CHECKOUT && checkoutFile) {
    console.log(
      `zero opened files → C1 will 'p4 edit' ${rel(checkoutFile)} (try/finally revert) to exercise fstat -Ru`,
    )
  } else if (SKIP_CHECKOUT) {
    console.log('checkout skipped (UNIVERSE_P4_PROBE_SKIP_CHECKOUT=1) — fstat -Ru stays dormant')
  } else {
    console.log(
      'workspace already has opened files — fstat -Ru runs on every refresh, no edit needed',
    )
  }

  return {
    mine,
    openedCount,
    targets,
    small,
    big,
    cap,
    widest,
    checkoutFile,
    workspaceLayer,
    userFocus,
  }
}

// --- editor launch ------------------------------------------------------------------------------

function editorVersion() {
  try {
    return JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

async function launchScenario(label, { focusDirs } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ue-p4exp-'))
  const version = editorVersion()
  // NOTE: focus seeds here only matter on workspaces WITHOUT a project layer
  // (`.universe-editor/settings.json` beats the user layer). The real
  // workspace has its own project layer, so its focus config always wins.
  const settings = {
    'workbench.language': 'en-US',
    'update.mode': 'manual',
    'terminal.integrated.useWslProfiles': false,
    'perforce.syncPreview.intervalSec': INTERVAL_SEC,
    'perforce.openedByOthers.intervalSec': INTERVAL_SEC,
    ...(focusDirs && focusDirs.length > 0
      ? {
          'workspace.focusEnabled': true,
          'workspace.focusFolders': Object.fromEntries(focusDirs.map((d) => [d, true])),
        }
      : {}),
  }
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  writeFileSync(
    join(userData, 'state.json'),
    JSON.stringify({
      'welcome.agentOnboarding.seen': true,
      ...(version !== undefined ? { 'app.releaseNotes.lastVersion': version } : {}),
    }),
    'utf8',
  )
  writeFileSync(join(userData, 'vscode-user-settings.json'), '{}\n', 'utf8')
  writeFileSync(join(userData, 'vscode-user-keybindings.json'), '[]\n', 'utf8')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // Claude Code shell injects it — degrades Electron to plain Node
  delete env.UNIVERSE_EXTENSION_DEV_PATH
  delete env.UNIVERSE_INSPECT_EXTENSIONS
  delete env.UNIVERSE_INSPECT_BRK_EXTENSIONS
  delete env.PWD // P4CONFIG resolution (§10.1)
  delete env.UNIVERSE_P4_PATH
  delete env.UNIVERSE_P4_FAKE_STATE
  for (const key of Object.keys(env)) if (key.startsWith('MSYS')) delete env[key]
  env.UNIVERSE_E2E = '1'
  env.UNIVERSE_VSCODE_SETTINGS_PATH = join(userData, 'vscode-user-settings.json')
  env.UNIVERSE_VSCODE_KEYBINDINGS_PATH = join(userData, 'vscode-user-keybindings.json')

  const t0 = Date.now()
  console.log(`\n[launch] ${label}`)
  const app = await _electron.launch({
    executablePath: ELECTRON,
    // No positional workspace arg — see the header note on the dev-mode
    // parseFileToOpen bug. The folder is opened via openWorkspace below.
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`],
    cwd: APP_ROOT,
    env,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__E2E__))
  return { app, page, t0 }
}

async function closeApp(app) {
  let pid
  try {
    pid = app.process().pid
  } catch {
    pid = undefined
  }
  try {
    await Promise.race([app.close(), sleep(10_000)])
  } catch {
    // best-effort
  }
  if (pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // best-effort
    }
  }
}

// --- in-app probe helpers -----------------------------------------------------------------------

function makeCtx(page) {
  const channel = () => page.evaluate((n) => window.__E2E__.getOutputChannelContent(n), CHANNEL)
  const ctx = {
    page,
    channel,
    /** Wait until a NEW channel line matches `re` (count grows past `above`).
     *  Returns the matching line, or null on timeout. */
    async waitCount(re, above, { timeoutMs = 120_000, intervalMs = 300 } = {}) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const text = await channel()
        const lines = text.split(/\r?\n/)
        const hits = lines.filter((l) => re.test(l))
        if (hits.length > above && hits.length > 0) {
          return { line: hits[hits.length - 1], at: Date.now(), offsetMs: Date.now() - started }
        }
        await sleep(intervalMs)
      }
      return null
    },
    async channelCount(re) {
      const text = await channel()
      return text.split(/\r?\n/).filter((l) => re.test(l)).length
    },
    async statusTexts() {
      return page.evaluate(() => window.__E2E__.getStatusBarEntries().map((e) => e.text))
    },
    async waitStatus(re, { timeoutMs = 120_000, intervalMs = 300 } = {}) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const texts = await ctx.statusTexts()
        for (const t of texts) {
          const m = t.match(re)
          if (m) return { text: t, at: Date.now(), offsetMs: Date.now() - started }
        }
        await sleep(intervalMs)
      }
      return null
    },
    /** Wall-clock time of `runCommand(id, ...args)` in the renderer. */
    async timeCommand(id, ...args) {
      return page.evaluate(
        ([id, args]) => {
          const t0 = performance.now()
          return window.__E2E__.runCommand(id, ...args).then(
            () => ({ ms: Math.round(performance.now() - t0) }),
            (err) => ({ ms: Math.round(performance.now() - t0), error: String(err).slice(0, 160) }),
          )
        },
        [id, args],
      )
    },
    async decoFor(suffix) {
      return page.evaluate((s) => window.__E2E__.getScmDecorationForResource(s), suffix)
    },
    async perfSummary() {
      return page.evaluate(() => window.__E2E__.getInteractionPerfSummary())
    },
  }
  return ctx
}

/** All `[perforce] refresh/<stage>` lines in the channel so far. */
async function refreshStages(ctx) {
  const text = await ctx.channel()
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[perforce\] refresh\/([^ ]+) (\d+)ms/)
    if (m) out.push({ stage: m[1], ms: Number(m[2]) })
  }
  return out
}

async function printRefreshStages(ctx, label, from) {
  const stages = await refreshStages(ctx)
  const shown = stages.slice(from)
  console.log(
    `  ${label} refresh stages: ${shown.map((s) => `${s.stage}=${s.ms}ms`).join(' ') || '(none yet)'}`,
  )
  return stages.length
}

/** Open a behind file (have < head) and time how long its distinctive
 *  `#have / ↓#head` chip takes to render after the tab switch. */
async function chipSwitchTiming(ctx, behindFile) {
  try {
    await ctx.page.evaluate((f) => window.__E2E__.openFileUri(f), rel(behindFile))
    await sleep(1200)
    const t0 = nowMs()
    await ctx.page.evaluate((f) => window.__E2E__.openFileUri(f), rel(behindFile))
    const started = nowMs()
    while (nowMs() - started < 20_000) {
      const texts = await ctx.statusTexts()
      if (texts.some((t) => /↓#\d+/.test(t))) return nowMs() - t0
      await sleep(150)
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Count the extension-host boot lines visible in the Extension Host output
 *  channel — each `workspace root: <path>` line is one host spawn. */
async function hostBootLines(ctx) {
  const text = await ctx.page.evaluate(() =>
    window.__E2E__.getOutputChannelContent('Extension Host'),
  )
  return text
    .split(/\r?\n/)
    .filter((l) => l.includes('workspace root:'))
    .map((l) => l.trim())
}

/**
 * Boot 后 openWorkspace 的确定性路径（见文件头说明）。等待 renderer 工作区 pin
 * 与扩展宿主 re-pin 双重落定：renderer `getCurrentWorkspacePath()` 命中目标，
 * 且 Extension Host 频道出现带该路径的 `workspace root:` 行。
 * `dir` 默认 WORKSPACE；C1b 传 --c1b-dir 子树作工作区（确定性 20s sync -n 飞行）。
 * 返回 { rendererAt, hostRepinAt } 或 null（60s 超时）。
 */
async function openWorkspaceAndSettle(ctx, dir = WORKSPACE) {
  const t0 = nowMs()
  const want = rel(resolve(dir)).toLowerCase()
  const bootsBefore = (await hostBootLines(ctx)).length
  await ctx.page.evaluate((p) => window.__E2E__.openWorkspace(p), resolve(dir))
  let rendererAt = null
  let hostRepinAt = null
  const started = nowMs()
  while (nowMs() - started < 60_000) {
    if (rendererAt === null) {
      const cur = await ctx.page.evaluate(() => window.__E2E__.getCurrentWorkspacePath())
      if (cur && rel(cur).toLowerCase() === want) rendererAt = nowMs()
    }
    if (hostRepinAt === null) {
      const boots = await hostBootLines(ctx)
      if (boots.length > bootsBefore && boots.some((l) => l.toLowerCase().includes(want))) {
        hostRepinAt = nowMs()
      }
    }
    if (rendererAt !== null && hostRepinAt !== null) break
    await sleep(400)
  }
  if (rendererAt === null) {
    console.log(`  openWorkspace: renderer pin NEVER seen (want ${rel(dir)})`)
    return null
  }
  console.log(
    `  openWorkspace settled: renderer pin +${ms(rendererAt - t0)}, host re-pin +${ms((hostRepinAt ?? nowMs()) - t0)}${hostRepinAt === null ? ' (host line not seen yet)' : ''}`,
  )
  return { rendererAt, hostRepinAt }
}

/** The focus config the renderer's configuration service currently reports. */
async function readRendererFocus(ctx) {
  const cfg = await ctx.page.evaluate(() => ({
    enabled: window.__E2E__.getConfigurationValue('workspace.focusEnabled'),
    folders: window.__E2E__.getConfigurationValue('workspace.focusFolders'),
  }))
  const dirs = Object.entries(cfg.folders ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  return { enabled: cfg.enabled === true, dirs }
}

/**
 * openWorkspace-post-boot 路径上，project settings 槽（`<dir>/.universe-editor/
 * settings.json`）的绑定与扩展宿主读配置之间存在竞态：槽没绑好时宿主读到
 * focusEnabled=false（probe 特有路径；正常用户路径是窗口创建时 restoreCurrent）。
 * 实测后果：sync scope 回退 `<opened folder>`，整个 workspace 的 sync -n 撞 20s
 * watchdog，behind 计数永不发布。这里读取 renderer 焦点配置与预期比对，不匹配则
 * closeWorkspace → 重新 openWorkspaceAndSettle，重试 `retries` 次。返回
 * { ok, settled, refreshBaseline }——settled 是最终一次落定记录，refreshBaseline
 * 是该时刻已见到的 `refresh total` 行数（场景据此等待**新**刷新而非旧的）。
 */
async function ensureProjectLayer(ctx, expect, dir = WORKSPACE, retries = 2) {
  const wantEnabled = expect.enabled === true
  const wantDirs = expect.dirs?.length ?? 0
  let settled = null
  for (let i = 0; ; i++) {
    const cfg = await readRendererFocus(ctx)
    if (cfg.enabled === wantEnabled && cfg.dirs.length === wantDirs) {
      const refreshBaseline = await ctx.channelCount(/refresh total (\d+)ms/)
      return { ok: true, settled, refreshBaseline }
    }
    if (i >= retries) {
      console.log(
        `  ensureProjectLayer: renderer focus enabled=${cfg.enabled} dirs=${cfg.dirs.length} ≠ expected enabled=${wantEnabled} dirs=${wantDirs} after ${retries + 1} tries — project-layer race persists`,
      )
      return { ok: false, settled, refreshBaseline: await ctx.channelCount(/refresh total (\d+)ms/) }
    }
    console.log(
      `  ensureProjectLayer: renderer focus enabled=${cfg.enabled} dirs=${cfg.dirs.length} ≠ expected enabled=${wantEnabled} dirs=${wantDirs} — close+reopen (retry ${i + 1}/${retries})`,
    )
    await ctx.page.evaluate(() => window.__E2E__.closeWorkspace())
    await sleep(800)
    const s = await openWorkspaceAndSettle(ctx, dir)
    if (!s) {
      return { ok: false, settled, refreshBaseline: await ctx.channelCount(/refresh total (\d+)ms/) }
    }
    settled = s
    await sleep(1_200)
  }
}

/** Print the focus config the renderer sees and the perforce extension's own
 *  `[perforce] reconcile scope:` line — verifies the seeded focus settings
 *  actually reached the extension. */
async function printFocusState(ctx) {
  const cfg = await ctx.page.evaluate(() => ({
    focusEnabled: window.__E2E__.getConfigurationValue('workspace.focusEnabled'),
    focusFolders: window.__E2E__.getConfigurationValue('workspace.focusFolders'),
  }))
  const text = await ctx.channel()
  const scopeLine = text
    .split(/\r?\n/)
    .filter((l) => l.includes('[perforce] reconcile scope:'))
    .map((l) => l.trim())
    .at(-1)
  console.log(
    `  focus config: ${JSON.stringify(cfg)} · perforce reconcile scope: ${scopeLine ?? '(no line yet)'}`,
  )
}

// --- C1: interactive reads during background scans + fstat -Ru refresh cost ---------------------

/** The depot marker the product's cheap gate compares against: the latest
 *  submitted CL id per scope filespec, joined. Read-only replica of
 *  client._latestSubmittedChange. */
async function currentMarker(scopeDirs) {
  const ids = []
  for (const dir of scopeDirs) {
    const r = await runP4(['-ztag', 'changes', '-m', '1', '-s', 'submitted', `${dir}/...`], {
      timeoutMs: 30_000,
      echo: false,
    })
    const m = r.stdout.match(/\.\.\. change (\d+)/)
    if (m) ids.push(m[1])
  }
  return ids.join(',') || '<none>'
}

/** Poll until the joined marker differs from `baseline`. The product's
 *  behind-check only runs its expensive sync -n after the marker moved, so
 *  this is what deterministically opens the flying window. */
async function waitMarkerMove(scopeDirs, baseline, capMs) {
  const started = nowMs()
  let last = baseline
  while (nowMs() - started < capMs) {
    await sleep(15_000)
    last = await currentMarker(scopeDirs)
    if (last !== baseline) return { marker: last, at: nowMs(), offsetMs: nowMs() - started }
  }
  return null
}

/** Fire `count` openChange reads against `targets` and print per-read timing. */
async function readBurst(ctx, targets, offset, label, count) {
  const out = []
  if (targets.length === 0) {
    console.log(`  openChange ${label}: skipped (no targets — pass --target-dirs)`)
    return out
  }
  for (let i = 0; i < count; i++) {
    const file = targets[(i + offset) % targets.length]
    const r = await ctx.timeCommand('perforce.openChange', rel(file))
    out.push(r)
    console.log(`  openChange ${label} #${i + 1}: ${ms(r.ms)}${r.error ? ` ERROR ${r.error}` : ''}`)
  }
  return out
}

async function scenarioC1(disco) {
  tag('C1: interactive reads while background scans fly (reserved slot, real machine)')
  const { app, page, t0 } = await launchScenario('c1 — workspace focus config (real user config)')
  const ctx = makeCtx(page)
  const checkoutFile = disco.checkoutFile
  checkoutState.file = checkoutFile
  let checkoutDone = false
  try {
    await page.evaluate(() => window.__E2E__.whenReady())
    console.log(`  app ready at +${ms(nowMs() - t0)}`)
    const opened = await openWorkspaceAndSettle(ctx)
    if (!opened) throw new Error('openWorkspace did not settle — aborting')
    const proj = await ensureProjectLayer(ctx, {
      enabled: disco.workspaceLayer.enabled,
      dirs: disco.workspaceLayer.dirs,
    })
    if (!proj.ok) throw new Error('project layer did not settle — aborting (scenario needs the real focus scope)')
    const settledAt = proj.settled?.rendererAt ?? opened.rendererAt
    const firstRefresh = await ctx.waitCount(/refresh total (\d+)ms/, proj.refreshBaseline)
    console.log(
      `  first refresh total at +${ms(firstRefresh.at - t0)} (${ms(firstRefresh.at - settledAt)} from workspace open)`,
    )
    const stageCount = await printRefreshStages(ctx, 'zero-opened baseline:', 0)

    // Make fstat -Ru actually run: open one small file (only when zero opened).
    if (checkoutFile) {
      runCheckedWrite(['edit', checkoutFile])
      checkoutDone = true
      console.log('  -- refresh with one file opened (fstat -Ru now runs)')
      const tRefresh = await ctx.timeCommand('perforce.refresh')
      console.log(`  user-clicked refresh (with fstat -Ru): ${JSON.stringify(tRefresh)}`)
      const totalCount = await ctx.channelCount(/refresh total (\d+)ms/)
      const second = await ctx.waitCount(/refresh total (\d+)ms/, totalCount)
      if (second) console.log(`  second refresh total at +${ms(second.at - t0)}`)
      await printRefreshStages(ctx, 'with-fstat-Ru:', stageCount)
      const fstatHit = await ctx.waitCount(/fstat -Ru/, -1, { timeoutMs: 30_000 })
      console.log(
        `  fstat -Ru command line: ${fstatHit ? fstatHit.line.slice(0, 140) : 'NOT FOUND'}`,
      )
    }

    // One behind-check cycle. The product only runs its expensive sync -n after
    // the depot marker moved, so the cycle first waits for a real submission
    // (node-side poll, 8min cap), then clicks refresh — the check tail fires
    // (the interval floor is long past), the gate sees the new marker, and the
    // sync -n window opens for the interactive reads. (C1b provides the
    // deterministic always-flying window; this cycle is the real-user-shaped one.)
    const scopeDirs = disco.workspaceLayer.dirs.length > 0 ? disco.workspaceLayer.dirs : ['//...']
    const targets = disco.targets
    const during1 = []
    let chipMs
    {
      console.log(`  -- behind-check cycle 1`)
      const baseline = await currentMarker(scopeDirs)
      console.log(`    depot marker baseline: ${baseline}`)
      const moved = await waitMarkerMove(scopeDirs, baseline, 8 * 60_000)
      const gateCount = await ctx.channelCount(/changes -m 1 -s submitted/)
      const syncCount = await ctx.channelCount(/sync -n -m \d+/)
      const killCount = await ctx.channelCount(/timed out after \d+ms; killing/)
      if (moved) {
        console.log(`    marker moved ${baseline} → ${moved.marker} after ${ms(moved.offsetMs)}`)
      } else {
        console.log(
          `    marker did NOT move within 8min — sync -n stays skipped by design; sampling reads against the refresh fan-out instead`,
        )
      }
      await ctx.timeCommand('perforce.refresh')
      const gate = await ctx.waitCount(/changes -m 1 -s submitted/, gateCount, {
        timeoutMs: 30_000,
      })
      if (gate) console.log(`  cycle-1 gate line at +${ms(gate.at - t0)}`)
      const sync = await ctx.waitCount(/sync -n -m \d+/, syncCount, { timeoutMs: 30_000 })
      if (sync) {
        console.log(
          `  cycle-1 sync -n in flight at +${ms(sync.at - t0)}: ${sync.line.slice(0, 120)}`,
        )
        const burst = await readBurst(ctx, targets, 1, 'during cycle-1 sync -n', 3)
        during1.push(...burst)
      } else {
        console.log(`  cycle-1 sync -n NEVER FLEW (gate skipped)`)
        const burst = await readBurst(ctx, targets, 1, 'after cycle-1 refresh', 3)
        during1.push(...burst)
      }

      // The 20s watchdog: with the focus scope the sync -n finishes in ~2-5s,
      // so the kill line must NOT appear. 8s window after the sync line is
      // enough to prove completion under the ceiling.
      const kill = await ctx.waitCount(/timed out after \d+ms; killing/, killCount, {
        timeoutMs: 8_000,
      })
      console.log(
        `  cycle-1 sync -n watchdog: ${kill ? kill.line.slice(0, 100) : 'NOT FIRED (sync -n completed under the 20s ceiling)'}`,
      )
      const behindAfter = await ctx.waitStatus(/files behind/, { timeoutMs: 6_000 })
      console.log(
        `  status bar after cycle 1: ${behindAfter ? `'${behindAfter.text}'` : 'still NO behind count'}`,
      )
      {
        const chipFile = disco.userFocus.clientFiles[0] ?? disco.small.clientFiles[0]
        chipMs = chipFile ? await chipSwitchTiming(ctx, chipFile) : undefined
        if (chipMs !== undefined)
          console.log(
            `  status-bar rev chip (↓#) render after tab switch, during scan: ${ms(chipMs)}`,
          )

        // Status-bar sanity DURING the scan: the main item must not spin (the
        // behind-check is fire-and-forget, not under _withBusy).
        const busyDuring = []
        for (let i = 0; i < 3; i++) {
          busyDuring.push(...(await ctx.statusTexts()).filter((t) => t.includes('…')))
          await sleep(1_000)
        }
        console.log(
          `  busy labels seen during cycle: ${busyDuring.length === 0 ? 'NONE (fire-and-forget holds)' : [...new Set(busyDuring)].join(' | ')}`,
        )
        const failedLog = await ctx.channelCount(/behind-check failed/)
        if (failedLog > 0) console.log(`  channel: behind-check failed logged (${failedLog}×)`)
      }
    }

    // Idle baseline for the same interactive reads.
    console.log('  -- idle baseline (all scans settled)')
    await sleep(3_000)
    const idle = []
    for (let i = 0; i < 3; i++) {
      const file = targets[i % targets.length]
      const r = await ctx.timeCommand('perforce.openChange', rel(file))
      idle.push(r)
      console.log(`  openChange idle #${i + 1}: ${ms(r.ms)}${r.error ? ` ERROR ${r.error}` : ''}`)
    }
    const queuedLines = (await ctx.channel()).split(/\r?\n/).filter((l) => l.includes('(queued'))
    console.log(
      `  queued-slot log lines: ${queuedLines.length}${queuedLines.length > 0 ? `\n    ${queuedLines.slice(-6).join('\n    ')}` : ''}`,
    )
    const openChangeLines = (await ctx.channel())
      .split(/\r?\n/)
      .filter((l) => l.includes('[perforce] openChange '))
    console.log(
      `  openChange breakdowns (fstat/print/read/total):${openChangeLines.length === 0 ? ' NONE' : ''}`,
    )
    for (const l of openChangeLines.slice(-8)) console.log(`    ${l.trim().slice(0, 130)}`)
    console.log(
      `  C1 numbers: during-scan [${during1.map((r) => r.ms).join(', ')}] / idle [${idle.map((r) => r.ms).join(', ')}]`,
    )
    return { during1, idle, chipMs }
  } finally {
    if (checkoutDone && checkoutFile) {
      try {
        runCheckedWrite(['revert', checkoutFile])
      } catch (err) {
        console.error(`  !! REVERT FAILED: ${err}`)
      }
      const verify = await runP4(['opened'], { echo: false })
      console.log(
        `  [revert evidence] p4 opened lists the probe file: ${verify.stdout.includes(rel(checkoutFile)) ? 'YES — LEAKED' : 'NO — clean'}`,
      )
    }
    await closeApp(app)
  }
}

// --- C1b: deterministic 20s sync -n flight (a big subtree as the workspace) ---------------

async function scenarioC1b(disco) {
  if (!C1B_DIR) {
    console.log(`C1b skipped — pass --c1b-dir <relDir> (a big subtree whose sync -n exceeds the 20s ceiling)`)
    return null
  }
  const dir = join(WORKSPACE, C1B_DIR)
  if (!existsSync(dir)) {
    console.log(`C1b skipped — ${rel(dir)} does not exist`)
    return null
  }
  tag(
    'C1b: interactive reads while the 20s sync -n watchdog flight deterministically flies (subtree workspace)',
  )
  // No focus config under the subtree → the default scope is the opened folder
  // itself → the behind-check's sync -n walks the whole subtree, measured
  // node-side at >180s — the 20s watchdog kill is guaranteed, and the 20s
  // window is the deterministic flight for interactive reads.
  const { app, page, t0 } = await launchScenario('c1b — subtree workspace')
  const ctx = makeCtx(page)
  const targets = disco.targets.filter((t) =>
    rel(t).toLowerCase().startsWith(rel(dir).toLowerCase()),
  )
  try {
    await page.evaluate(() => window.__E2E__.whenReady())
    const opened = await openWorkspaceAndSettle(ctx, dir)
    if (!opened) throw new Error('openWorkspace did not settle — aborting')
    const proj = await ensureProjectLayer(ctx, { enabled: false, dirs: [] }, dir, 1)
    await printFocusState(ctx)
    const firstRefresh = await ctx.waitCount(/refresh total (\d+)ms/, proj.refreshBaseline, {
      timeoutMs: 180_000,
    })
    if (firstRefresh) console.log(`  first refresh total at +${ms(firstRefresh.at - t0)}`)
    const gate = await ctx.waitCount(/changes -m 1 -s submitted/, -1, { timeoutMs: 90_000 })
    console.log(
      `  behind gate line at +${ms((gate?.at ?? t0) - t0)}: ${gate ? gate.line.slice(0, 100) : 'NONE'}`,
    )
    const sync = await ctx.waitCount(/sync -n -m \d+/, -1, { timeoutMs: 90_000 })
    if (!sync) {
      console.log('  sync -n NEVER FLEW — aborting C1b')
      return null
    }
    console.log(`  sync -n in flight at +${ms(sync.at - t0)}: ${sync.line.slice(0, 120)}`)
    const during = await readBurst(ctx, targets, 0, 'during sync -n flight', 4)
    const kill = await ctx.waitCount(/timed out after \d+ms; killing/, -1, { timeoutMs: 40_000 })
    console.log(
      `  watchdog kill: ${kill ? `✓ ${kill.line.slice(0, 110)} at +${ms(kill.at - t0)}` : 'NOT FIRED'}`,
    )
    const behind = await ctx.waitStatus(/files behind/, { timeoutMs: 10_000 })
    console.log(
      `  behind count after watchdog: ${behind ? `'${behind.text}' (unexpected)` : 'never published ✓ (previous result kept, next interval retries)'}`,
    )
    console.log('  -- idle baseline (flight over)')
    await sleep(2_000)
    const idle = []
    for (let i = 0; i < 3; i++) {
      const file = targets[i % targets.length]
      const r = await ctx.timeCommand('perforce.openChange', rel(file))
      idle.push(r)
      console.log(`  openChange idle #${i + 1}: ${ms(r.ms)}${r.error ? ` ERROR ${r.error}` : ''}`)
    }
    const queuedLines = (await ctx.channel()).split(/\r?\n/).filter((l) => l.includes('(queued'))
    console.log(
      `  queued-slot log lines: ${queuedLines.length}${queuedLines.length > 0 ? `\n    ${queuedLines.slice(-6).join('\n    ')}` : ''}`,
    )
    console.log(
      `  C1b numbers: during-flight [${during.map((r) => r.ms).join(', ')}] / idle [${idle.map((r) => r.ms).join(', ')}]`,
    )
    return { during, idle, killAt: kill ? kill.at - t0 : null }
  } finally {
    await closeApp(app)
  }
}

// --- C2: status-bar behind count end-to-end latency (happy path, narrow focus) ------------------

async function scenarioC2(disco) {
  tag(
    `C2: status-bar count latency, real workspace focus config (${disco.workspaceLayer.dirs.length} dir(s))`,
  )
  const { app, page, t0 } = await launchScenario('c2 — real workspace focus config')
  const ctx = makeCtx(page)
  try {
    await page.evaluate(() => window.__E2E__.whenReady())
    const opened = await openWorkspaceAndSettle(ctx)
    if (!opened) throw new Error('openWorkspace did not settle — aborting')
    const proj = await ensureProjectLayer(ctx, {
      enabled: disco.workspaceLayer.enabled,
      dirs: disco.workspaceLayer.dirs,
    })
    if (!proj.ok) throw new Error('project layer did not settle — aborting (scenario needs the real focus scope)')
    const settledAt = proj.settled?.rendererAt ?? opened.rendererAt
    const dump = async (label) => {
      console.log(`  -- diagnostics ${label}`)
      const text = await ctx.channel()
      const tail = text.split(/\r?\n/).filter(Boolean).slice(-25)
      for (const l of tail) console.log(`    | ${l.slice(0, 150)}`)
      console.log(`  status bar: ${(await ctx.statusTexts()).map((t) => `'${t}'`).join(' | ')}`)
      console.log(
        `  scm count: ${await page.evaluate(() => window.__E2E__.getScmSourceControlCount())}`,
      )
      const cfg = await page.evaluate(() => ({
        focusEnabled: window.__E2E__.getConfigurationValue('workspace.focusEnabled'),
        focusFolders: window.__E2E__.getConfigurationValue('workspace.focusFolders'),
        workspace: window.__E2E__.getCurrentWorkspacePath(),
      }))
      console.log(`  config: ${JSON.stringify(cfg)}`)
    }
    const firstRefresh = await ctx.waitCount(/refresh total (\d+)ms/, proj.refreshBaseline, {
      timeoutMs: 180_000,
    })
    if (!firstRefresh) {
      await dump('first refresh never seen')
      throw new Error('perforce first refresh did not complete — see diagnostics above')
    }
    await printFocusState(ctx)
    const gate = await ctx.waitCount(/changes -m 1 -s submitted/, -1, { timeoutMs: 60_000 })
    const sync = await ctx.waitCount(/sync -n -m \d+/, -1, { timeoutMs: 60_000 })
    const behind = await ctx.waitStatus(/files behind/, { timeoutMs: 45_000 })
    const logLine = await ctx.waitCount(/\[perforce\] behind-check/, -1, { timeoutMs: 45_000 })
    console.log('  timeline (offset from launch / from workspace open):')
    console.log(
      `    first refresh total  +${ms(firstRefresh.at - t0)} / +${ms(firstRefresh.at - settledAt)}`,
    )
    console.log(
      `    cheap gate line      +${ms((gate?.at ?? t0) - t0)} / +${ms((gate?.at ?? settledAt) - settledAt)}`,
    )
    console.log(
      `    sync -n line         +${ms((sync?.at ?? t0) - t0)} / +${ms((sync?.at ?? settledAt) - settledAt)}`,
    )
    console.log(
      `    behind count shown   +${ms((behind?.at ?? t0) - t0)} / +${ms((behind?.at ?? settledAt) - settledAt)} → '${behind?.text ?? 'NEVER APPEARED'}'`,
    )
    if (logLine) console.log(`    channel              ${logLine.line.slice(0, 130)}`)
    await printRefreshStages(ctx, 'refresh:', 0)
    if (!behind) await dump('behind count never appeared')
    return { behindAtMs: behind ? behind.at - t0 : null, behindText: behind?.text ?? null }
  } finally {
    await closeApp(app)
  }
}

// --- C3a: grey text rendering in a large directory (real focus scope) ----------------------------

async function scenarioC3a(disco) {
  const focus = disco.userFocus
  if (focus.behind === 0) {
    console.log('C3a skipped — the real focus scope has zero behind files')
    return null
  }
  if (!focus.widest) {
    console.log('C3a skipped — no wide directory found under the focus dirs')
    return null
  }
  if (focus.capped) {
    console.log(
      `NOTE: the real focus scope reports ${focus.behind}+ behind (>= ${BEHIND_PROBE}) — the cap path clears every per-file marker, so POSITIVE grey-text rendering is unreachable on this machine's real config. C3a verifies the capped-state Explorer instead: zero decorations in the ${focus.widest.count}-child dir + scroll performance.`,
    )
  }
  tag(
    `C3a: grey text in large dir, real focus scope (${focus.behind}${focus.capped ? '+' : ''} behind${focus.capped ? ', CAP state' : ''}, widest dir ${focus.widest.count} children)`,
  )
  const { app, page, t0 } = await launchScenario('c3a — real workspace focus config')
  const ctx = makeCtx(page)
  try {
    await page.evaluate(() => window.__E2E__.whenReady())
    const opened = await openWorkspaceAndSettle(ctx)
    if (!opened) throw new Error('openWorkspace did not settle — aborting')
    const proj = await ensureProjectLayer(ctx, {
      enabled: disco.workspaceLayer.enabled,
      dirs: disco.workspaceLayer.dirs,
    })
    if (!proj.ok) throw new Error('project layer did not settle — aborting (scenario needs the real focus scope)')
    await ctx.waitCount(/refresh total (\d+)ms/, proj.refreshBaseline, { timeoutMs: 180_000 })
    await printFocusState(ctx)
    const behind = await ctx.waitStatus(/files behind/, { timeoutMs: 90_000 })
    console.log(`  status bar: '${behind?.text}' at +${ms((behind?.at ?? t0) - t0)}`)
    const logLine = await ctx.waitCount(/\[perforce\] behind-check: /, -1)
    if (logLine) console.log(`  channel: ${logLine.line.slice(0, 130)}`)
    const syncExit = await ctx.waitCount(/sync -n -m \d+/, -1)
    if (syncExit) console.log(`  sync -n command: ${syncExit.line.slice(0, 140)}`)

    // Decorations: uncapped → every discovered behind file carries 'update
    // available'; capped → the cap path cleared them all (must be null).
    const expectDeco = focus.capped ? null : 'update available'
    const behindSample = focus.clientFiles.slice(0, 8)
    let decoOk = 0
    for (const local of behindSample) {
      const d = await ctx.decoFor(basename(local))
      const good = expectDeco === null ? d === null : d?.description === 'update available'
      if (good) decoOk++
      console.log(
        `  deco(${basename(local).slice(0, 64)}): ${good ? `${expectDeco === null ? 'null (cap cleared) ✓' : 'update available ✓'}` : `MISSING/STRAY (${JSON.stringify(d)})`}`,
      )
    }
    // Negative samples from the widest dir: files on disk that sync -n did NOT
    // list as behind (uncapped state would prove no false decoration; capped
    // state is trivially null too).
    const behindSet = new Set(focus.clientFiles.map((p) => rel(p).toLowerCase()))
    const negatives = []
    try {
      for (const e of readdirSync(focus.widest.dir)) {
        const full = join(focus.widest.dir, e)
        try {
          if (!statSync(full).isFile()) continue
        } catch {
          continue
        }
        if (!behindSet.has(rel(full).toLowerCase())) {
          negatives.push({ name: basename(full), path: full })
          if (negatives.length >= 3) break
        }
      }
    } catch {
      // fall through
    }
    for (const n of negatives) {
      const d = await ctx.decoFor(n.name)
      console.log(
        `  deco on up-to-date ${n.name.slice(0, 48)}: ${d === null ? 'null ✓ (no false decoration)' : JSON.stringify(d)}`,
      )
    }

    // Explorer DOM: opening a file inside the widest dir auto-reveals it
    // (ExplorerAutoRevealContribution, explorer.autoReveal default on) —
    // every ancestor expands, so the big directory renders without fragile
    // row-by-row click navigation (Source/Config has too many children for
    // 'Raw' to be in the virtualized viewport).
    console.log('  -- explorer navigation (open file → auto-reveal)')
    await ctx.timeCommand('workbench.view.explorer')
    await sleep(600)
    let revealTarget = negatives[0]?.path
    if (!revealTarget) {
      revealTarget = findFileUnder(focus.widest.dir, () => true)
    }
    if (revealTarget) {
      await page.evaluate((f) => window.__E2E__.openFileUri(f), rel(revealTarget))
    }
    await sleep(2_500)
    const decoratedRows = await page
      .locator('[role="treeitem"]', { hasText: 'update available' })
      .count()
    const visibleRows = await page.locator('[role="treeitem"]').count()
    console.log(
      `  explorer after reveal: ${visibleRows} rendered rows, ${decoratedRows} carrying grey 'update available'`,
    )

    // Scroll the several-thousand-row directory a few pages and watch interaction perf.
    const before = await ctx.perfSummary()
    const scrollT0 = nowMs()
    try {
      await page.locator('[role="treeitem"]').first().click({ timeout: 3_000 })
    } catch {
      // fall through
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('PageDown')
      await sleep(350)
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('PageUp')
      await sleep(350)
    }
    const scrollMs = nowMs() - scrollT0
    const after = await ctx.perfSummary()
    const cutoff =
      before.slowest.length > 0 ? before.slowest[before.slowest.length - 1].startTime : 0
    const slow = after.slowest.filter((e) => e.startTime >= cutoff)
    console.log(
      `  scroll session: ${ms(scrollMs)}, new interactions=${after.interactionCount - before.interactionCount}, new slow=${after.slowCount - before.slowCount}`,
    )
    for (const e of slow.slice(0, 5)) {
      console.log(
        `    slow: ${e.label} ${ms(e.durationMs)} (input ${ms(e.decomposition.inputDelayMs)} / proc ${ms(e.decomposition.processingMs)} / present ${ms(e.decomposition.presentationDelayMs)})`,
      )
    }

    // Positive grey-text RENDERING: the widest dir happened to contain zero
    // behind files (its 0-grey result above is correct, not a test gap). Reveal
    // the densest behind directory instead and count the grey rows in the DOM.
    const byDir = new Map()
    for (const p of focus.clientFiles) {
      const d = rel(dirname(p)).toLowerCase()
      byDir.set(d, (byDir.get(d) ?? 0) + 1)
    }
    let densest = { dir: '', count: 0 }
    for (const [d, c] of byDir) if (c > densest.count) densest = { dir: d, count: c }
    if (densest.count > 0 && !focus.capped) {
      const densestFile = focus.clientFiles.find(
        (p) => rel(dirname(p)).toLowerCase() === densest.dir,
      )
      console.log(
        `  -- grey-text rendering: reveal the densest behind dir (${densest.count} behind, ${densest.dir})`,
      )
      await page.evaluate((f) => window.__E2E__.openFileUri(f), rel(densestFile))
      await sleep(2_500)
      const greyRows = await page
        .locator('[role="treeitem"]', { hasText: 'update available' })
        .count()
      const rowsNow = await page.locator('[role="treeitem"]').count()
      console.log(
        `  explorer in behind dir: ${rowsNow} rendered rows, ${greyRows} carrying grey 'update available' (dir has ${densest.count} behind)`,
      )
      return {
        behindText: behind?.text,
        decoOk,
        decoratedRows,
        visibleRows,
        scrollMs,
        greyRows,
      }
    }
    return { behindText: behind?.text, decoOk, decoratedRows, visibleRows, scrollMs }
  } finally {
    await closeApp(app)
  }
}

// --- C3b: cap behaviour — 301+ others (real scope) + 501+ behind (only if the scope reaches it) --

async function scenarioC3b(disco) {
  const focus = disco.userFocus
  if (focus.others === 0 && focus.behind === 0) {
    console.log('C3b skipped — the real focus scope has no others and no behind files')
    return null
  }
  tag(`C3b: decoration caps, real focus scope (${focus.others} others, ${focus.behind} behind)`)
  const { app, page, t0 } = await launchScenario('c3b — real workspace focus config')
  const ctx = makeCtx(page)
  try {
    await page.evaluate(() => window.__E2E__.whenReady())
    const opened = await openWorkspaceAndSettle(ctx)
    if (!opened) throw new Error('openWorkspace did not settle — aborting')
    const proj = await ensureProjectLayer(ctx, {
      enabled: disco.workspaceLayer.enabled,
      dirs: disco.workspaceLayer.dirs,
    })
    if (!proj.ok) throw new Error('project layer did not settle — aborting (scenario needs the real focus scope)')
    await ctx.waitCount(/refresh total (\d+)ms/, proj.refreshBaseline, { timeoutMs: 180_000 })
    await printFocusState(ctx)
    const behind = await ctx.waitStatus(/files behind/, { timeoutMs: 90_000 })
    console.log(`  status bar: '${behind?.text}' at +${ms((behind?.at ?? t0) - t0)}`)

    // Others cap (>300): the real scope has 301+ `opened -a` records → the
    // product must log loudly, keep the count and clear the per-file markers.
    const othersLog = await ctx.waitCount(/opened-by-others: more than \d+ files/, -1, {
      timeoutMs: 45_000,
    })
    console.log(
      `  others cap log (>300): ${othersLog ? `✓ ${othersLog.line.slice(0, 150)}` : 'NOT FOUND'}`,
    )
    const othersCount = await ctx.waitCount(/\[perforce\] opened-by-others: \d+/, -1, {
      timeoutMs: 30_000,
    })
    if (othersCount) console.log(`  others count line: ${othersCount.line.slice(0, 140)}`)

    // Behind cap (>500): only when the scope really reports 501+ behind.
    let capLog = null
    if (focus.capped) {
      capLog = await ctx.waitCount(/behind-check: more than \d+ files behind/, -1, {
        timeoutMs: 45_000,
      })
      console.log(
        `  behind cap log (>500): ${capLog ? `✓ ${capLog.line.slice(0, 150)}` : 'NOT FOUND'}`,
      )
    } else {
      console.log(
        `  behind cap (>500): NOT REACHABLE in the real focus scope (${focus.behind} behind < ${BEHIND_PROBE}); changing the check scope would need a workspace-layer write (forbidden). Covered by unit tests + fake-p4 e2e instead.`,
      )
    }

    // Capped paths must leave the Explorer clean: no grey text on files the
    // scan did find (behind) or would have found (others).
    const behindSample = focus.clientFiles.slice(0, 6)
    let cleared = 0
    for (const local of behindSample) {
      const d = await ctx.decoFor(basename(local))
      if (d === null) cleared++
      else console.log(`  deco(${basename(local).slice(0, 64)}): ${JSON.stringify(d)}`)
    }
    console.log(
      `  decorations for ${behindSample.length} behind files: ${cleared}/${behindSample.length} clean`,
    )
    // Others: the scan's depotFile entries must be translated to local paths
    // (p4 where — same as the product's _whereLocalPaths) before checking the
    // Explorer. Capped → all null; uncapped → 'in use by others'.
    let othersCleared = 0
    let othersLocal = 0
    if (focus.othersDepotFiles.length > 0) {
      for (const depot of focus.othersDepotFiles) {
        const r = await runP4(['-ztag', 'where', depot], { timeoutMs: 30_000, echo: false })
        const m = r.stdout.match(/\.\.\. path (.*)/)
        if (!m) continue
        othersLocal++
        const d = await ctx.decoFor(basename(m[1]))
        if (d === null) othersCleared++
        else console.log(`  deco(others ${basename(m[1]).slice(0, 64)}): ${JSON.stringify(d)}`)
      }
      console.log(
        `  decorations for ${othersLocal} others files: ${othersCleared}/${othersLocal} clean${focus.othersCapped ? '' : ' (others NOT capped — expect per-file grey text here)'}`,
      )
    }
    const statusTexts = await ctx.statusTexts()
    console.log(`  status bar entries: ${statusTexts.map((t) => `'${t}'`).join(' | ')}`)
    return { behindText: behind?.text, capLogged: !!capLog, othersLogged: !!othersLog, cleared }
  } finally {
    await closeApp(app)
  }
}

// --- main ---------------------------------------------------------------------------------------

async function main() {
  console.log(`workspace: ${WORKSPACE}`)
  console.log(`scenarios: ${SCENARIOS.join(',')} · interval floor: ${INTERVAL_SEC}s`)
  if (!existsSync(MAIN_ENTRY)) {
    console.error(`FATAL: ${MAIN_ENTRY} missing — build the editor first (see header)`)
    process.exit(2)
  }
  if (!existsSync(WORKSPACE)) {
    console.error(`FATAL: workspace ${WORKSPACE} does not exist`)
    process.exit(2)
  }

  const disco = await discover()

  if (wants('c1')) await scenarioC1(disco)
  if (wants('c1b')) await scenarioC1b(disco)
  if (wants('c2')) await scenarioC2(disco)
  if (wants('c3a')) await scenarioC3a(disco)
  if (wants('c3b')) await scenarioC3b(disco)

  console.log('\n===== C4: error-guidance chain =====')
  console.log(
    '  clobber → "Collect Changes" → reconcile(targets): code-verified in extension.ts runSync.',
  )
  console.log(
    '  The real-machine stderr the classifier matches ("Can\'t clobber writable file") was verified',
  )
  console.log(
    '  on the B-round throwaway client (PROBE-FINDINGS §11.2). Triggering a real clobber needs a',
  )
  console.log('  write sync — NOT performed on this workspace. UI-button click on a real machine:')
  console.log('  NOT VERIFIED (documented boundary, see §12).')

  const verify = await runP4(['opened'], { echo: false })
  const leftover = verify.stdout.trim()
  console.log(
    `\nfinal workspace state: p4 opened → ${leftover ? `${leftover.split(/\r?\n/).length} file(s) still open` : '0 files open (clean)'}`,
  )
  console.log('\ndone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
