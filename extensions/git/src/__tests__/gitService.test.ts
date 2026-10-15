import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { gitExec, isLinkedWorktreeDirs } from '../gitService.js'
import { getTempRoot } from '@universe-editor/temp-root'

describe('gitExec stdin handling', () => {
  it('resolves without an unhandled error when git exits before consuming stdin', async () => {
    // `git --no-such-flag` 立即退出且不读 stdin；输入超过 pipe 缓冲区，
    // 写入必然在进程退出后才完成 → 无 error 处理时 EPIPE/EOF 变成 uncaughtException
    const res = await gitExec(['--no-such-flag'], getTempRoot(), undefined, {
      input: 'x'.repeat(10 * 1024 * 1024),
    })
    expect(res.exitCode).not.toBe(0)
    // 给挂起的 stdin 写入回调留出触发窗口；若未处理，vitest 会以 unhandled error 使本次运行失败
    await new Promise((r) => setTimeout(r, 200))
  })
})

describe('isLinkedWorktreeDirs', () => {
  const main = join(getTempRoot(), 'main')
  const worktree = join(getTempRoot(), 'main.worktrees', 'task1')

  it('detects a linked worktree from differing git dir / common dir lines', () => {
    expect(
      isLinkedWorktreeDirs(join(main, '.git', 'worktrees', 'task1'), join(main, '.git'), worktree),
    ).toBe(true)
  })

  it('treats the main checkout root as not a worktree', () => {
    expect(isLinkedWorktreeDirs('.git', '.git', main)).toBe(false)
  })

  it('resolves relative and absolute spellings of the same git dir', () => {
    expect(
      // 实测：主 checkout 子目录下 git 打印 `/abs/main/.git` 与 `../../../.git`
      isLinkedWorktreeDirs(
        join(main, '.git'),
        join('..', '..', '..', '.git'),
        join(main, 'extensions', 'git', 'src'),
      ),
    ).toBe(false)
  })

  it('treats a submodule as not a worktree (its git dir is also its common dir)', () => {
    const subGitDir = join(main, '.git', 'modules', 'vendor', 'claude-agent-acp')
    expect(
      isLinkedWorktreeDirs(subGitDir, subGitDir, join(main, 'vendor', 'claude-agent-acp')),
    ).toBe(false)
  })

  it('reports false for missing output', () => {
    expect(isLinkedWorktreeDirs('', '', main)).toBe(false)
    expect(isLinkedWorktreeDirs(join(main, '.git'), '', main)).toBe(false)
  })
})
