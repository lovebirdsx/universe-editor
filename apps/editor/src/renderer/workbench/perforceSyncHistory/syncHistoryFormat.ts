/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure formatting for the Perforce Sync History page.
 *
 *  The host cannot reach the extension's own formatters (`formatBytes` /
 *  `formatScanElapsed` live in the extension host), so the numbers are mirrored
 *  here. What is NOT mirrored is any judgement: `io === undefined` renders as
 *  "unavailable" and never as 0 B, and `diskWrites` always carries the `≥` —
 *  both are stated in the wire contract
 *  (`packages/extensions-common/src/contracts/perforceSyncHistory.ts`).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type {
  P4SyncCountsDto,
  P4SyncOutcomeDto,
  P4SyncRunDetailDto,
  P4SyncRunDto,
  P4SyncTriggerDto,
} from '@universe-editor/extensions-common'

/**
 * Elapsed time of a run. One decimal below ten seconds: a get that took 400ms
 * and one that took 900ms are different answers to "why is this slow", and the
 * extension's whole-second `formatScanElapsed` would read as `0s` for both.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`
}

/** A cumulative byte count (`842KB`, `1.2GB`) — mirrors the extension's own
 *  `processIo.formatBytes`, which is where the sampled totals come from. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)}KB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)}MB`
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

/**
 * The revision a run pulled, as a sentence rather than as p4 syntax. Mirrors
 * `p4StatusBar.syncTargetLabel` (the status-bar tooltip says the same thing about
 * the same spec): `#4` and a date pass through verbatim because they are already
 * their own clearest names, and dressing them up would risk naming a revision the
 * run did not fetch.
 */
export function formatTarget(spec: string): string {
  // Identity, not truthiness: `''` is a real value (the per-file get).
  if (spec === '') {
    return localize('perforceSyncHistory.target.picked', 'the selected files')
  }
  if (spec.toLowerCase() === '#head') {
    return localize('perforceSyncHistory.target.head', 'the latest revision')
  }
  const changelist = /^@(\d+)$/.exec(spec)?.[1]
  if (changelist !== undefined) {
    return localize('perforceSyncHistory.target.changelist', 'changelist {0}', { 0: changelist })
  }
  return spec
}

export function outcomeLabel(outcome: P4SyncOutcomeDto): string {
  switch (outcome) {
    case 'applied':
      return localize('perforceSyncHistory.outcome.applied', 'Updated')
    case 'upToDate':
      return localize('perforceSyncHistory.outcome.upToDate', 'Already up to date')
    case 'failed':
      return localize('perforceSyncHistory.outcome.failed', 'Failed')
    case 'cancelled':
      return localize('perforceSyncHistory.outcome.cancelled', 'Cancelled')
    case 'declined':
      return localize('perforceSyncHistory.outcome.declined', 'Not run')
    default:
      // Exit 0, nothing applied, no up-to-date line: p4 never made this run
      // legible. Naming it beats inventing an outcome.
      return localize('perforceSyncHistory.outcome.unrecognized', 'Unrecognized')
  }
}

/** The engine, including the δ-attempted-then-fell-back case, which is a
 *  different answer from "δ was never configured". */
export function engineLabel(run: P4SyncRunDto): string {
  if (run.engine === 'p4delta') {
    return localize('perforceSyncHistory.engine.p4delta', 'p4delta (δ)')
  }
  if (run.engineFallback === true) {
    return localize('perforceSyncHistory.engine.fallback', 'p4 (δ was tried)')
  }
  return localize('perforceSyncHistory.engine.p4', 'p4')
}

export function triggerLabel(trigger: P4SyncTriggerDto): string {
  switch (trigger) {
    case 'statusBar':
      return localize('perforceSyncHistory.trigger.statusBar', 'Status bar revision chip')
    case 'graph':
      return localize('perforceSyncHistory.trigger.graph', 'Perforce Graph')
    case 'timeline':
      return localize('perforceSyncHistory.trigger.timeline', 'Timeline')
    case 'command':
      return localize('perforceSyncHistory.trigger.command', 'Command palette')
    case 'recovery':
      return localize('perforceSyncHistory.trigger.recovery', 'Automatic retry')
    default:
      return localize('perforceSyncHistory.trigger.explorer', 'Explorer')
  }
}

/** The per-file counts as one line, dropping the zeroes: a run that refused
 *  nothing should not list five kinds of nothing. Each key is spelled out as a
 *  literal rather than looped over, so the zh-CN coverage test can see it. */
export function formatCounts(counts: P4SyncCountsDto): string {
  const parts: string[] = []
  // `applied` 含已跟踪的同步删除（它确实是 applied），但「更新」不该把删除算进去。
  // 旧记录没有子计数：按 0 处理，保持原样。
  const trackedDeleted = counts.trackedDeleted ?? 0
  const updated = Math.max(0, counts.applied - trackedDeleted)
  if (updated > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.applied', '{0} updated', { 0: String(updated) }),
    )
  }
  // 已跟踪删除：目标修订里没有了，同一次同步把它从磁盘上删掉。与未跟踪删除分两句，
  // 因为「depot 要求的删除」和「清理 depot 从不跟踪的本地文件」是两件事。
  if (trackedDeleted > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.trackedDeleted', '{0} tracked file(s) deleted', {
        0: String(trackedDeleted),
      }),
    )
  }
  if (counts.refusedModified > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.refusedModified', '{0} with local changes', {
        0: String(counts.refusedModified),
      }),
    )
  }
  if (counts.refusedOverwrite > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.refusedOverwrite', '{0} blocked by a file on disk', {
        0: String(counts.refusedOverwrite),
      }),
    )
  }
  if (counts.keptOpen > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.keptOpen', '{0} open for edit', {
        0: String(counts.keptOpen),
      }),
    )
  }
  if (counts.mustResolve > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.mustResolve', '{0} need merging', {
        0: String(counts.mustResolve),
      }),
    )
  }
  if (counts.handoff > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.handoff', '{0} handed to p4 as a batch', {
        0: String(counts.handoff),
      }),
    )
  }
  // `--delete-untracked` 删掉的本地文件：它们不是「同步下来的文件」，所以单独一句，
  // 且只在真的删过时出现（旧记录没有这一项，按 0 处理）。
  if ((counts.untrackedDeleted ?? 0) > 0) {
    parts.push(
      localize('perforceSyncHistory.counts.untrackedDeleted', '{0} untracked file(s) deleted', {
        0: String(counts.untrackedDeleted),
      }),
    )
  }
  return parts.length > 0
    ? parts.join(' · ')
    : localize('perforceSyncHistory.counts.none', 'nothing to transfer')
}

/** A run's disk writes. Always a lower bound: the count comes from the
 *  renderer's file watcher, which truncates and honours `files.watcherExclude`. */
export function formatDiskWrites(diskWrites: number): string {
  return localize('perforceSyncHistory.diskWrites', '≥{0} file events', { 0: String(diskWrites) })
}

/**
 * The p4 command processes a run started, with its native / δ split.
 *
 * Three facts have to survive here, the same way `io`'s does: a record written
 * before the field existed reads as "not collected" rather than as 0; an
 * incomplete count is stated as a lower bound (`≥`) and only ever alongside the
 * explanation — never as a bare number; and a 0 that is only a lower bound is
 * not printed as a total at all (it would claim the run asked p4 nothing).
 */
export function p4CallsLabel(run: P4SyncRunDto): string {
  const calls = run.p4Calls
  if (calls === undefined) {
    return localize(
      'perforceSyncHistory.p4Calls.unavailable',
      'not collected (this record predates the field)',
    )
  }
  const total = calls.native + calls.p4delta
  if (!calls.complete && total === 0) {
    return localize('perforceSyncHistory.p4Calls.incomplete', 'not fully collected')
  }
  const split = { 0: String(total), 1: String(calls.native), 2: String(calls.p4delta) }
  return calls.complete
    ? localize('perforceSyncHistory.p4Calls.exact', '{0} p4 command(s) ({1} native · {2} δ)', split)
    : localize(
        'perforceSyncHistory.p4Calls.atLeast',
        '≥{0} p4 command(s) ({1} native · {2} δ, not fully collected)',
        split,
      )
}

/** The list row's compact form of {@link p4CallsLabel}, or undefined when the
 *  record has nothing to say — the rows are already dense. */
export function p4CallsRowLabel(run: P4SyncRunDto): string | undefined {
  const calls = run.p4Calls
  if (calls === undefined) return undefined
  const total = calls.native + calls.p4delta
  if (!calls.complete && total === 0) {
    return localize('perforceSyncHistory.p4Calls.unknown', 'p4 calls unknown')
  }
  return calls.complete
    ? localize('perforceSyncHistory.p4Calls.rowExact', '{0} p4 calls', { 0: String(total) })
    : localize('perforceSyncHistory.p4Calls.rowAtLeast', '≥{0} p4 calls', { 0: String(total) })
}

/**
 * δ 那半边的调用来路：契约里的命令类别 → 次数，按次数降序（同数按命令名）。
 *
 * 类别名**不翻译**：`sync` / `ignores` / `fstat` 就是命令行上的那些词，译名只会让这一行与
 * p4delta 日志、与脚本对不上。缺席（老引擎不发 `p4CallsByCommand`，或这一跑一个 `command`
 * 事件都没有）= 「未采集」，与「0 次」是两码事，所以返回 undefined 而不是空串。
 *
 * 是否下界看 `p4deltaByCommandComplete`，**不看 `complete`**：总数为确数时分类仍可能只是下界
 * （老引擎只发总数，分类退回事件流已观测到的那一份），两者必须分开说——与 {@link p4CallsLabel}
 * 是同一条口径。
 */
export function p4CommandBreakdown(run: P4SyncRunDto): string | undefined {
  const calls = run.p4Calls
  const byCommand = calls?.p4deltaByCommand
  if (calls === undefined || byCommand === undefined) return undefined
  const entries = Object.entries(byCommand)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  if (entries.length === 0) return undefined
  const joined = entries.map(([command, count]) => `${command} ${count}`).join(' · ')
  return calls.p4deltaByCommandComplete === true
    ? joined
    : localize(
        'perforceSyncHistory.p4Calls.byCommandLowerBound',
        '{0} (lower bound — not a verified per-command tally)',
        { 0: joined },
      )
}

function countsTotal(counts: P4SyncCountsDto): number {
  return (
    counts.applied +
    counts.refusedModified +
    counts.refusedOverwrite +
    counts.keptOpen +
    counts.mustResolve +
    counts.handoff +
    // 已从 `applied` 里扣掉，所以这里不会重复计数；算进来才能让「只删了未跟踪文件」的一轮
    // 不被判成「什么也没发生」。`trackedDeleted` 是 applied 的子集，**绝不能**再加一次。
    (counts.untrackedDeleted ?? 0)
  )
}

/**
 * The counts as one line, or undefined when the run produced none worth showing.
 *
 * A run that failed or was cancelled can still carry an all-zero summary — p4
 * reported nothing before it aborted — and printing that as "nothing to
 * transfer" would claim there was nothing to get, which is the opposite of a run
 * that was refused work. Only a run that really finished with nothing to do
 * (`upToDate`) may say so.
 */
export function countsLine(run: P4SyncRunDto): string | undefined {
  const counts = run.counts
  if (counts === undefined) return undefined
  if (countsTotal(counts) > 0 || run.outcome === 'upToDate') return formatCounts(counts)
  return undefined
}

/**
 * What to print for the per-file facts of a run. The reasons a run has none are
 * not the same sentence: a declined run never spawned p4 at all, while a failed
 * or cancelled one ran and p4 just never reported. "this get never ran" on a
 * failed run would be plainly false.
 */
export function filesLabel(run: P4SyncRunDto): string {
  const line = countsLine(run)
  if (line !== undefined) return line
  return run.outcome === 'declined'
    ? localize('perforceSyncHistory.notRun', 'this get never ran')
    : localize('perforceSyncHistory.notReported', 'not reported by p4')
}

/** The run's scope, one path per line, with the omitted tail counted rather than
 *  dropped silently. Detail only — the list rows do not show a scope — and the
 *  count is the DTO's own `scopeOmitted`, which is the one number that knows
 *  what the extension's per-entry cap dropped. */
export function scopeLines(detail: P4SyncRunDetailDto): { paths: string[]; omitted: number } {
  return { paths: detail.scope.map((p) => p.path), omitted: detail.scopeOmitted }
}
