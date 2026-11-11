#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Ensures the phone PWA bundle served by the mobile gateway is fresh before
 *  `pnpm dev` / `pnpm dev:run`.
 *
 *  Why this exists: `apps/mobile/dist` is a separate vite build. The PWA is not part of
 *  electron-vite, and `@universe-editor/mobile` is not an editor dependency, so nothing in
 *  the editor startup path guards it. The gateway runs from source (main aliases
 *  mobile-protocol to src/), so after a `MOBILE_PROTOCOL_VERSION` bump the gateway already
 *  speaks N+1 while the served bundle still speaks N: every hello closes with 4400 and the
 *  phone shows「手机端与 PC 版本不一致，请刷新页面」— refreshing cannot help because the
 *  served files themselves are stale.
 *
 *  Fast path: input fingerprint (mtime+size) matches the stamp and all artifacts exist →
 *  a few fs stats. Slow path: turbo build `@universe-editor/mobile...`, which builds the
 *  PWA plus its dist-resolved workspace deps (mobile-protocol / acp-view-model) in
 *  topological order (`build` dependsOn `^build` in turbo.json).
 *
 *  Bypass: `UNIVERSE_MOBILE_ASSETS_DIR` means the developer serves a custom directory, so
 *  there is nothing for us to build. `--force` / `UNIVERSE_MOBILE_ASSETS_FORCE=1` rebuilds
 *  regardless of the stamp.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const STAMP_FILE = resolve(repoRoot, 'node_modules/.cache/ensure-mobile-assets-build.json')
const STAMP_VERSION = 1

// Wider than the true build graph on purpose: a missed input means a stale bundle, which
// is worse than one extra rebuild. mobile-protocol / acp-view-model are consumed through
// their dist/ (package exports), so their sources belong here too.
const INPUTS = [
  'apps/mobile/src',
  'apps/mobile/index.html',
  'apps/mobile/public',
  'apps/mobile/vite.config.ts',
  'apps/mobile/package.json',
  'apps/mobile/tsconfig.json',
  'packages/mobile-protocol/src',
  'packages/mobile-protocol/package.json',
  'packages/acp-view-model/src',
  'packages/acp-view-model/package.json',
  'pnpm-lock.yaml',
]

const ARTIFACTS = [
  'apps/mobile/dist/index.html',
  'packages/mobile-protocol/dist/index.js',
  'packages/acp-view-model/dist/index.js',
]

const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__'])
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/

function collectEntries(abs, out) {
  let st
  try {
    st = statSync(abs)
  } catch {
    // 目录/文件出现与消失同样要反映进指纹
    out.push(`${abs}|missing`)
    return
  }
  if (st.isFile()) {
    out.push(`${abs}|${st.mtimeMs}|${st.size}`)
    return
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectEntries(resolve(abs, entry.name), out)
    } else if (entry.isFile() && !TEST_FILE_RE.test(entry.name)) {
      const file = resolve(abs, entry.name)
      const s = statSync(file)
      out.push(`${file}|${s.mtimeMs}|${s.size}`)
    }
  }
}

function fingerprint() {
  const out = []
  for (const rel of INPUTS) collectEntries(resolve(repoRoot, rel), out)
  out.sort()
  return createHash('sha256').update(out.join('\n')).digest('hex')
}

const assetsOverride = process.env['UNIVERSE_MOBILE_ASSETS_DIR']?.trim()
if (assetsOverride !== undefined && assetsOverride !== '') {
  console.log(
    '[ensure-mobile-assets] UNIVERSE_MOBILE_ASSETS_DIR is set — skipping PWA build check',
  )
  process.exit(0)
}

const force =
  process.argv.includes('--force') || process.env['UNIVERSE_MOBILE_ASSETS_FORCE'] === '1'
const artifactsPresent = ARTIFACTS.every((rel) => existsSync(resolve(repoRoot, rel)))

let stampHash
try {
  const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
  if (stamp.version === STAMP_VERSION) stampHash = stamp.hash
} catch {
  // 首跑 / stamp 损坏 → 全量
}

const currentHash = fingerprint()
if (!force && artifactsPresent && stampHash === currentHash) {
  console.log('[ensure-mobile-assets] PWA bundle up to date — skipping build')
  process.exit(0)
}

console.log('[ensure-mobile-assets] rebuilding stale PWA bundle (@universe-editor/mobile...)…')
const t0 = Date.now()

// turbo/bin/turbo is a plain node script that re-spawns the platform-native binary.
// Invoke it via process.execPath with array args (no shell) so the filter's `...` is not
// touched by cmd.exe escaping on Windows.
const turboBin = resolve(repoRoot, 'node_modules/turbo/bin/turbo')
const res = spawnSync(
  process.execPath,
  [turboBin, 'run', 'build', '--filter=@universe-editor/mobile...'],
  { cwd: repoRoot, stdio: 'inherit' },
)

if (res.error) {
  console.error(`[ensure-mobile-assets] failed to run turbo: ${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error('[ensure-mobile-assets] PWA build failed')
  process.exit(res.status ?? 1)
}

mkdirSync(dirname(STAMP_FILE), { recursive: true })
writeFileSync(
  STAMP_FILE,
  JSON.stringify({ version: STAMP_VERSION, hash: currentHash }, null, 2) + '\n',
)
console.log(`[ensure-mobile-assets] PWA bundle rebuilt in ${Date.now() - t0}ms`)
