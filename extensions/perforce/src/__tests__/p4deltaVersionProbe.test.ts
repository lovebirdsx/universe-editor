/**
 * `probeP4deltaVersion` —— 「显示 p4delta 信息」命令背后那一次 `--version` 采样。
 *
 * 真起进程（临时 `.mjs` 脚本），因为要钉的正是这件事的形状：脚本形态经当前 Node 运行、
 * stdout 与 stderr 都收、无输出 / 卡死 / 文件不存在一律答 undefined（采样是诊断，绝不能让
 * 一条命令把编辑器挂住或抛出）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeP4deltaVersion } from '../p4delta/p4deltaService.js'
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
