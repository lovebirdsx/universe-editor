/*---------------------------------------------------------------------------------------------
 *  临时目录的单一真相源。
 *
 *  默认根刻意不落用户 profile（%TEMP% / %LOCALAPPDATA% / ~ 都在 profile 内）：Windows 登录时
 *  User Profile Service 要遍历 profile 下的临时项，测试套件堆出的几十万条目会把登录拖到分钟级。
 *  win32 上取「仓库所在盘」的 <volume>/UniverseTmp，与仓库同卷——临时文件写完再 rename 进
 *  仓库时不会跨卷触发 EXDEV。非 win32 保持 os.tmpdir()。
 *
 *  scripts/lib/temp-root.mjs 是 scripts/（根目录裸 node 脚本，无构建步骤）侧的等价实现；
 *  两份的 TEMP_PREFIXES 必须一致，由 scripts/__tests__/temp-root-drift.test.mjs 守护。
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'
const WINDOWS_ROOT_DIR_NAME = 'UniverseTmp'
const OVERRIDE_ENV = 'UNIVERSE_TMP_ROOT'
const RUN_ROOT_ENV = 'UNIVERSE_TMP_RUN_ROOT'

/**
 * `pnpm tmp:clean` 的允许清单：只有名字命中这些前缀的一级子目录才可能被删除。
 * 新增任何往临时根写目录的调用点，都要把前缀登记到这里（`scripts/check-temp-root.mjs`
 * 会拒绝裸调 os.tmpdir()，但拦不住一个没登记的新前缀——它只会让残留无法被清理）。
 */
export const TEMP_PREFIXES: readonly string[] = [
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

/**
 * 虽命中前缀、但**正在被生产代码使用**的目录名：清理时跳过。
 * `universe-editor-file-listings` 从 %TEMP% 迁到临时根后由 FileSearchService 自己按 7 天 TTL
 * 回收 `.list` 文件；整目录被 CLI 删掉会和运行中的编辑器抢文件句柄。
 * `universe-editor` 是剪贴板暂存树：一次性建好后只在它下面增删 session 子目录，自身 mtime
 * 创建即冻结——按 mtime 判 TTL 会把它判成「陈旧」，删掉正在被系统剪贴板引用着的 materialize 文件。
 * （它们在旧位置 %TEMP% 下的残留不受此规则保护——那里已不再是活动缓存。）
 */
export const TEMP_LIVE_DIR_NAMES: readonly string[] = [
  'universe-editor',
  'universe-editor-file-listings',
]

let cachedRoot: string | undefined

function findWorkspaceRoot(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir
    const parent = parse(dir).dir
    if (parent === dir) return undefined
    dir = parent
  }
}

function defaultTempRoot(): string {
  if (process.platform !== 'win32') return tmpdir()
  const workspace = findWorkspaceRoot(process.cwd())
  // 找不到 workspace 标记 = 打包版编辑器或仓外进程，cwd 可能是 System32 之类：按它的卷根建目录
  // 等于往系统盘根写。「同卷」只在仓库场景才有意义（临时文件 rename 进仓库不跨卷 EXDEV），
  // 仓外一律退回 os.tmpdir()——那里本来就是临时文件该待的地方。
  if (!workspace) return tmpdir()
  return join(parse(resolve(workspace)).root, WINDOWS_ROOT_DIR_NAME)
}

/**
 * 解析临时根（不创建目录、不考虑回退）。默认根不可用时 {@link getTempRoot} 会退回 os.tmpdir()，
 * 但显式配置的 `UNIVERSE_TMP_ROOT` 不可用会直接抛错——静默退回 profile 正是本模块要根治的问题。
 */
export function resolveTempRoot(): string {
  const override = process.env[OVERRIDE_ENV]?.trim()
  if (override) return override
  return defaultTempRoot()
}

export function getTempRoot(): string {
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

function isInside(base: string, candidate: string): boolean {
  const b = resolve(base)
  const c = resolve(candidate)
  const fold = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
  const prefix = fold(b.endsWith(sep) ? b : b + sep)
  return fold(c).startsWith(prefix)
}

/**
 * 当前生效的临时根。runner（e2e globalSetup / vitest globalSetup）会把 TEMP/TMP/TMPDIR 指向
 * 一次运行专属的 run 根；worker 进程里模块状态是空的，只能从环境变量反推——且只认落在我们自己
 * 临时根**内部**的 TEMP，用户原本的 %TEMP% 一律无视。
 *
 * 反推对「cwd 落在别的卷」的子进程会失效（它算出的 base 与 run 根不同卷，于是把继承来的 TEMP
 * 判成不是我们的，静默写回 profile）。所以 runner 额外交接一个 RUN_ROOT_ENV，它被无条件采信。
 */
export function effectiveTempRoot(): string {
  const runRoot = process.env[RUN_ROOT_ENV]?.trim()
  // 目录已被 run 收尾删掉（例如 run 结束后仍在跑的游离进程）时不能再用它，否则 mkdtemp 直接 ENOENT。
  if (runRoot && existsSync(runRoot)) return runRoot
  const base = getTempRoot()
  for (const key of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    const value = process.env[key]
    if (value && value.trim() !== '' && isInside(base, value)) return value
  }
  return base
}

const registered = new Set<string>()

/** 在生效的临时根下建目录，并登记以便 {@link flushTempDirs} 收尾。 */
export function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(effectiveTempRoot(), prefix))
  registered.add(dir)
  return dir
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 带退避的递归删除。不用 `rmSync` 自带的 maxRetries：它的 readdir 已经过了才冒出来的新文件会让
 * 父目录 rmdir 撞 ENOTEMPTY，而它自己的重试不会重读目录（详见 e2e harness 的 wipeWorkspacesDir）。
 * 同步实现，好在 process exit 钩子里也能用。
 */
export function removeDirWithRetry(dir: string, attempts = 10, delayMs = 100): boolean {
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

/** 删除本进程经 {@link mkTempDir} 建的所有目录。清理是卫生问题，失败只告警不抛。 */
export function flushTempDirs(): void {
  for (const dir of [...registered]) {
    if (removeDirWithRetry(dir)) registered.delete(dir)
  }
}

/** 建一次运行专属的临时根，供 runner 层把它设为 TEMP/TMP/TMPDIR。 */
export function createRunRoot(label = 'ue-run'): string {
  const root = join(getTempRoot(), `${label}-${process.pid}-${Date.now().toString(36)}`)
  mkdirSync(root, { recursive: true })
  return root
}

export function installRunTempEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
  env['TEMP'] = root
  env['TMP'] = root
  env['TMPDIR'] = root
  env[RUN_ROOT_ENV] = root
}

/** 删掉一次运行专属的临时根。Windows 上刚退出的子进程（git / p4 / Electron）常还攥着句柄，
 *  比单目录清理多给几轮退避——这是整趟运行唯一的收尾机会，删不掉就要等 24h 的 TTL 兜底。 */
export function removeRunRoot(root: string): void {
  removeDirWithRetry(root, 30, 250)
  for (const dir of [...registered]) {
    if (isInside(root, dir)) registered.delete(dir)
  }
}
