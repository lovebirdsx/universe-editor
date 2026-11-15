/**
 * Headless delivery pipeline: run the same primitives the renderer orchestrates,
 * minus the UI, AI commit-message generation and conflict resolution. A caller
 * that already has a commit message can deliver a source worktree to main and
 * push it end to end.
 *
 * Safety invariants mirror the renderer: take the cross-window lock before any
 * write, never force-push, restore main only when the failure happened before
 * promotion, and keep the temporary worktree only long enough to clean it up.
 */
import { randomUUID } from 'node:crypto'
import {
  abortPickDelivery,
  beginDelivery,
  commitSourceDelivery,
  currentHead,
  inspectDelivery,
  preparePickDelivery,
  promoteAndPushDelivery,
  restoreMainDelivery,
  syncWorktreesDelivery,
  type Log,
} from './deliveryGit.js'
import { acquireDeliveryLock, heartbeatDeliveryLock, releaseDeliveryLock } from './deliveryLock.js'
import type {
  DeliveryCommitInfo,
  DeliveryErrorCode,
  DeliveryFailure,
  DeliveryInspectData,
  DeliveryLockOwner,
  DeliveryRepositoryInfo,
  DeliverySourceInfo,
  DeliveryWorktreeSyncResult,
} from './deliveryTypes.js'

export type HeadlessDeliveryPhaseName =
  | 'inspect'
  | 'lock'
  | 'begin'
  | 'commit'
  | 'pick'
  | 'push'
  | 'sync'
  | 'cleanup'

export interface HeadlessDeliveryPhase {
  readonly phase: HeadlessDeliveryPhaseName
  readonly message: string
  readonly at: number
}

export interface HeadlessDeliveryPlan {
  readonly repository: DeliveryRepositoryInfo
  readonly source: DeliverySourceInfo
  readonly baseSha: string
  readonly commits: readonly DeliveryCommitInfo[]
  readonly warnings: readonly string[]
  readonly dirty: boolean
}

export interface HeadlessDeliveryOutcome {
  readonly ok: boolean
  readonly dryRun: boolean
  readonly phases: readonly HeadlessDeliveryPhase[]
  readonly plan?: HeadlessDeliveryPlan
  readonly error?: DeliveryFailure
  /** Commits cherry-picked into the temporary worktree; not on main until a push succeeds. */
  readonly picked: readonly DeliveryCommitInfo[]
  /** Commits that actually landed on main after a successful promotion and push. */
  readonly delivered: readonly DeliveryCommitInfo[]
  readonly skippedEmpty: readonly string[]
  readonly pushedSha?: string
  readonly mainHead?: string
  readonly worktrees: readonly DeliveryWorktreeSyncResult[]
  readonly lockOwner?: DeliveryLockOwner
  /** Cleanup problems that did not abort an otherwise successful delivery. */
  readonly cleanupWarnings: readonly string[]
}

export interface HeadlessDeliveryOptions {
  readonly sourceCwd: string
  readonly message?: string
  readonly targetBranch?: string
  readonly dryRun?: boolean
  readonly log?: (msg: string) => void
  readonly onPhase?: (phase: HeadlessDeliveryPhase) => void
  /** Called once the plan is known, before any write; observers must not throw. */
  readonly onPlan?: (plan: HeadlessDeliveryPlan) => void
}

const HEARTBEAT_INTERVAL_MS = 60_000
const PUSH_ATTEMPTS = 3
const PUSH_RECHECK_ATTEMPTS = 2
const PUSH_RETRY_DELAY_MS = 1_000
/**
 * Caps the whole post-push verification loop, including re-fetching the remote
 * and re-promoting. A single promote already spends up to ~3.5 minutes on the
 * push and verification timeouts, so three unbounded rounds could exceed ten
 * minutes.
 */
const PUSH_TOTAL_BUDGET_MS = 3 * 60_000

type RemoteDeliveryState = 'pushed' | 'local_only' | 'unknown'

class DeliveryHalt extends Error {
  constructor(readonly failure: DeliveryFailure) {
    super(failure.message)
  }
}

const halt = (code: DeliveryErrorCode, message: string, detail?: string): never => {
  throw new DeliveryHalt({ code, message, ...(detail !== undefined ? { detail } : {}) })
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const appendDetail = (error: DeliveryFailure, extra: string): DeliveryFailure => ({
  code: error.code,
  message: error.message,
  detail: error.detail !== undefined ? `${error.detail}\n${extra}` : extra,
})

const failureWithProblems = (
  error: DeliveryFailure,
  problems: readonly string[],
): DeliveryFailure => (problems.length > 0 ? appendDetail(error, problems.join('\n')) : error)

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Owner line for lock_held failures; the CLI prints it verbatim. */
export const describeLockOwner = (owner: DeliveryLockOwner | undefined): string => {
  if (owner === undefined) return 'another process'
  const label = owner.label !== undefined ? `${owner.label}, ` : ''
  return `${label}pid ${owner.pid} on ${owner.hostname}`
}

/**
 * Post-push verification fallback, mirroring the renderer's `_remoteDeliveryState`:
 * re-inspect with a fetch and compare both the upstream and main heads against
 * the delivered commit. `local_only` is the only state that proves the fetch
 * succeeded while the remote still lacks the commit, so only then is it safe to
 * promote and push again.
 */
const remoteDeliveryState = async (
  mainWorktree: string,
  expectedHead: string,
  log: Log,
): Promise<RemoteDeliveryState> => {
  const inspected = await inspectDelivery({ sourceCwd: mainWorktree, fetch: true }, log)
  if (!inspected.ok) return 'unknown'
  if (inspected.repository.upstreamHead === expectedHead) return 'pushed'
  if (inspected.repository.mainHead === expectedHead) return 'local_only'
  return 'unknown'
}

interface PipelineState {
  readonly phases: HeadlessDeliveryPhase[]
  plan: HeadlessDeliveryPlan | undefined
  error: DeliveryFailure | undefined
  picked: DeliveryCommitInfo[]
  delivered: DeliveryCommitInfo[]
  skippedEmpty: string[]
  worktrees: DeliveryWorktreeSyncResult[]
  pushedSha: string | undefined
  mainHead: string | undefined
  lockOwner: DeliveryLockOwner | undefined
  cleanupWarnings: string[]
}

export async function runHeadlessDelivery(
  options: HeadlessDeliveryOptions,
): Promise<HeadlessDeliveryOutcome> {
  const log = options.log
  const dryRun = options.dryRun === true
  const state: PipelineState = {
    phases: [],
    plan: undefined,
    error: undefined,
    picked: [],
    delivered: [],
    skippedEmpty: [],
    worktrees: [],
    pushedSha: undefined,
    mainHead: undefined,
    lockOwner: undefined,
    cleanupWarnings: [],
  }
  const phase = (name: HeadlessDeliveryPhaseName, message: string): void => {
    const entry: HeadlessDeliveryPhase = { phase: name, message, at: Date.now() }
    state.phases.push(entry)
    try {
      options.onPhase?.(entry)
    } catch {
      // Observers (CLI logging, UI progress) must never break the delivery.
    }
  }
  const recordCleanupFailure = (problem: string): void => {
    // Before the catch block runs there is no structured error yet; keep
    // successful deliveries' cleanup problems while still surfacing failures
    // that happen after an error was recorded.
    if (state.error !== undefined) state.error = appendDetail(state.error, problem)
    else state.cleanupWarnings.push(problem)
  }
  const recordProblems = (problems: readonly string[]): void => {
    for (const problem of problems) recordCleanupFailure(problem)
  }

  let token: string | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let commonDir: string | undefined
  let mainWorktree: string | undefined
  let targetBranch: string | undefined
  let deliveryId: string | undefined
  let tempWorktree: string | undefined
  let mainHeadBefore: string | undefined
  let mainHeadAfter: string | undefined
  let pushAttempted = false

  const abortTemp = async (path: string | undefined): Promise<string[]> => {
    const dir = commonDir
    const id = deliveryId
    const lockToken = token
    const worktree = mainWorktree
    if (
      dir === undefined ||
      id === undefined ||
      lockToken === undefined ||
      worktree === undefined
    ) {
      return []
    }
    try {
      const aborted = await abortPickDelivery(
        {
          commonDir: dir,
          deliveryId: id,
          token: lockToken,
          mainWorktree: worktree,
          ...(path !== undefined ? { tempWorktree: path } : {}),
        },
        log,
      )
      if (!aborted.ok) {
        return [`Removing the temporary worktree failed: ${aborted.error.message}`]
      }
      if (!aborted.removed) {
        return ['The temporary worktree could not be removed; delete it manually before retrying.']
      }
      phase('cleanup', '已移除临时 worktree')
      return []
    } catch (err) {
      return [`Removing the temporary worktree failed: ${errorMessage(err)}`]
    }
  }

  const restoreMain = async (
    before: string,
    after: string,
    worktree: string,
    branch: string,
  ): Promise<string[]> => {
    try {
      const restored = await restoreMainDelivery(
        {
          mainWorktree: worktree,
          expectedCurrentHead: after,
          restoreToHead: before,
          targetBranch: branch,
        },
        log,
      )
      if (!restored.ok) {
        return [`Restoring main to its pre-delivery commit failed: ${restored.error.message}`]
      }
      phase('cleanup', `已将 main 恢复到 ${before.slice(0, 8)}`)
      return []
    } catch (err) {
      return [`Restoring main to its pre-delivery commit failed: ${errorMessage(err)}`]
    }
  }

  const releaseLock = async (): Promise<string[]> => {
    const dir = commonDir
    const lockToken = token
    if (dir === undefined || lockToken === undefined) return []
    try {
      const released = await releaseDeliveryLock({ commonDir: dir, token: lockToken }, log)
      if (!released.ok) {
        return [`Releasing the delivery lock failed: ${released.error.message}`]
      }
      return []
    } catch (err) {
      return [`Releasing the delivery lock failed: ${errorMessage(err)}`]
    }
  }

  try {
    if (typeof options.sourceCwd !== 'string' || options.sourceCwd.length === 0) {
      halt('not_a_repository', 'The delivery source directory is missing.')
    }

    phase('inspect', `正在检查 ${options.sourceCwd}`)
    const inspected = await inspectDelivery(
      {
        sourceCwd: options.sourceCwd,
        ...(options.targetBranch !== undefined ? { targetBranch: options.targetBranch } : {}),
        fetch: true,
      },
      log,
    )
    if (!inspected.ok) throw new DeliveryHalt(inspected.error)
    const data: DeliveryInspectData = inspected
    const plan: HeadlessDeliveryPlan = {
      repository: data.repository,
      source: data.source,
      baseSha: data.baseSha,
      commits: data.commits,
      warnings: data.warnings,
      dirty: data.source.dirty,
    }
    if (data.source.isMainWorktree) {
      // Delivering from the main worktree can never move anything: the source
      // and target are the same tree. Check this before blockers, otherwise
      // main_dirty / nothing_to_deliver always fire first and hide the real
      // problem. Dry-run still returns the plan, annotated as not deliverable.
      const warning =
        'The source worktree is the main worktree; a formal delivery must run from a child worktree.'
      const annotated: HeadlessDeliveryPlan = {
        ...plan,
        warnings: [...plan.warnings, warning],
      }
      state.plan = annotated
      try {
        options.onPlan?.(annotated)
      } catch {
        // Observers must never break the pipeline.
      }
      if (!dryRun) halt('unsupported', warning)
    } else {
      state.plan = plan
      try {
        options.onPlan?.(plan)
      } catch {
        // Observers must never break the pipeline.
      }
    }
    if (data.blockers.length > 0) throw new DeliveryHalt(data.blockers[0]!)
    if (dryRun) {
      const plannedCommits = data.commits.length + (data.source.dirty ? 1 : 0)
      phase(
        'inspect',
        data.source.dirty
          ? `计划交付 ${plannedCommits} 个提交（含 1 个待创建提交）`
          : `计划交付 ${plannedCommits} 个提交`,
      )
      return buildOutcome(state, true, dryRun)
    }
    const message = options.message?.trim() ?? ''
    if (data.source.dirty && message.length === 0) {
      halt(
        'invalid_message',
        'The source worktree has uncommitted changes; pass a commit message with --message.',
      )
    }

    commonDir = data.repository.commonDir
    mainWorktree = data.repository.mainWorktree
    targetBranch = data.repository.targetBranch
    deliveryId = randomUUID()

    token = randomUUID()
    phase('lock', `正在获取 ${commonDir} 的交付锁`)
    const lock = await acquireDeliveryLock({ commonDir, token, label: `cli ${process.pid}` }, log)
    if (!lock.ok) throw new DeliveryHalt(lock.error)
    if (!lock.acquired) {
      state.lockOwner = lock.owner
      halt(
        'lock_held',
        `Another delivery holds the lock (${describeLockOwner(lock.owner)}).`,
        lock.owner !== undefined
          ? describeLockOwner(lock.owner)
          : 'The lock directory exists but its owner record is still being written.',
      )
    }
    heartbeat = setInterval(() => {
      if (token !== undefined && commonDir !== undefined) {
        void heartbeatDeliveryLock({ commonDir, token }, log).catch(() => undefined)
      }
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref()
    phase('lock', `已获取交付锁（${describeLockOwner(lock.owner)}）`)

    phase('begin', '正在尝试将 main 快进到上游')
    const begin = await beginDelivery(
      {
        commonDir,
        deliveryId,
        token,
        mainWorktree,
        sourceCwd: data.source.worktree,
        targetBranch,
        expectedMainHead: data.repository.mainHead,
        expectedUpstreamHead: data.repository.upstreamHead,
        expectedSourceHead: data.source.head,
        remote: data.repository.remote,
        upstreamRef: data.repository.upstreamRef,
      },
      log,
    )
    if (!begin.ok) throw new DeliveryHalt(begin.error)
    mainHeadBefore = begin.mainHeadBefore
    mainHeadAfter = begin.mainHeadAfter
    phase('begin', `main 位于 ${begin.mainHeadAfter.slice(0, 8)}`)

    let sourceHead = data.source.head
    const sourceCommits = [...data.commits]
    if (data.source.dirty) {
      phase('commit', `正在提交 ${data.source.worktree} 的改动`)
      const committed = await commitSourceDelivery(
        {
          commonDir,
          deliveryId,
          token,
          sourceWorktree: data.source.worktree,
          expectedSourceHead: sourceHead,
          message,
        },
        log,
      )
      if (!committed.ok) throw new DeliveryHalt(committed.error)
      sourceHead = committed.head
      sourceCommits.push(committed.commit)
      phase('commit', `已创建 ${committed.commit.shortSha} ${committed.commit.subject}`)
    }
    if (sourceCommits.length === 0) {
      halt('nothing_to_deliver', 'The source worktree has nothing to deliver.')
    }

    phase('pick', `正在 cherry-pick ${sourceCommits.length} 个提交`)
    const picked = await preparePickDelivery(
      {
        commonDir,
        deliveryId,
        token,
        mainWorktree,
        sourceWorktree: data.source.worktree,
        baseSha: data.baseSha,
        sourceHead,
        commits: sourceCommits.map((commit) => commit.sha),
      },
      log,
    )
    if (!picked.ok) {
      // Prepare may have died after creating the temp worktree (host restart,
      // timeout); abort without a path so the git extension derives it from the
      // delivery id, matching the renderer's `_pickAll` cleanup.
      const problems = await abortTemp(undefined)
      throw new DeliveryHalt(failureWithProblems(picked.error, problems))
    }
    state.picked = [...picked.picked]
    state.skippedEmpty = [...picked.skippedEmpty]
    if (picked.status === 'conflict') {
      tempWorktree = picked.tempWorktree
      const detail = [
        `conflict files:\n${picked.conflictFiles.join('\n')}`,
        ...(picked.conflictedCommit !== undefined
          ? [
              `conflicted commit: ${picked.conflictedCommit.shortSha} ${picked.conflictedCommit.subject}`,
            ]
          : []),
      ].join('\n')
      phase('pick', `冲突（${picked.conflictFiles.length} 个文件）`)
      const problems = await abortTemp(picked.tempWorktree)
      tempWorktree = undefined
      throw new DeliveryHalt(
        failureWithProblems(
          {
            code: 'conflict',
            message: 'Cherry-picking the delivery commit conflicted.',
            detail,
          },
          problems,
        ),
      )
    }
    tempWorktree = picked.tempWorktree
    phase('pick', `已 cherry-pick ${picked.picked.length} 个提交`)

    pushAttempted = true
    let promoted = false
    let lastPushFailure: DeliveryFailure | undefined
    const pushDeadline = Date.now() + PUSH_TOTAL_BUDGET_MS

    const markRemotePushConfirmed = async (): Promise<void> => {
      state.pushedSha = picked.tempHead
      state.mainHead = (await currentHead(data.repository.mainWorktree, log)) ?? picked.tempHead
      tempWorktree = undefined
      recordProblems(await abortTemp(picked.tempWorktree))
      promoted = true
      phase('push', `已在远端确认 ${picked.tempHead.slice(0, 8)}（${data.repository.upstreamRef}）`)
    }

    for (let attempt = 1; attempt <= PUSH_ATTEMPTS && !promoted; attempt++) {
      if (attempt > 1) {
        // Never promote again without checking the remote first: the previous
        // push may have landed even though verification failed. Only a
        // confirmed fetch that still lacks the commit makes a retry safe.
        let remote: RemoteDeliveryState = 'unknown'
        for (let check = 1; check <= PUSH_RECHECK_ATTEMPTS; check++) {
          phase('push', `正在复核远端推送状态（第 ${check}/${PUSH_RECHECK_ATTEMPTS} 次）`)
          remote = await remoteDeliveryState(mainWorktree, picked.tempHead, log)
          if (remote !== 'unknown') break
          if (check >= PUSH_RECHECK_ATTEMPTS || Date.now() >= pushDeadline) break
          await wait(PUSH_RETRY_DELAY_MS * check)
        }
        if (remote === 'pushed') {
          await markRemotePushConfirmed()
          break
        }
        if (remote !== 'local_only') {
          throw new DeliveryHalt(
            failureWithProblems(
              lastPushFailure ?? {
                code: 'push_unverified',
                message: 'The push could not be verified.',
              },
              [
                `Could not verify the remote branch after ${PUSH_RECHECK_ATTEMPTS} attempt(s); refusing to push again.`,
              ],
            ),
          )
        }
      }
      if (Date.now() >= pushDeadline) {
        throw new DeliveryHalt(
          failureWithProblems(
            lastPushFailure ?? {
              code: 'push_unverified',
              message: 'The push could not be verified.',
            },
            ['The push verification retry budget was exhausted.'],
          ),
        )
      }

      phase(
        'push',
        attempt === 1
          ? `正在推送 main 到 ${data.repository.upstreamRef}`
          : `正在重新推送 main（第 ${attempt}/${PUSH_ATTEMPTS} 次）`,
      )
      const push = await promoteAndPushDelivery(
        {
          commonDir,
          deliveryId,
          token,
          mainWorktree,
          targetBranch,
          baseSha: data.baseSha,
          tempWorktree: picked.tempWorktree,
          tempHead: picked.tempHead,
          remote: data.repository.remote,
          upstreamRef: data.repository.upstreamRef,
        },
        log,
      )
      if (push.ok) {
        state.pushedSha = push.pushedSha
        state.mainHead = push.mainHead
        tempWorktree = undefined
        promoted = true
        phase('push', `已推送 ${push.pushedSha.slice(0, 8)} 到 ${push.remoteRef}`)
        break
      }
      if (push.error.code !== 'push_unverified') throw new DeliveryHalt(push.error)
      lastPushFailure = push.error
    }
    if (!promoted) {
      throw new DeliveryHalt(
        failureWithProblems(
          lastPushFailure ?? {
            code: 'push_unverified',
            message: 'The push could not be verified.',
          },
          ['The push verification retry budget was exhausted.'],
        ),
      )
    }
    state.delivered = [...state.picked]

    phase('sync', '正在同步 worktrees')
    const synced = await syncWorktreesDelivery(
      {
        commonDir,
        deliveryId,
        token,
        mainWorktree,
        newHead: state.pushedSha ?? picked.tempHead,
        sourceWorktree: data.source.worktree,
        expectedSourceHead: sourceHead,
        ...(tempWorktree !== undefined ? { tempWorktree } : {}),
      },
      log,
    )
    if (!synced.ok) throw new DeliveryHalt(synced.error)
    state.worktrees = [...synced.results]
    phase('sync', `已检查 ${synced.results.length} 个 worktree`)
    return buildOutcome(state, true, dryRun)
  } catch (err) {
    state.error =
      err instanceof DeliveryHalt
        ? err.failure
        : {
            code: 'git_failed',
            message: 'The delivery stopped unexpectedly.',
            detail: errorMessage(err),
          }
  } finally {
    // Every cleanup step is independent: a failing abort, observer callback,
    // restore or lock release must never prevent the steps after it, and a
    // failure after an error is appended to that error's detail. The lock
    // release lives in the innermost finally so it always runs.
    try {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (state.error !== undefined && tempWorktree !== undefined) {
        recordProblems(await abortTemp(tempWorktree))
        tempWorktree = undefined
      }
    } finally {
      try {
        // Renderer semantics: restore main only for failures before promotion.
        // A failed or unverified push may already be on the remote, so main must
        // stay where promote left it.
        if (
          state.error !== undefined &&
          !pushAttempted &&
          mainHeadBefore !== undefined &&
          mainHeadAfter !== undefined &&
          mainHeadBefore !== mainHeadAfter &&
          mainWorktree !== undefined &&
          targetBranch !== undefined
        ) {
          recordProblems(
            await restoreMain(mainHeadBefore, mainHeadAfter, mainWorktree, targetBranch),
          )
        }
      } finally {
        recordProblems(await releaseLock())
      }
    }
  }

  return buildOutcome(state, false, dryRun)
}

const buildOutcome = (
  state: PipelineState,
  ok: boolean,
  dryRun: boolean,
): HeadlessDeliveryOutcome => ({
  ok,
  dryRun,
  phases: [...state.phases],
  ...(state.plan !== undefined ? { plan: state.plan } : {}),
  ...(state.error !== undefined ? { error: state.error } : {}),
  picked: [...state.picked],
  delivered: [...state.delivered],
  skippedEmpty: [...state.skippedEmpty],
  ...(state.pushedSha !== undefined ? { pushedSha: state.pushedSha } : {}),
  ...(state.mainHead !== undefined ? { mainHead: state.mainHead } : {}),
  worktrees: [...state.worktrees],
  ...(state.lockOwner !== undefined ? { lockOwner: state.lockOwner } : {}),
  cleanupWarnings: [...state.cleanupWarnings],
})
