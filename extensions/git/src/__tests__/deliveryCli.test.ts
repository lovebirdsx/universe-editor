import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EXIT_DELIVERY_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  defaultDeliveryCwd,
  failureAdvice,
  main,
  parseDeliveryArgs,
  validateCommitMessage,
  type DeliveryCliContext,
} from '../delivery/deliveryCli.js'
import type {
  HeadlessDeliveryOptions,
  HeadlessDeliveryOutcome,
  HeadlessDeliveryPlan,
} from '../delivery/deliveryPipeline.js'

const outcome = (overrides: Partial<HeadlessDeliveryOutcome> = {}): HeadlessDeliveryOutcome => ({
  ok: true,
  dryRun: false,
  phases: [],
  picked: [],
  delivered: [],
  skippedEmpty: [],
  worktrees: [],
  cleanupWarnings: [],
  ...overrides,
})

const plan = (overrides: Partial<HeadlessDeliveryPlan> = {}): HeadlessDeliveryPlan => ({
  repository: {
    commonDir: '/repo/.git',
    mainWorktree: '/repo/main',
    mainBranch: 'main',
    targetBranch: 'main',
    remote: 'origin',
    remoteBranch: 'main',
    upstreamRef: 'origin/main',
    mainHead: 'a'.repeat(40),
    upstreamHead: 'a'.repeat(40),
    aheadOfUpstream: 0,
    behindUpstream: 0,
    canFastForward: false,
  },
  source: {
    worktree: '/repo/feature',
    branch: 'feature',
    head: 'b'.repeat(40),
    dirty: false,
    changedFileCount: 0,
    untrackedCount: 0,
    isMainWorktree: false,
  },
  baseSha: 'a'.repeat(40),
  commits: [],
  warnings: [],
  dirty: false,
  ...overrides,
})

const createContext = (
  run: DeliveryCliContext['run'],
  cwd = '/caller',
): { readonly context: DeliveryCliContext; readonly out: string[]; readonly err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return {
    context: { cwd, out: (line) => out.push(line), err: (line) => err.push(line), run },
    out,
    err,
  }
}

describe('parseDeliveryArgs', () => {
  it('defaults to the caller directory', () => {
    expect(parseDeliveryArgs([], '/caller')).toEqual({
      ok: true,
      options: { cwd: '/caller', dryRun: false, json: false, help: false },
    })
  })

  it('parses all supported options in both value forms', () => {
    const absoluteCwd = process.platform === 'win32' ? 'X:/repo' : '/repo'
    expect(
      parseDeliveryArgs(
        ['--message', 'feat: 摘要', '--dry-run', '--json', '--target=main', '--cwd', absoluteCwd],
        '/caller',
      ),
    ).toEqual({
      ok: true,
      options: {
        cwd: absoluteCwd,
        message: 'feat: 摘要',
        targetBranch: 'main',
        dryRun: true,
        json: true,
        help: false,
      },
    })
  })

  it('resolves a relative --cwd against the caller directory', () => {
    expect(parseDeliveryArgs(['--cwd', 'repo'], '/caller')).toMatchObject({
      ok: true,
      options: { cwd: resolve('/caller', 'repo') },
    })
    expect(parseDeliveryArgs(['--cwd=repo/sub'], '/caller')).toMatchObject({
      ok: true,
      options: { cwd: resolve('/caller', 'repo/sub') },
    })
  })

  it('prioritizes --help', () => {
    expect(parseDeliveryArgs(['--nope', '--help'], '/caller')).toMatchObject({
      ok: true,
      options: { help: true, cwd: '/caller' },
    })
  })

  it('rejects unknown options, missing values and positionals', () => {
    expect(parseDeliveryArgs(['--nope'], '/caller')).toEqual({
      ok: false,
      error: '未知选项: --nope',
    })
    expect(parseDeliveryArgs(['--message'], '/caller')).toEqual({
      ok: false,
      error: '选项 --message 需要一个值',
    })
    expect(parseDeliveryArgs(['--cwd='], '/caller')).toEqual({
      ok: false,
      error: '选项 --cwd 需要一个值',
    })
    expect(parseDeliveryArgs(['extra'], '/caller')).toEqual({
      ok: false,
      error: '不支持位置参数: extra',
    })
  })
})

describe('defaultDeliveryCwd', () => {
  it('prefers INIT_CWD and falls back to the provided cwd', () => {
    expect(defaultDeliveryCwd({ INIT_CWD: ' X:/caller ' }, '/fallback')).toBe('X:/caller')
    expect(defaultDeliveryCwd({}, '/fallback')).toBe('/fallback')
    expect(defaultDeliveryCwd({ INIT_CWD: '   ' }, '/fallback')).toBe('/fallback')
  })
})

describe('validateCommitMessage', () => {
  it('accepts type(scope) messages with a Chinese summary', () => {
    expect(validateCommitMessage('feat(delivery): 交付流水线')).toBeUndefined()
    expect(validateCommitMessage('fix: 修复问题!\n\n正文')).toBeUndefined()
  })

  it('rejects malformed, unknown, long and trailing-period messages', () => {
    expect(validateCommitMessage('deliver stuff')).toContain('不符合')
    expect(validateCommitMessage('nope: 摘要')).toContain('未知提交类型')
    expect(validateCommitMessage(`feat: ${'长'.repeat(73)}`)).toContain('72')
    expect(validateCommitMessage('feat: 摘要。')).toContain('句号')
    expect(validateCommitMessage('feat: 摘要.')).toContain('句号')
  })

  it('rejects AI attribution watermarks', () => {
    expect(validateCommitMessage('feat: 摘要\n\nCo-Authored-By: Claude <noreply@x>')).toContain(
      '水印',
    )
    expect(validateCommitMessage('feat: 摘要 🤖')).toContain('水印')
  })
})

describe('failureAdvice', () => {
  it('suggests rebasing for conflicts and manual pushes for unverified pushes', () => {
    expect(failureAdvice({ code: 'conflict', message: 'conflicted' }, plan())).toBe(
      '在源 worktree 执行 git rebase origin/main 解决冲突后重试。',
    )
    const unverified = failureAdvice({ code: 'push_unverified', message: 'unverified' }, plan())
    expect(unverified).toContain('git push origin main')
    expect(unverified).toContain('不要盲目重新交付')
    expect(failureAdvice({ code: 'push_failed', message: 'failed' }, plan())).toContain(
      'git push origin main',
    )
    expect(failureAdvice({ code: 'main_dirty', message: 'dirty' }, plan())).toContain('main')
    expect(failureAdvice({ code: 'lock_held', message: 'locked' }, plan())).toContain('另一个进程')
    expect(failureAdvice({ code: 'main_moved', message: 'moved' }, plan())).toContain('重新预览')
    expect(failureAdvice({ code: 'head_mismatch', message: 'moved' }, plan())).toContain('重新预览')
    expect(failureAdvice({ code: 'upstream_changed', message: 'changed' }, plan())).toContain(
      '重新预览',
    )
    expect(failureAdvice({ code: 'temp_worktree_failed', message: 'temp' }, plan())).toContain(
      '.universe-editor-delivery-worktrees',
    )
  })

  it('does not let the main-worktree hint hide specific advice', () => {
    const mainPlan = plan({
      source: { ...plan().source, isMainWorktree: true },
    })
    expect(failureAdvice({ code: 'lock_held', message: 'locked' }, mainPlan)).toContain(
      '另一个进程',
    )
    expect(failureAdvice({ code: 'push_unverified', message: 'unverified' }, mainPlan)).toContain(
      '不要盲目重新交付',
    )
  })

  it('explains that the source is the main worktree', () => {
    const mainPlan = plan({
      source: { ...plan().source, isMainWorktree: true },
    })
    expect(failureAdvice({ code: 'unsupported', message: 'main worktree' }, mainPlan)).toContain(
      '子 worktree',
    )
    expect(failureAdvice({ code: 'nothing_to_deliver', message: 'empty' }, mainPlan)).toContain(
      '子 worktree',
    )
  })
})

describe('main exit codes', () => {
  it('returns 0 for a successful delivery and prints the summary', async () => {
    const run = vi.fn(async () =>
      outcome({
        dryRun: false,
        delivered: [
          {
            sha: 'a'.repeat(40),
            shortSha: 'aaaaaaa',
            subject: 'add feature',
            author: '',
            authoredAt: '',
          },
        ],
        pushedSha: 'a'.repeat(40),
        worktrees: [{ name: 'main', path: '/repo/main', branch: 'main', status: 'up_to_date' }],
      }),
    )
    const { context, out } = createContext(run)

    const code = await main(['--message', 'feat: 摘要'], context)

    expect(code).toBe(EXIT_OK)
    expect(run).toHaveBeenCalledOnce()
    expect(out.join('\n')).toContain('交付完成')
    expect(out.join('\n')).toContain('aaaaaaa add feature')
    expect(out.join('\n')).toContain('已是最新')
  })

  it('returns 1 and prints code, detail and advice on delivery failure', async () => {
    const run = vi.fn(async () =>
      outcome({
        ok: false,
        plan: plan(),
        error: { code: 'main_dirty', message: 'main is dirty', detail: 'dirty.txt' },
      }),
    )
    const { context, err } = createContext(run)

    const code = await main([], context)

    expect(code).toBe(EXIT_DELIVERY_FAILED)
    expect(err.join('\n')).toContain('交付失败: main_dirty')
    expect(err.join('\n')).toContain('信息: main is dirty')
    expect(err.join('\n')).toContain('详情: dirty.txt')
    expect(err.join('\n')).toContain('建议:')
  })

  it('returns 2 for invalid arguments and does not run the pipeline', async () => {
    const run = vi.fn(async () => outcome())
    const { context, err } = createContext(run)

    expect(await main(['--nope'], context)).toBe(EXIT_USAGE)
    expect(await main(['--message', 'bad message'], context)).toBe(EXIT_USAGE)
    expect(run).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('参数错误')
  })

  it('prints help and returns 0 without running the pipeline', async () => {
    const run = vi.fn(async () => outcome())
    const { context, out } = createContext(run)

    expect(await main(['--help'], context)).toBe(EXIT_OK)
    expect(out.join('\n')).toContain('用法: pnpm deliver')
    expect(run).not.toHaveBeenCalled()
  })

  it('emits only JSON on stdout in --json mode and sends phase logs to stderr', async () => {
    const run = vi.fn(async (options: HeadlessDeliveryOptions) => {
      options.onPhase?.({ phase: 'inspect', message: 'inspecting', at: 1 })
      return outcome({ dryRun: true, plan: plan() })
    })
    const { context, out, err } = createContext(run)

    const code = await main(['--json', '--dry-run'], context)

    expect(code).toBe(EXIT_OK)
    expect(out).toHaveLength(1)
    expect(out[0]?.startsWith('{')).toBe(true)
    expect(out[0]).not.toContain('[deliver]')
    const parsed = JSON.parse(out[0] ?? '{}') as { exitCode: number; ok: boolean; dryRun: boolean }
    expect(parsed).toMatchObject({ exitCode: EXIT_OK, ok: true, dryRun: true })
    expect(err.join('\n')).toContain('检查仓库与上游')
  })

  it('emits a JSON usage error on stdout and nothing on stderr with --json', async () => {
    const run = vi.fn(async () => outcome())
    const { context, out, err } = createContext(run)

    const code = await main(['--json', '--nope'], context)

    expect(code).toBe(EXIT_USAGE)
    expect(err).toEqual([])
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0] ?? '{}') as {
      exitCode: number
      ok: boolean
      error: { code: string; message: string }
    }
    expect(parsed).toMatchObject({
      exitCode: EXIT_USAGE,
      ok: false,
      error: { code: 'invalid_arguments' },
    })
  })

  it('keeps stdout JSON when --json is combined with --help', async () => {
    const run = vi.fn(async () => outcome())
    const { context, out, err } = createContext(run)

    const code = await main(['--json', '--help'], context)

    expect(code).toBe(EXIT_OK)
    expect(err).toEqual([])
    const parsed = JSON.parse(out[0] ?? '{}') as { usage: string }
    expect(parsed.usage).toContain('用法: pnpm deliver')
    expect(run).not.toHaveBeenCalled()
  })

  it('returns 1 when the push landed but a worktree sync failed', async () => {
    const run = vi.fn(async () =>
      outcome({
        pushedSha: 'a'.repeat(40),
        worktrees: [
          {
            name: 'other',
            path: '/repo/other',
            branch: 'other',
            status: 'failed',
            error: 'boom',
          },
          { name: 'side', path: '/repo/side', branch: 'side', status: 'skipped_dirty' },
        ],
      }),
    )
    const { context, out } = createContext(run)

    const code = await main(['--message', 'feat: 摘要'], context)

    expect(code).toBe(EXIT_DELIVERY_FAILED)
    expect(out.join('\n')).toContain('推送已落地，仅 worktree 同步失败')
  })

  it('keeps skipped worktrees successful', async () => {
    const run = vi.fn(async () =>
      outcome({
        pushedSha: 'a'.repeat(40),
        worktrees: [{ name: 'side', path: '/repo/side', branch: 'side', status: 'skipped_dirty' }],
      }),
    )
    const { context } = createContext(run)

    expect(await main(['--message', 'feat: 摘要'], context)).toBe(EXIT_OK)
  })

  it('does not expose the lock owner token in JSON output', async () => {
    const run = vi.fn(async () =>
      outcome({
        ok: false,
        lockOwner: {
          token: 'secret-token',
          pid: 1234,
          hostname: 'dev',
          startedAt: '2026-01-01T00:00:00.000Z',
          heartbeatAt: '2026-01-01T00:00:00.000Z',
          label: 'cli 1',
        },
        error: { code: 'lock_held', message: 'locked' },
      }),
    )
    const { context, out, err } = createContext(run)

    const code = await main(['--json'], context)

    expect(code).toBe(EXIT_DELIVERY_FAILED)
    expect(out.join('\n')).not.toContain('secret-token')
    const parsed = JSON.parse(out[0] ?? '{}') as {
      lockOwner?: { pid: number; label?: string; token?: string }
    }
    expect(parsed.lockOwner).toMatchObject({ pid: 1234, label: 'cli 1' })
    expect(parsed.lockOwner?.token).toBeUndefined()
    expect(err.join('\n')).not.toContain('secret-token')
  })

  it('only asks for --message when the plan is dirty and none was provided', async () => {
    const dirtyPlan = plan({ dirty: true, commits: [] })
    const runMissing = vi.fn(async () => outcome({ dryRun: true, plan: dirtyPlan }))
    const missing = createContext(runMissing)
    await main(['--dry-run'], missing.context)
    expect(missing.out.join('\n')).toContain('正式交付需要 --message')
    expect(missing.out.join('\n')).toContain('含 +1 个待创建提交')

    const runProvided = vi.fn(async () => outcome({ dryRun: true, plan: dirtyPlan }))
    const provided = createContext(runProvided)
    await main(['--dry-run', '--message', 'feat: 摘要'], provided.context)
    expect(provided.out.join('\n')).not.toContain('正式交付需要 --message')
    expect(provided.out.join('\n')).toContain('含 +1 个待创建提交')
  })

  it('prints plan warnings up front for a formal run, on stderr in --json mode', async () => {
    const run = vi.fn(async (options: HeadlessDeliveryOptions) => {
      options.onPlan?.(
        plan({
          warnings: ['The main branch has 1 unpushed commit(s); pushing will publish them too.'],
        }),
      )
      return outcome({ pushedSha: 'a'.repeat(40) })
    })
    const text = createContext(run)
    await main(['--message', 'feat: 摘要'], text.context)
    expect(text.out.join('\n')).toContain('pushing will publish them too')

    const json = createContext(run)
    await main(['--json', '--message', 'feat: 摘要'], json.context)
    expect(json.err.join('\n')).toContain('pushing will publish them too')
    expect(json.out).toHaveLength(1)
  })

  it('prints the plan before the failure for a blocked dry-run', async () => {
    const run = vi.fn(async () =>
      outcome({
        ok: false,
        dryRun: true,
        plan: plan(),
        error: { code: 'main_dirty', message: 'main is dirty' },
      }),
    )
    const { context, err } = createContext(run)

    const code = await main(['--dry-run'], context)

    expect(code).toBe(EXIT_DELIVERY_FAILED)
    expect(err.join('\n')).toContain('交付计划')
    expect(err.join('\n')).toContain('交付失败: main_dirty')
  })
})
