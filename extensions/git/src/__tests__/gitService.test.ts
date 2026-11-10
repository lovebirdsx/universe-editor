import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectGitDirs, gitExec, isLinkedWorktreeDirs, parseGitDirs } from '../gitService.js'
import { samePath } from '../pathUtil.js'
import { getTempRoot, mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

async function git(args: string[], cwd: string): Promise<string> {
  const res = await gitExec(args, cwd)
  if (res.exitCode !== 0) throw new Error(res.stderr)
  return res.stdout
}

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

describe('parseGitDirs', () => {
  const main = join(getTempRoot(), 'repo')

  it('resolves both lines against cwd and marks the main checkout', () => {
    expect(parseGitDirs('.git', '.git', main)).toEqual({
      gitDir: join(main, '.git'),
      commonDir: join(main, '.git'),
      isLinkedWorktree: false,
    })
    expect(parseGitDirs(join(main, '.git'), join('..', '.git'), join(main, 'src'))).toEqual({
      gitDir: join(main, '.git'),
      commonDir: join(main, '.git'),
      isLinkedWorktree: false,
    })
  })

  it('falls back to gitDir when the common dir line is missing', () => {
    expect(parseGitDirs('.git', '', main)).toEqual({
      gitDir: join(main, '.git'),
      commonDir: join(main, '.git'),
      isLinkedWorktree: false,
    })
  })

  it('marks a linked worktree when the two dirs differ', () => {
    expect(
      parseGitDirs(
        join(main, '.git', 'worktrees', 'task1'),
        join(main, '.git'),
        join(main, '.worktrees', 'task1'),
      ),
    ).toEqual({
      gitDir: join(main, '.git', 'worktrees', 'task1'),
      commonDir: join(main, '.git'),
      isLinkedWorktree: true,
    })
  })

  it('returns undefined when git printed no git dir', () => {
    expect(parseGitDirs('', '', main)).toBeUndefined()
  })
})

describe('detectGitDirs', () => {
  let root: string

  beforeEach(() => {
    root = mkTempDir('ue-git-dirs-')
  })
  afterEach(() => {
    removeDirWithRetry(root)
  })

  it('resolves a main checkout', async () => {
    await git(['init', '-q'], root)
    const dirs = await detectGitDirs(root)
    expect(dirs).toBeDefined()
    expect(samePath(dirs?.gitDir ?? '', join(root, '.git'))).toBe(true)
    expect(samePath(dirs?.commonDir ?? '', join(root, '.git'))).toBe(true)
    expect(dirs?.isLinkedWorktree).toBe(false)
  })

  it('resolves a linked worktree to its own git dir and the common dir', async () => {
    await git(['init', '-q'], root)
    await git(['config', 'user.email', 'dev@example.com'], root)
    await git(['config', 'user.name', 'dev'], root)
    writeFileSync(join(root, 'a.txt'), '1')
    await git(['add', 'a.txt'], root)
    await git(['commit', '-qm', 'init'], root)

    const worktree = join(root, '.worktrees', 'task')
    await git(['worktree', 'add', '-q', '-b', 'task', worktree], root)

    const dirs = await detectGitDirs(worktree)
    expect(dirs).toBeDefined()
    expect(samePath(dirs?.gitDir ?? '', join(root, '.git', 'worktrees', 'task'))).toBe(true)
    expect(samePath(dirs?.commonDir ?? '', join(root, '.git'))).toBe(true)
    expect(dirs?.isLinkedWorktree).toBe(true)
  })

  it('returns undefined outside a repository', async () => {
    expect(await detectGitDirs(root)).toBeUndefined()
  })
})
