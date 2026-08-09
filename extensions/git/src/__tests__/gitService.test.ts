import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { gitExec } from '../gitService.js'

describe('gitExec stdin handling', () => {
  it('resolves without an unhandled error when git exits before consuming stdin', async () => {
    // `git --no-such-flag` 立即退出且不读 stdin；输入超过 pipe 缓冲区，
    // 写入必然在进程退出后才完成 → 无 error 处理时 EPIPE/EOF 变成 uncaughtException
    const res = await gitExec(['--no-such-flag'], tmpdir(), undefined, {
      input: 'x'.repeat(10 * 1024 * 1024),
    })
    expect(res.exitCode).not.toBe(0)
    // 给挂起的 stdin 写入回调留出触发窗口；若未处理，vitest 会以 unhandled error 使本次运行失败
    await new Promise((r) => setTimeout(r, 200))
  })
})
