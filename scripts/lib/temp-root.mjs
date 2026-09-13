/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  temp-root.mjs — scripts/ 侧的临时根实现。
 *
 *  这里是 packages/temp-root 的等价副本：根目录脚本（pnpm check 里的一串 check-*.mjs）
 *  跑在裸 node 下，没有构建步骤，拿不到 TS 包的 dist/。两份的 TEMP_PREFIXES /
 *  TEMP_LIVE_DIR_NAMES 与默认根算法必须一致，由 scripts/__tests__/temp-root-drift.test.mjs
 *  守护 —— 改这里就要同步改 packages/temp-root/src/index.ts，反之亦然。
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'
const WINDOWS_ROOT_DIR_NAME = 'UniverseTmp'
const OVERRIDE_ENV = 'UNIVERSE_TMP_ROOT'
const RUN_ROOT_ENV = 'UNIVERSE_TMP_RUN_ROOT'
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const SIZE_BUDGET_FILES = 100_000

/** 与 packages/temp-root/src/index.ts 的 TEMP_PREFIXES 保持一致。 */
export const TEMP_PREFIXES = [
  // e2e：harness fixture、core specs、扩展 specs、以及 create-extension 模板
  'universe-',
  'ue2-',
  'ues-',
  // 编辑器 / 各包 / scripts 的 vitest 与 node:test
  'ue-',
  // AI 服务测试
  'ai-settings-test-',
  'ai-debug-test-',
  'ai-debug-svc-test-',
  'ai-debug-session-',
  'ai-remote-cache-',
  'ai-remote-coord-',
  // vendor fork 的测试（前缀只用于清理；fork 源码不在 workspace 内，不随本仓库改动）
  'acp-cfg-',
  'acp-nomodel-',
  'acp-agent-settings-',
  'acp-contract-',
  'codex-acp-',
  'codex-bad-',
  'claude-acp-',
  'claude-config-',
  'claude-project-',
  'claude-root-',
  'codex-config-',
  'settings-test-',
  'explore-result-',
  // playwright-core 内部为每次 electron.launch 建的产物目录（e2e 期间落我们的 run 根下）
  'playwright-artifacts-',
  // 仓库自检脚本的测试
  'sensitive-strings-',
  'claude-md-size-',
  'fresh-mtimes-',
  'builtin-engines-',
  'ext-release-',
  'sdk-gen-',
  'uex-',
  'cue-scaffold-',
  'diagnostics-',
  'error-sink-test-',
  'ext-engine-',
  'ext-gallery-',
  'ext-icon-',
  'ext-manifest-test-',
  'ext-mgmt-',
  'git-submodule-sync-',
  'p4-direct-',
  'p4-dirEvt-',
  'p4-ledger-',
  'p4-readback-dialog-',
  'p4-readback-none-',
  'p4-readback-wide-',
  'p4cache-',
  'tracker-test-',
  'ued-',
  'vsix-',
]

/** 与 packages/temp-root/src/index.ts 的 TEMP_LIVE_DIR_NAMES 保持一致。 */
export const TEMP_LIVE_DIR_NAMES = ['universe-editor', 'universe-editor-file-listings']

let cachedRoot

function norm(p) {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function samePath(a, b) {
  return norm(a) === norm(b)
}

function isInside(base, candidate) {
  const b = norm(base)
  const c = norm(candidate)
  return c.startsWith(b.endsWith(sep) ? b : b + sep)
}

function findWorkspaceRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir
    const parent = parse(dir).dir
    if (parent === dir) return undefined
    dir = parent
  }
}

function defaultTempRoot() {
  if (process.platform !== 'win32') return tmpdir()
  const workspace = findWorkspaceRoot(process.cwd())
  // 找不到 workspace 标记 = 仓外进程（打包版编辑器等），cwd 可能是 System32 之类：按它的卷根
  // 建目录等于往系统盘根写。「同卷」只在仓库场景才有意义，仓外一律退回 os.tmpdir()。
  if (!workspace) return tmpdir()
  return join(parse(resolve(workspace)).root, WINDOWS_ROOT_DIR_NAME)
}

export function resolveTempRoot() {
  const override = process.env[OVERRIDE_ENV]?.trim()
  if (override) return override
  return defaultTempRoot()
}

export function getTempRoot() {
  if (cachedRoot !== undefined) return cachedRoot
  const override = process.env[OVERRIDE_ENV]?.trim()
  const candidate = override ?? defaultTempRoot()
  try {
    mkdirSync(candidate, { recursive: true })
    cachedRoot = candidate
  } catch (err) {
    if (override) {
      throw new Error(`[temp-root] ${OVERRIDE_ENV}=${candidate} 不可用: ${String(err)}`)
    }
    console.warn(`[temp-root] ${candidate} 不可用 (${String(err)}), 回退 ${tmpdir()}`)
    cachedRoot = tmpdir()
  }
  return cachedRoot
}

export function effectiveTempRoot() {
  // runner 显式交接的 run 根：无条件采信。反推 TEMP 对 cwd 落在别的卷上的子进程会失效。
  const runRoot = process.env[RUN_ROOT_ENV]?.trim()
  if (runRoot && existsSync(runRoot)) return runRoot
  const base = getTempRoot()
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[key]
    if (value && value.trim() !== '' && isInside(base, value)) return value
  }
  return base
}

export function mkTempDir(prefix) {
  return mkdtempSync(join(effectiveTempRoot(), prefix))
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function removeDirWithRetry(dir, attempts = 10, delayMs = 100) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch (err) {
      if (attempt >= attempts) {
        console.warn(`[temp-root] 删除失败 ${dir}: ${String(err)}`)
        return false
      }
      sleepSync(delayMs)
    }
  }
}

/**
 * 目录体积。**不跟随 symlink**——跟随会把 junction 指向的外部目录（例如扩展自己的
 * node_modules）算进来，曾把 18 个空壳目录误报成「4,484 文件 / 105 MB」。
 */
function dirSize(target, budget = SIZE_BUDGET_FILES) {
  let bytes = 0
  let files = 0
  let truncated = false
  const stack = [target]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (files >= budget) {
        truncated = true
        break
      }
      try {
        bytes += statSync(full).size
        files++
      } catch {
        // 与并发删除竞态，忽略
      }
    }
    if (truncated) break
  }
  return { bytes, files, truncated }
}

function defaultSweepRoots() {
  const roots = []
  for (const root of [getTempRoot(), tmpdir()]) {
    if (!roots.some((r) => samePath(r, root))) roots.push(root)
  }
  return roots
}

/**
 * 按前缀 + TTL 收敛残留。
 *
 * 只碰**一级条目**（目录与散文件），且必须同时满足：名字命中 TEMP_PREFIXES、mtime 早于 cutoff、
 * 路径确实落在扫描根内部。绝不递归清空任何临时目录。`liveRoot` 指定的那个根下跳过
 * TEMP_LIVE_DIR_NAMES（运行中的进程正在用的缓存目录）。
 *
 * 散文件也要收：剪贴板后端的中转 ps1/json/.out.txt、p4 的 argfile 都直接写在临时根一级，
 * 它们的清理由调用点的 best-effort finally 负责，进程被强杀就永久留在那里。
 */
export function sweepStaleTempDirs(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const dryRun = options.dryRun ?? false
  const now = options.now ?? Date.now()
  const liveRoot = options.liveRoot ? resolve(options.liveRoot) : undefined
  const roots = options.roots ?? defaultSweepRoots()
  const cutoff = now - maxAgeMs

  const result = { scanned: 0, candidates: [], removed: [], failed: [], bytes: 0, truncated: false }

  for (const root of roots) {
    const rootPath = resolve(root)
    if (!existsSync(rootPath)) continue
    const skipLive = liveRoot !== undefined && samePath(rootPath, liveRoot)
    let entries
    try {
      entries = readdirSync(rootPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      result.scanned++
      // 不跟随 symlink / junction：删链接本身没意义，下降进去更会删到外部目录
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory() && !entry.isFile()) continue
      if (skipLive && TEMP_LIVE_DIR_NAMES.includes(entry.name)) continue
      if (!TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
      const full = join(rootPath, entry.name)
      // 双保险：扫描根的直接子项本就在内部，这里防的是未来改成递归时的越界
      if (!isInside(rootPath, full)) continue
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.mtimeMs > cutoff) continue
      const size = entry.isDirectory() ? dirSize(full) : { bytes: stat.size, truncated: false }
      result.bytes += size.bytes
      result.truncated ||= size.truncated
      result.candidates.push({ path: full, bytes: size.bytes })
      if (dryRun) continue
      if (removeDirWithRetry(full)) result.removed.push(full)
      else result.failed.push(full)
    }
  }
  return result
}
