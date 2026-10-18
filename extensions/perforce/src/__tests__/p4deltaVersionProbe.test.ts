/**
 * `probeP4deltaVersion` —— 「显示 p4delta 信息」命令背后那一次 `--version` 采样。
 *
 * 真起进程（临时 `.mjs` 脚本），因为要钉的正是这件事的形状：脚本形态经当前 Node 运行、
 * stdout 与 stderr 都收、无输出 / 卡死 / 文件不存在一律答 undefined（采样是诊断，绝不能让
 * 一条命令把编辑器挂住或抛出）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearP4deltaBuildProbeCache,
  probeP4deltaBuild,
  probeP4deltaVersion,
} from '../p4delta/p4deltaService.js'
import { parseP4deltaVersionBanner } from '../p4delta/p4deltaVersion.js'

describe('parseP4deltaVersionBanner', () => {
  it('reads the semver out of the clap banner', () => {
    expect(parseP4deltaVersionBanner('p4delta 0.1.6\n')).toBe('0.1.6')
  })

  it('answers nothing when the text carries no version', () => {
    expect(parseP4deltaVersionBanner('p4delta\n')).toBeUndefined()
    expect(parseP4deltaVersionBanner('')).toBeUndefined()
  })
})

describe('probeP4deltaVersion', () => {
  let dir: string

  beforeEach(() => {
    dir = mkTempDir('ue-p4delta-probe-')
    clearP4deltaBuildProbeCache()
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  const writeScript = (name: string, source: string): string => {
    const file = join(dir, name)
    writeFileSync(file, source, 'utf8')
    return file
  }

  it('spawns the engine and reads the version it prints', async () => {
    const exe = writeScript('probe.mjs', "console.log('p4delta 9.9.9')\n")
    await expect(probeP4deltaVersion(exe)).resolves.toBe('9.9.9')
  })

  it('reads stderr too — a build may banner there', async () => {
    const exe = writeScript('probe-stderr.mjs', "console.error('p4delta 1.2.3')\n")
    await expect(probeP4deltaVersion(exe)).resolves.toBe('1.2.3')
  })

  it('answers nothing for a child that exits without a version', async () => {
    const exe = writeScript('probe-silent.mjs', 'process.exit(3)\n')
    await expect(probeP4deltaVersion(exe)).resolves.toBeUndefined()
  })

  it('gives up on a child that never answers', async () => {
    const exe = writeScript('probe-hang.mjs', 'setInterval(() => {}, 1000)\n')
    const started = Date.now()
    await expect(probeP4deltaVersion(exe, 250)).resolves.toBeUndefined()
    // 只为钉「超时真的解开了 promise」——精确耗时留给慢机器，不在这里断言。
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('answers nothing when the file is not there', async () => {
    await expect(probeP4deltaVersion(join(dir, 'missing.mjs'))).resolves.toBeUndefined()
  })
})

describe('probeP4deltaBuild', () => {
  let dir: string

  beforeEach(() => {
    dir = mkTempDir('ue-p4delta-build-')
    clearP4deltaBuildProbeCache()
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  const writeScript = (name: string, source: string): string => {
    const file = join(dir, name)
    writeFileSync(file, source, 'utf8')
    return file
  }

  const spawnCount = (name = 'spawns.log'): number => {
    const file = join(dir, name)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '').length
  }

  /** A script that records each spawn before answering, so the cache is observable. */
  const countingScript = (version: string): string =>
    `import { appendFileSync } from 'node:fs'\n` +
    `appendFileSync(new URL('./spawns.log', import.meta.url), 'x\\n')\n` +
    `console.log('p4delta ${version}')\n`

  it('reads a strict p4delta banner from stdout or stderr', async () => {
    const stdout = writeScript('build.mjs', countingScript('0.1.19'))
    await expect(probeP4deltaBuild(stdout)).resolves.toEqual([0, 1, 19])

    const stderr = writeScript('build-stderr.mjs', "console.error('p4delta 1.2.3')\n")
    await expect(probeP4deltaBuild(stderr)).resolves.toEqual([1, 2, 3])
  })

  it('is fail-closed when the output is not a p4delta banner', async () => {
    const exe = writeScript('other-tool.mjs', "console.log('mytool 9.9.9')\n")
    await expect(probeP4deltaBuild(exe)).resolves.toBeUndefined()
  })

  it('is fail-closed when the child gives no answer or hangs', async () => {
    const silent = writeScript('silent.mjs', 'process.exit(3)\n')
    await expect(probeP4deltaBuild(silent)).resolves.toBeUndefined()

    const hang = writeScript('hang.mjs', 'setInterval(() => {}, 1000)\n')
    await expect(probeP4deltaBuild(hang, 250)).resolves.toBeUndefined()
  })

  it('answers nothing when the file is not there', async () => {
    await expect(probeP4deltaBuild(join(dir, 'missing.mjs'))).resolves.toBeUndefined()
  })

  it('probes one binary once per fingerprint, failures included', async () => {
    const good = writeScript('good.mjs', countingScript('0.1.19'))
    await expect(probeP4deltaBuild(good)).resolves.toEqual([0, 1, 19])
    await expect(probeP4deltaBuild(good)).resolves.toEqual([0, 1, 19])
    expect(spawnCount()).toBe(1)

    clearP4deltaBuildProbeCache()
    const silentLog = join(dir, 'spawns-silent.log')
    const silent = writeScript(
      'silent.mjs',
      `import { appendFileSync } from 'node:fs'\n` +
        `appendFileSync(new URL('./spawns-silent.log', import.meta.url), 'x\\n')\n` +
        'process.exit(3)\n',
    )
    await expect(probeP4deltaBuild(silent)).resolves.toBeUndefined()
    await expect(probeP4deltaBuild(silent)).resolves.toBeUndefined()
    expect(
      readFileSync(silentLog, 'utf8')
        .split('\n')
        .filter((line) => line !== '').length,
    ).toBe(1)
  })

  it('shares one spawn between concurrent callers', async () => {
    const exe = writeScript('concurrent.mjs', countingScript('0.1.19'))

    const [first, second] = await Promise.all([probeP4deltaBuild(exe), probeP4deltaBuild(exe)])

    expect(first).toEqual([0, 1, 19])
    expect(second).toEqual([0, 1, 19])
    expect(spawnCount()).toBe(1)
  })

  it('re-probes when the binary at the same path is replaced', async () => {
    const exe = writeScript('replaced.mjs', countingScript('0.1.18'))
    await expect(probeP4deltaBuild(exe)).resolves.toEqual([0, 1, 18])

    // Different length (hence a different size fingerprint) with a different answer.
    writeFileSync(exe, countingScript('0.1.19') + '// replaced\n', 'utf8')
    await expect(probeP4deltaBuild(exe)).resolves.toEqual([0, 1, 19])
    expect(spawnCount()).toBe(2)
  })

  it('re-probes after the test cache is cleared', async () => {
    const exe = writeScript('clear.mjs', countingScript('0.1.19'))
    await expect(probeP4deltaBuild(exe)).resolves.toEqual([0, 1, 19])
    clearP4deltaBuildProbeCache()
    await expect(probeP4deltaBuild(exe)).resolves.toEqual([0, 1, 19])
    expect(spawnCount()).toBe(2)
  })
})
