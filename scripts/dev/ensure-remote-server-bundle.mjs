#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Ensures packages/remote-server/dist-bundle is fresh before `pnpm dev` / `pnpm dev:run`.
 *
 *  Why this exists: connecting to a remote host recomputes dist-bundle's content hash and
 *  compares it to the remote `bundle.hash`; a stale dist-bundle means the remote runs old
 *  code, and a missing one fails open (skips the staleness comparison). A bare clone has no
 *  dist-bundle at all, so the first remote connect would silently skip self-healing.
 *
 *  Fast path mirrors dev-run.mjs's stamp-skip: fingerprint the bundle's *input surface*
 *  (mtime+size only, no file contents) and skip when it matches the stamp and bootstrap.js
 *  exists. Only on mismatch do we run `esbuild.config.mjs --bundle` (invoked via node, not
 *  pnpm/turbo — Windows pays ~0.7s per pnpm layer).
 *
 *  The stamp lives OUTSIDE dist-bundle (packages/remote-server/.bundle-stamp.json): the whole
 *  tree is tar-deployed and content-hashed, so a stamp inside it would make repeated builds
 *  produce a different hash via mtime jitter → spurious redeploy every connect.
 *
 *  Input surface (kept slightly wider than the true esbuild graph — a missed input means a
 *  stale bundle, which is worse than one extra rebuild):
 *    - remote-server/{src, esbuild.config.mjs, package.json}
 *    - extension-host/src (bundled as the extension-host/bootstrap entry)
 *    - dist/ of every @universe-editor/* dep of those two packages (transitive) — these are
 *      inlined by esbuild (everything except the three native externals)
 *    - each built-in extension's staged files, via the same extensionPackageFiles() the bundle uses
 *    - vendor/{claude-agent-acp,codex-acp}/{dist,package.json,package-lock.json} (staged)
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionPackageFiles } from '@universe-editor/extension-packaging'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const remoteServerDir = resolve(repoRoot, 'packages/remote-server')
const extensionHostDir = resolve(repoRoot, 'packages/extension-host')
const bundleDir = resolve(remoteServerDir, 'dist-bundle')
const STAMP_FILE = resolve(remoteServerDir, '.bundle-stamp.json')
const STAMP_VERSION = 1

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * dist/ of every workspace package reachable from the two bundle seeds (dependencies +
 * devDependencies — extension-packaging is a devDep yet drives staging, and platform is a
 * devDep of extension-host yet gets inlined). Missing dist dirs (config-ts has none) fold
 * into a stable `missing` entry rather than an error.
 */
function collectWorkspaceDists() {
  const dists = []
  const seen = new Set()
  const visit = (pkgDir) => {
    const pkg = readPkg(pkgDir)
    if (!pkg) return
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@universe-editor/')) continue
      const sub = name.slice('@universe-editor/'.length)
      if (seen.has(sub)) continue
      seen.add(sub)
      const dir = resolve(repoRoot, 'packages', sub)
      dists.push(resolve(dir, 'dist'))
      visit(dir)
    }
  }
  visit(remoteServerDir)
  visit(extensionHostDir)
  return dists
}

// The exact file set stageBuiltinExtensions copies — shared source of truth so the
// fingerprint can't drift from what actually lands in dist-bundle/extensions/.
function collectExtensionStagedFiles() {
  const extsRoot = resolve(repoRoot, 'extensions')
  const files = []
  if (!existsSync(extsRoot)) return files
  for (const entry of readdirSync(extsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const extDir = resolve(extsRoot, entry.name)
    const manifest = readPkg(extDir)
    if (!manifest) continue
    for (const file of extensionPackageFiles(manifest)) {
      files.push(resolve(extDir, ...file.split('/')))
    }
  }
  return files
}

// The exact file set stageVendorAgents copies.
function collectVendorFiles() {
  const files = []
  for (const name of ['claude-agent-acp', 'codex-acp']) {
    for (const sub of ['dist', 'package.json', 'package-lock.json']) {
      files.push(resolve(repoRoot, 'vendor', name, sub))
    }
  }
  return files
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__'])
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/

const entriesCache = new Map()

function collectEntries(abs, out) {
  const cached = entriesCache.get(abs)
  if (cached) {
    out.push(...cached)
    return
  }
  const own = []
  let st
  try {
    st = statSync(abs)
  } catch {
    // 目录/文件出现与消失同样要反映进指纹
    own.push(`${abs}|missing`)
    entriesCache.set(abs, own)
    out.push(...own)
    return
  }
  if (st.isFile()) {
    own.push(`${abs}|${st.mtimeMs}|${st.size}`)
  } else {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) collectEntries(join(abs, e.name), own)
      } else if (e.isFile() && !TEST_FILE_RE.test(e.name)) {
        const p = join(abs, e.name)
        const s = statSync(p)
        own.push(`${p}|${s.mtimeMs}|${s.size}`)
      }
    }
  }
  entriesCache.set(abs, own)
  out.push(...own)
}

function fingerprint(inputs) {
  const out = []
  for (const abs of inputs) collectEntries(abs, out)
  out.sort()
  return createHash('sha256').update(out.join('\n')).digest('hex')
}

const INPUTS = [
  resolve(remoteServerDir, 'src'),
  resolve(remoteServerDir, 'esbuild.config.mjs'),
  resolve(remoteServerDir, 'package.json'),
  resolve(extensionHostDir, 'src'),
  ...collectWorkspaceDists(),
  ...collectExtensionStagedFiles(),
  ...collectVendorFiles(),
]

const t0 = Date.now()
const hash = fingerprint(INPUTS)

let stampedHash
try {
  const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
  if (stamp.version === STAMP_VERSION) stampedHash = stamp.hash
} catch {
  // 首跑 / stamp 损坏 → 全量
}

const bootstrapExists = existsSync(resolve(bundleDir, 'bootstrap.js'))

if (stampedHash === hash && bootstrapExists) {
  console.log(`[remote-server-bundle] up to date — skipping (${Date.now() - t0}ms)`)
  process.exit(0)
}

console.log(
  `[remote-server-bundle] ${bootstrapExists ? 'inputs changed' : 'bundle missing'} — bundling remote-server…`,
)

const build = spawnSync(process.execPath, ['esbuild.config.mjs', '--bundle'], {
  cwd: remoteServerDir,
  stdio: 'inherit',
})
if (build.status !== 0) {
  console.error('[remote-server-bundle] bundle failed')
  process.exit(build.status ?? 1)
}

writeFileSync(STAMP_FILE, JSON.stringify({ version: STAMP_VERSION, hash }, null, 2) + '\n')
console.log(`[remote-server-bundle] done (${Date.now() - t0}ms)`)
