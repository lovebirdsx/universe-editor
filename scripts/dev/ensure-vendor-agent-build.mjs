#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Rebuilds a vendored ACP agent's `dist/` bundle when its sources have moved ahead of the
 *  last build — the staleness guard `pnpm dev` / `pnpm dev:run` were missing.
 *
 *  Why this exists: the editor and the agent it spawns share a wire contract (permission
 *  option ids, session-update shapes) but are built by different toolchains. electron-vite
 *  rebuilds `out/` on every dev start, while the vendor bundles only rebuild when someone
 *  remembers `pnpm agent:build`. `vendor-install.mjs` stamps package-lock.json alone, so it
 *  skips its (correctly) expensive npm ci even when src/ was just brought forward by
 *  `git submodule update`. The result is a dev session running NEW editor code against an OLD
 *  agent bundle, and the mismatch surfaces only as a behavior quirk: on 2026-10-05 the
 *  ExitPlanMode option ids moved into the `exit-plan-*` namespace, the editor found no match
 *  for the configured auto-execute mode, and the plan countdown silently fell back to manual
 *  — no error, no log pointing at the build.
 *
 *  Fast path mirrors the sibling guards (ensure-workspace-build / ensure-remote-server-bundle):
 *  fingerprint each vendor's input surface (mtime+size aggregate, never file contents) and skip
 *  when it matches the stamp AND the bundle exists. Only stale vendors pay a build, so the npm
 *  layer launch cost is paid at most once per real change. Force with
 *  UNIVERSE_VENDOR_AGENT_BUILD_FORCE=1. Known blind spot of that aggregate: a same-length
 *  rewrite that doesn't advance the filesystem clock tick (Windows: mtime granularity is the
 *  system tick, not the file) keeps the fingerprint identical and skips the rebuild.
 *
 *  Input surface (kept slightly wider than the true esbuild graph — a missed input means a
 *  stale bundle, which is worse than one extra rebuild):
 *    - src/ (`.test.*` / `__tests__/` excluded: they never enter the bundle — note the fork
 *      layout also keeps non-test helpers under src/tests/, which stay in the surface)
 *    - the build script itself
 *    - package.json + package-lock.json — lock changes swap bundle-inlined deps, and Claude's
 *      dist/claude-binary.json records the Agent SDK version resolved from node_modules
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path, { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const STAMP_FILE = resolve(repoRoot, 'node_modules/.cache/ensure-vendor-agent-build.json')
export const STAMP_VERSION = 1

export const VENDORS = [
  {
    name: 'claude-agent-acp',
    inputs: ['src', 'esbuild.config.mjs', 'package.json', 'package-lock.json'],
    output: 'dist/index.js',
  },
  {
    name: 'codex-acp',
    inputs: ['src', 'build.mjs', 'package.json', 'package-lock.json'],
    output: 'dist/index.js',
  },
]

const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__'])
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const entriesCache = new Map()

function collectEntries(abs, out, cache) {
  const cached = cache.get(abs)
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
    cache.set(abs, own)
    out.push(...own)
    return
  }
  if (st.isFile()) {
    own.push(`${abs}|${st.mtimeMs}|${st.size}`)
  } else {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) collectEntries(join(abs, e.name), own, cache)
      } else if (e.isFile() && !TEST_FILE_RE.test(e.name)) {
        const p = join(abs, e.name)
        const s = statSync(p)
        own.push(`${p}|${s.mtimeMs}|${s.size}`)
      }
    }
  }
  cache.set(abs, own)
  out.push(...own)
}

/** 缓存按调用传入：一次运行内多个 vendor 共享一份（去重重复 stat），调用之间互不影响。 */
export function fingerprint(inputs, cache = new Map()) {
  const out = []
  for (const abs of inputs) collectEntries(abs, out, cache)
  out.sort()
  return createHash('sha256').update(out.join('\n')).digest('hex')
}

/**
 * 待重建的 vendor 名。任一条件命中即重建：显式 force / stamp 无记录或指纹不符 / 产物缺失
 * （stamp 命中但 dist 被清过——构建先 rm -rf dist，中断会留下这种状态）。
 */
export function selectStaleVendors(
  vendors,
  stampedHashes,
  { force = false, exists = existsSync } = {},
) {
  return vendors
    .filter((v) => force || stampedHashes[v.name] !== v.hash || !exists(v.output))
    .map((v) => v.name)
}

function readStamp() {
  try {
    const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
    if (stamp.version === STAMP_VERSION) return stamp.vendors ?? {}
  } catch {
    // 首跑 / stamp 损坏 → 全量
  }
  return {}
}

function main() {
  const t0 = Date.now()
  const force = process.env.UNIVERSE_VENDOR_AGENT_BUILD_FORCE === '1'
  const vendors = VENDORS.map((v) => {
    const dir = resolve(repoRoot, 'vendor', v.name)
    return {
      ...v,
      dir,
      hash: fingerprint(
        v.inputs.map((rel) => resolve(dir, rel)),
        entriesCache,
      ),
      output: resolve(dir, v.output),
    }
  })

  const stampedHashes = readStamp()
  const byName = new Map(vendors.map((v) => [v.name, v]))
  const stale = selectStaleVendors(vendors, stampedHashes, { force }).map((name) =>
    byName.get(name),
  )

  if (stale.length === 0) {
    console.log(`[vendor-agent-build] up to date — skipping (${Date.now() - t0}ms)`)
    return
  }

  for (const vendor of stale) {
    if (!existsSync(resolve(vendor.dir, 'node_modules'))) {
      console.error(
        `[vendor-agent-build] ${vendor.name} is stale but has no node_modules — run \`pnpm agent:build\` (needs \`git submodule update --init\` first on a fresh clone)`,
      )
      process.exit(1)
    }
  }

  console.log(
    `[vendor-agent-build] rebuilding stale agent bundle(s): ${stale.map((v) => v.name).join(', ')}${force ? ' (forced)' : ''}…`,
  )
  for (const vendor of stale) {
    const t = Date.now()
    const build = spawnSync(npm, ['run', 'build'], {
      cwd: vendor.dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (build.status !== 0) {
      console.error(`[vendor-agent-build] build failed for ${vendor.name}`)
      process.exit(build.status ?? 1)
    }
    console.log(`[vendor-agent-build]   ${vendor.name}: ${Date.now() - t}ms`)
  }

  const currentHashes = Object.fromEntries(vendors.map((v) => [v.name, v.hash]))
  mkdirSync(dirname(STAMP_FILE), { recursive: true })
  writeFileSync(
    STAMP_FILE,
    JSON.stringify({ version: STAMP_VERSION, vendors: currentHashes }, null, 2) + '\n',
  )
  console.log(`[vendor-agent-build] done (${Date.now() - t0}ms)`)
}

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]).split(path.sep).join('/') ===
    fileURLToPath(import.meta.url)
      .split(path.sep)
      .join('/')
if (invokedDirectly) {
  main()
}
