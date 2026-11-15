/**
 * `pnpm deliver`: run the headless delivery pipeline from a terminal. Argument
 * parsing, message validation and formatting stay pure so they can be tested
 * without git; only `main` touches the pipeline.
 */
import { isAbsolute, resolve } from 'node:path'
import { describeLockOwner, runHeadlessDelivery } from './deliveryPipeline.js'
import type {
  HeadlessDeliveryOptions,
  HeadlessDeliveryOutcome,
  HeadlessDeliveryPhaseName,
  HeadlessDeliveryPlan,
} from './deliveryPipeline.js'
import type {
  DeliveryFailure,
  DeliveryLockOwner,
  DeliveryWorktreeSyncResult,
} from './deliveryTypes.js'

export const EXIT_OK = 0
export const EXIT_DELIVERY_FAILED = 1
export const EXIT_USAGE = 2

const COMMIT_TYPES = new Set([
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'security',
])

const USAGE = [
  '用法: pnpm deliver [选项]',
  '',
  '  --message <msg>   为未提交改动指定提交信息（type(scope): 中文摘要）',
  '  --dry-run         只检查并打印交付计划（会 fetch，但不做任何修改）',
  '  --json            在 stdout 只输出最终 JSON，日志走 stderr',
  '  --target <branch> 目标分支（默认 main worktree 的当前分支）',
  '  --cwd <path>      交付源目录（默认 pnpm 调用目录；相对路径按调用者目录解析）',
  '  --help            显示帮助',
  '',
  '在 workspace 子包目录内请用 `pnpm -w deliver` 调用根脚本。',
].join('\n')

export interface DeliveryCliOptions {
  readonly cwd: string
  readonly message?: string
  readonly targetBranch?: string
  readonly dryRun: boolean
  readonly json: boolean
  readonly help: boolean
}

export type DeliveryCliParseResult =
  | { readonly ok: true; readonly options: DeliveryCliOptions }
  | { readonly ok: false; readonly error: string }

export interface DeliveryCliContext {
  readonly cwd: string
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly run: (options: HeadlessDeliveryOptions) => Promise<HeadlessDeliveryOutcome>
}

export function defaultDeliveryCwd(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = process.cwd(),
): string {
  const injected = env['INIT_CWD']?.trim()
  return injected !== undefined && injected.length > 0 ? injected : fallback
}

export function defaultDeliveryCliContext(): DeliveryCliContext {
  return {
    cwd: defaultDeliveryCwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    run: runHeadlessDelivery,
  }
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0]?.trim() ?? ''

/**
 * Mirrors the commit-message contract of the retired
 * commit-push-sync-worktrees script: `type(scope): summary`, known type, summary
 * of at most 72 characters, no trailing period, no AI attribution trailers.
 * Returns a Chinese explanation or undefined when the message is accepted.
 */
export function validateCommitMessage(message: string): string | undefined {
  const line = firstLine(message)
  const match = /^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/.exec(line)
  if (match === null) {
    return `提交信息不符合 "type(scope): 摘要" 格式: ${line.length > 0 ? line : '(空)'}`
  }
  const type = match[1]
  const summary = match[2]
  if (type === undefined || summary === undefined) {
    return `提交信息不符合 "type(scope): 摘要" 格式: ${line}`
  }
  if (!COMMIT_TYPES.has(type)) {
    return `未知提交类型 "${type}"；可用类型: ${[...COMMIT_TYPES].join(', ')}`
  }
  const length = [...summary].length
  if (length > 72) return `提交摘要超过 72 个字符（${length}）`
  if (/[.。]\s*$/.test(summary)) return '提交摘要不要以句号结尾'

  const attribution =
    /(^|\n)co-authored-by:.*\b(claude|codex|copilot|cursor|anthropic|openai)\b/i.test(message)
  const generated = /(^|\n)generated with\b.*\b(claude|codex|copilot|cursor)\b/i.test(message)
  const signed = /(^|\n)signed-off-by:.*\b(claude|codex)\b/i.test(message)
  if (attribution || generated || signed || message.includes('🤖')) {
    return '提交信息不得包含 AI/工具署名水印'
  }
  return undefined
}

const optionValue = (
  argv: readonly string[],
  index: number,
  name: string,
):
  | { readonly ok: true; readonly value: string; readonly next: number }
  | { readonly ok: false; readonly error: string } => {
  const inline = argv[index]
  if (inline === undefined) return { ok: false, error: `缺少选项 ${name}` }
  const equals = inline.indexOf('=')
  if (equals > 0 && inline.slice(0, equals) === name) {
    const value = inline.slice(equals + 1)
    if (value.length === 0) return { ok: false, error: `选项 ${name} 需要一个值` }
    return { ok: true, value, next: index + 1 }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    return { ok: false, error: `选项 ${name} 需要一个值` }
  }
  return { ok: true, value, next: index + 2 }
}

export function parseDeliveryArgs(
  argv: readonly string[],
  defaultCwd: string,
): DeliveryCliParseResult {
  const json = argv.includes('--json')
  if (argv.includes('--help') || argv.includes('-h')) {
    return { ok: true, options: { cwd: defaultCwd, dryRun: false, json, help: true } }
  }

  let cwd = defaultCwd
  let message: string | undefined
  let targetBranch: string | undefined
  let dryRun = false

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--dry-run') {
      dryRun = true
      index++
      continue
    }
    if (arg === '--json') {
      index++
      continue
    }
    const option = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (option === '--message' || option === '--target' || option === '--cwd') {
      const parsed = optionValue(argv, index, option)
      if (!parsed.ok) return parsed
      if (option === '--message') message = parsed.value
      else if (option === '--target') targetBranch = parsed.value
      else cwd = isAbsolute(parsed.value) ? parsed.value : resolve(defaultCwd, parsed.value)
      index = parsed.next
      continue
    }
    if (arg.startsWith('-')) return { ok: false, error: `未知选项: ${arg}` }
    return { ok: false, error: `不支持位置参数: ${arg}` }
  }

  return {
    ok: true,
    options: {
      cwd,
      dryRun,
      json,
      help: false,
      ...(message !== undefined ? { message } : {}),
      ...(targetBranch !== undefined ? { targetBranch } : {}),
    },
  }
}

const PHASE_LABELS: Readonly<Record<HeadlessDeliveryPhaseName, string>> = {
  inspect: '检查仓库与上游',
  lock: '获取交付锁',
  begin: '同步 main',
  commit: '提交源 worktree 改动',
  pick: 'cherry-pick 交付提交',
  push: '推送 main',
  sync: '同步 worktrees',
  cleanup: '清理',
}

const SYNC_LABELS: Readonly<Record<DeliveryWorktreeSyncResult['status'], string>> = {
  synced: '已同步',
  up_to_date: '已是最新',
  skipped_dirty: '跳过（有未提交改动）',
  skipped_in_progress: '跳过（有进行中的操作）',
  skipped_diverged: '跳过（有独立提交）',
  skipped_source_changed: '跳过（源 worktree 已变动）',
  failed: '失败',
}

const formatSync = (result: DeliveryWorktreeSyncResult): string => {
  const branch = result.branch !== undefined ? ` [${result.branch}]` : ''
  const error = result.error !== undefined ? `: ${result.error}` : ''
  return `${result.name}${branch}（${result.path}）: ${SYNC_LABELS[result.status]}${error}`
}

const pushAdvice = (plan: HeadlessDeliveryPlan | undefined): string => {
  const manual =
    plan !== undefined
      ? `git push ${plan.repository.remote} ${plan.repository.targetBranch}`
      : 'git push <remote> <branch>'
  return `main 可能已停在交付提交；远端缺失时可在 main worktree 执行 ${manual}，不要盲目重新交付。`
}

/** Concrete next step for the failure codes users hit most. */
export function failureAdvice(
  error: DeliveryFailure,
  plan: HeadlessDeliveryPlan | undefined,
): string | undefined {
  const upstream = plan?.repository.upstreamRef
  switch (error.code) {
    case 'main_dirty':
      return '请先提交或清理 main worktree 的改动后重试。'
    case 'main_diverged':
      return 'main 与上游已分叉；先让 main 与 upstream 同步（pull/merge）后再交付。'
    case 'main_moved':
      return 'main 在预览后移动了；先核对 main 当前位置与远端，再重新预览交付。'
    case 'head_mismatch':
      return '源 worktree 在交付期间移动，或临时 worktree 被改动；确认改动已提交后重新预览交付。'
    case 'upstream_changed':
      return '目标分支的 upstream 在预览后变化；重新预览确认后再交付。'
    case 'conflict':
      return upstream !== undefined
        ? `在源 worktree 执行 git rebase ${upstream} 解决冲突后重试。`
        : '在源 worktree 解决冲突（git rebase <upstream>）后重试。'
    case 'temp_worktree_failed':
      return '临时交付 worktree 创建或读取失败；检查 main worktree 同级的 .universe-editor-delivery-worktrees/ 是否有残留，以及磁盘空间和权限。'
    case 'lock_held':
      return '另一个进程正在交付该仓库；等待其结束（或确认进程已退出）后重试。'
    case 'merge_commit_unsupported':
      return upstream !== undefined
        ? `源分支历史含 merge commit；先执行 git rebase ${upstream} 整理历史后重试。`
        : '源分支历史含 merge commit；请先 rebase 整理历史后重试。'
    case 'nothing_to_deliver':
      if (plan?.source.isMainWorktree !== true) {
        return '源 worktree 没有待交付的提交或改动。'
      }
      break
    case 'push_failed':
      return `推送失败。${pushAdvice(plan)}`
    case 'push_unverified':
      return `推送结果未能确认。${pushAdvice(plan)}`
    case 'invalid_message':
      return '使用 "type(scope): 中文摘要" 格式，摘要不超过 72 字且不以句号结尾。'
    case 'fetch_failed':
      return '无法访问远程仓库；检查网络、凭据与 remote 配置后重试。'
    case 'no_upstream':
      return '目标分支未配置 upstream；先执行 git push -u <remote> <branch>。'
    case 'not_a_repository':
      return '请在 git 仓库的 worktree 目录中运行。'
    default:
      break
  }
  // Only fall back to the main-worktree hint when no code-specific advice
  // applies; lock_held and push failures stay the more useful message.
  if (plan?.source.isMainWorktree === true) {
    return '当前目录是 main worktree；请在子 worktree（会话目录）中运行。'
  }
  return undefined
}

const printWarnings = (plan: HeadlessDeliveryPlan, out: (line: string) => void): void => {
  if (plan.warnings.length === 0) return
  out('[deliver]   注意事项:')
  for (const warning of plan.warnings) out(`[deliver]     - ${warning}`)
}

const printPlan = (
  plan: HeadlessDeliveryPlan,
  out: (line: string) => void,
  hasMessage: boolean,
): void => {
  const branch = plan.source.branch !== undefined ? ` [${plan.source.branch}]` : ''
  out('[deliver] 交付计划（dry-run，未做任何修改）:')
  out(`[deliver]   源: ${plan.source.worktree}${branch}`)
  out(
    `[deliver]   目标: ${plan.repository.targetBranch}（main worktree: ${plan.repository.mainWorktree}）`,
  )
  out(`[deliver]   upstream: ${plan.repository.remote}/${plan.repository.remoteBranch}`)
  const plannedCommits = plan.commits.length + (plan.dirty ? 1 : 0)
  out(`[deliver]   待交付提交: ${plannedCommits}${plan.dirty ? '（含 +1 个待创建提交）' : ''}`)
  for (const commit of plan.commits) {
    out(`[deliver]     ${commit.shortSha} ${commit.subject}`)
  }
  if (plan.dirty && !hasMessage) {
    out('[deliver]   未提交改动: 正式交付需要 --message 指定提交信息')
  }
  printWarnings(plan, out)
}

const printCleanupWarnings = (
  outcome: HeadlessDeliveryOutcome,
  out: (line: string) => void,
): void => {
  if (outcome.cleanupWarnings.length === 0) return
  out('[deliver] 清理警告:')
  for (const warning of outcome.cleanupWarnings) out(`[deliver]   ${warning}`)
}

const printSummary = (outcome: HeadlessDeliveryOutcome, out: (line: string) => void): void => {
  out('[deliver] 交付完成。')
  if (outcome.worktrees.some((result) => result.status === 'failed')) {
    out('[deliver] 注意: 推送已落地，仅 worktree 同步失败，可手动处理；不要重新交付。')
  }
  out('[deliver] 汇总:')
  if (outcome.delivered.length === 0) {
    out('[deliver]   交付提交: 无')
  } else {
    out(`[deliver]   交付提交 (${outcome.delivered.length}):`)
    for (const commit of outcome.delivered) {
      out(`[deliver]     ${commit.shortSha} ${commit.subject}`)
    }
  }
  out(
    `[deliver]   跳过空提交: ${
      outcome.skippedEmpty.length > 0
        ? outcome.skippedEmpty.map((sha) => sha.slice(0, 8)).join(', ')
        : '无'
    }`,
  )
  out(`[deliver]   推送 SHA: ${outcome.pushedSha ?? '无'}`)
  out('[deliver]   worktree 同步:')
  if (outcome.worktrees.length === 0) out('[deliver]     无')
  for (const result of outcome.worktrees) out(`[deliver]     ${formatSync(result)}`)
  printCleanupWarnings(outcome, out)
}

const printFailure = (outcome: HeadlessDeliveryOutcome, err: (line: string) => void): void => {
  const error = outcome.error
  if (error === undefined) return
  err(`[deliver] 交付失败: ${error.code}`)
  err(`[deliver]   信息: ${error.message}`)
  if (error.detail !== undefined) {
    for (const line of error.detail.split(/\r?\n/)) err(`[deliver]   详情: ${line}`)
  }
  if (outcome.lockOwner !== undefined) {
    err(`[deliver]   锁持有者: ${describeLockOwner(outcome.lockOwner)}`)
  }
  printCleanupWarnings(outcome, err)
  const advice = failureAdvice(error, outcome.plan)
  if (advice !== undefined) err(`[deliver]   建议: ${advice}`)
}

const redactLockOwner = (owner: DeliveryLockOwner): Omit<DeliveryLockOwner, 'token'> => ({
  pid: owner.pid,
  hostname: owner.hostname,
  startedAt: owner.startedAt,
  heartbeatAt: owner.heartbeatAt,
  ...(owner.label !== undefined ? { label: owner.label } : {}),
})

const usageFailure = (
  options: { readonly json: boolean },
  context: DeliveryCliContext,
  message: string,
): number => {
  if (options.json) {
    context.out(
      JSON.stringify(
        { exitCode: EXIT_USAGE, ok: false, error: { code: 'invalid_arguments', message } },
        null,
        2,
      ),
    )
  } else {
    context.err(`[deliver] 参数错误: ${message}`)
    context.err(USAGE)
  }
  return EXIT_USAGE
}

export async function main(
  argv: readonly string[],
  context: DeliveryCliContext = defaultDeliveryCliContext(),
): Promise<number> {
  const parsed = parseDeliveryArgs(argv, context.cwd)
  if (!parsed.ok) {
    return usageFailure({ json: argv.includes('--json') }, context, parsed.error)
  }
  const options = parsed.options
  if (options.help) {
    // Keep stdout machine-readable when --json is combined with --help.
    context.out(options.json ? JSON.stringify({ usage: USAGE }, null, 2) : USAGE)
    return EXIT_OK
  }
  if (options.message !== undefined) {
    const invalid = validateCommitMessage(options.message)
    if (invalid !== undefined) return usageFailure(options, context, invalid)
  }

  const log = (line: string): void => {
    if (options.json) context.err(line)
    else context.out(line)
  }
  const runOptions: HeadlessDeliveryOptions = {
    sourceCwd: options.cwd,
    dryRun: options.dryRun,
    onPhase: (phase) => log(`[deliver] ${PHASE_LABELS[phase.phase]}：${phase.message}`),
    onPlan: (plan) => {
      // A formal run should surface warnings up front (e.g. main has unpushed
      // commits that this push will publish too), not only after it finishes.
      if (!options.dryRun) printWarnings(plan, options.json ? context.err : context.out)
    },
    ...(options.message !== undefined ? { message: options.message } : {}),
    ...(options.targetBranch !== undefined ? { targetBranch: options.targetBranch } : {}),
  }

  let outcome: HeadlessDeliveryOutcome
  try {
    outcome = await context.run(runOptions)
  } catch (err) {
    outcome = {
      ok: false,
      dryRun: options.dryRun,
      phases: [],
      picked: [],
      delivered: [],
      skippedEmpty: [],
      worktrees: [],
      cleanupWarnings: [],
      error: {
        code: 'git_failed',
        message: '交付流程异常终止。',
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }

  const worktreeSyncFailed = outcome.worktrees.some((result) => result.status === 'failed')
  // A failed worktree sync happens after the push landed; the delivery itself
  // cannot be retried, but it still exits non-zero so callers notice.
  const exitCode = outcome.ok && !worktreeSyncFailed ? EXIT_OK : EXIT_DELIVERY_FAILED
  if (options.json) {
    printCleanupWarnings(outcome, context.err)
    const jsonOutcome =
      outcome.lockOwner !== undefined
        ? { ...outcome, lockOwner: redactLockOwner(outcome.lockOwner) }
        : outcome
    context.out(JSON.stringify({ exitCode, ...jsonOutcome }, null, 2))
  } else if (outcome.ok) {
    if (outcome.dryRun && outcome.plan !== undefined) {
      printPlan(outcome.plan, context.out, options.message !== undefined)
    }
    if (!outcome.dryRun) printSummary(outcome, context.out)
  } else {
    // A blocked dry-run still shows what it inspected before the failure;
    // formal runs already printed their warnings through onPlan.
    if (outcome.dryRun && outcome.plan !== undefined) {
      printPlan(outcome.plan, context.err, options.message !== undefined)
    }
    printFailure(outcome, context.err)
  }
  return exitCode
}
