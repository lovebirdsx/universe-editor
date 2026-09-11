import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OVERRIDE_ENV = 'UNIVERSE_TMP_ROOT'
const RUN_ROOT_ENV = 'UNIVERSE_TMP_RUN_ROOT'
const ENV_KEYS = ['TEMP', 'TMP', 'TMPDIR', OVERRIDE_ENV, RUN_ROOT_ENV] as const

type TempRootModule = typeof import('../index.js')

// 临时根在模块内缓存，跨用例复用会掩盖解析逻辑——每个用例都取一份全新模块实例。
async function load(): Promise<TempRootModule> {
  return import('../index.js')
}

const scratchRoots: string[] = []
const envSnapshot = new Map<string, string | undefined>()

// 本文件要造「不是我们默认根」的临时根，只能用 os.tmpdir()；前缀进了允许清单，可被清理命令回收。
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ue-temp-root-test-'))
  scratchRoots.push(dir)
  return dir
}

beforeEach(() => {
  vi.resetModules()
  for (const key of ENV_KEYS) envSnapshot.set(key, process.env[key])
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  envSnapshot.clear()
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TEMP_PREFIXES / TEMP_LIVE_DIR_NAMES', () => {
  it('前缀都是带尾随分隔符的字面前缀且无重复', async () => {
    const { TEMP_PREFIXES, TEMP_LIVE_DIR_NAMES } = await load()
    expect(new Set(TEMP_PREFIXES).size).toBe(TEMP_PREFIXES.length)
    for (const prefix of TEMP_PREFIXES) expect(prefix.endsWith('-')).toBe(true)
    expect(new Set(TEMP_LIVE_DIR_NAMES).size).toBe(TEMP_LIVE_DIR_NAMES.length)
  })

  it('活动目录名确实落在前缀覆盖范围内（否则 skip 规则是死代码）', async () => {
    const { TEMP_PREFIXES, TEMP_LIVE_DIR_NAMES } = await load()
    for (const name of TEMP_LIVE_DIR_NAMES) {
      expect(TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))).toBe(true)
    }
  })
})

describe('getTempRoot', () => {
  it('显式 UNIVERSE_TMP_ROOT 优先，目录被创建且结果被缓存', async () => {
    const target = join(scratchDir(), 'explicit')
    vi.stubEnv(OVERRIDE_ENV, target)
    const { getTempRoot } = await load()
    expect(getTempRoot()).toBe(target)
    expect(existsSync(target)).toBe(true)
    expect(getTempRoot()).toBe(target)
  })

  it('显式配置不可用时抛错，绝不静默退回 profile', async () => {
    const blocker = join(scratchDir(), 'blocker')
    writeFileSync(blocker, 'not a directory')
    vi.stubEnv(OVERRIDE_ENV, join(blocker, 'child'))
    const { getTempRoot } = await load()
    expect(() => getTempRoot()).toThrow(/UNIVERSE_TMP_ROOT/)
  })

  it('未配置时：win32 与仓库同盘，非 win32 用 os.tmpdir()', async () => {
    vi.stubEnv(OVERRIDE_ENV, '')
    const { resolveTempRoot } = await load()
    const root = resolveTempRoot()
    if (process.platform === 'win32') {
      expect(root.endsWith(`UniverseTmp`)).toBe(true)
      expect(parse(root).root).toBe(parse(process.cwd()).root)
    } else {
      expect(root).toBe(tmpdir())
    }
  })
})

describe('effectiveTempRoot', () => {
  it('跟随落在临时根内部的 TEMP', async () => {
    const scratch = scratchDir()
    vi.stubEnv(OVERRIDE_ENV, scratch)
    const mod = await load()
    const runRoot = mod.createRunRoot('ue-run-test')
    mod.installRunTempEnv(runRoot)
    expect(mod.effectiveTempRoot()).toBe(runRoot)
    expect(mod.mkTempDir('ue-probe-').startsWith(runRoot)).toBe(true)
  })

  it('无视用户原本的 %TEMP%（它在临时根之外）', async () => {
    const scratch = scratchDir()
    vi.stubEnv(OVERRIDE_ENV, scratch)
    for (const key of ['TEMP', 'TMP', 'TMPDIR'] as const) vi.stubEnv(key, tmpdir())
    const { effectiveTempRoot } = await load()
    expect(effectiveTempRoot()).toBe(scratch)
  })

  // cwd 落在别的卷上的子进程算出的 base 与 run 根不同卷，靠反推 TEMP 会逃回 profile——
  // 所以 runner 交接的 run 根必须无条件采信，不再做 inside 判定。
  it('runner 交接的 run 根无条件生效，即使基准根在别的卷', async () => {
    vi.stubEnv(OVERRIDE_ENV, scratchDir())
    const runRoot = scratchDir()
    vi.stubEnv(RUN_ROOT_ENV, runRoot)
    for (const key of ['TEMP', 'TMP', 'TMPDIR'] as const) vi.stubEnv(key, tmpdir())
    const mod = await load()
    expect(mod.effectiveTempRoot()).toBe(runRoot)
    expect(mod.mkTempDir('ue-probe-').startsWith(runRoot)).toBe(true)
  })

  it('run 根已被收尾删掉时退回基准根，而不是 mkdtemp 撞 ENOENT', async () => {
    const scratch = scratchDir()
    vi.stubEnv(OVERRIDE_ENV, scratch)
    const gone = join(scratch, 'ue-run-gone')
    vi.stubEnv(RUN_ROOT_ENV, gone)
    const { effectiveTempRoot } = await load()
    expect(effectiveTempRoot()).toBe(scratch)
  })
})

describe('mkTempDir / flushTempDirs', () => {
  it('每个调用点拿到互不重复的目录，flush 后全部消失', async () => {
    vi.stubEnv(OVERRIDE_ENV, scratchDir())
    const mod = await load()
    const dirs = Array.from({ length: 20 }, () => mod.mkTempDir('ue-probe-'))
    expect(new Set(dirs).size).toBe(20)
    for (const dir of dirs) expect(existsSync(dir)).toBe(true)
    mod.flushTempDirs()
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  })
})

describe('removeDirWithRetry', () => {
  it('删掉非空目录并返回 true', async () => {
    const { removeDirWithRetry } = await load()
    const dir = join(scratchDir(), 'nested', 'deeper')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'f.txt'), 'x')
    expect(removeDirWithRetry(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('目标不存在也返回 true（force 语义）', async () => {
    const { removeDirWithRetry } = await load()
    expect(removeDirWithRetry(join(scratchDir(), 'missing'))).toBe(true)
  })
})

describe('createRunRoot / removeRunRoot', () => {
  it('run 根建在临时根下，可整根回收并清掉登记项', async () => {
    const scratch = scratchDir()
    vi.stubEnv(OVERRIDE_ENV, scratch)
    const mod = await load()
    const runRoot = mod.createRunRoot('ue-run-test')
    expect(runRoot.startsWith(scratch)).toBe(true)
    mod.installRunTempEnv(runRoot)
    const inside = mod.mkTempDir('ue-probe-')
    expect(inside.startsWith(runRoot)).toBe(true)
    mod.removeRunRoot(runRoot)
    expect(existsSync(runRoot)).toBe(false)
    // 登记项已随 run 根一起出清：再 flush 一次不会去删已经不存在的路径
    expect(() => mod.flushTempDirs()).not.toThrow()
  })
})
