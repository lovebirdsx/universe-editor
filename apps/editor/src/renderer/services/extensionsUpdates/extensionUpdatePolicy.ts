/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-update policy for the Extensions view: decides which pending updates may be
 *  installed without asking, which must wait, and when to look again. Pure and
 *  DI-free so the timing rules are testable without timers or a lifecycle.
 *--------------------------------------------------------------------------------------------*/

/** One installed extension with a pending update, as the policy sees it. */
export interface IAutoUpdateCandidate {
  readonly identifier: string
  /** The user has the extension enabled (a disabled one is never rewritten). */
  readonly enabled: boolean
  /** The user opted this extension out of automatic updates. */
  readonly optedOut: boolean
  /** Publish time of the offered version (epoch ms); undefined when unknown. */
  readonly publishedAt: number | undefined
}

export type AutoUpdateSkipReason = 'disabled' | 'optedOut' | 'delay'

export interface IAutoUpdateSkip {
  readonly identifier: string
  readonly reason: AutoUpdateSkipReason
}

export interface IAutoUpdatePlan {
  /** Identifiers to install automatically, in the order given. */
  readonly apply: readonly string[]
  readonly skipped: readonly IAutoUpdateSkip[]
  /**
   * Epoch ms at which the earliest deferred candidate becomes eligible, or
   * undefined when nothing was deferred — the caller re-arms a timer then.
   */
  readonly nextEligibleAt: number | undefined
}

/**
 * Split pending updates into "install now" and "wait". The publish delay is a
 * courtesy window against pulling a just-released bad version in automatically,
 * not a security gate — a candidate with no usable publish time is applied, and
 * every install still passes the full gate chain.
 */
export function planAutoUpdates(
  candidates: readonly IAutoUpdateCandidate[],
  options: { readonly now: number; readonly delayMs: number },
): IAutoUpdatePlan {
  const apply: string[] = []
  const skipped: IAutoUpdateSkip[] = []
  let nextEligibleAt: number | undefined

  for (const candidate of candidates) {
    if (!candidate.enabled) {
      skipped.push({ identifier: candidate.identifier, reason: 'disabled' })
      continue
    }
    if (candidate.optedOut) {
      skipped.push({ identifier: candidate.identifier, reason: 'optedOut' })
      continue
    }
    const eligibleAt =
      candidate.publishedAt === undefined ? undefined : candidate.publishedAt + options.delayMs
    if (eligibleAt !== undefined && options.now < eligibleAt) {
      skipped.push({ identifier: candidate.identifier, reason: 'delay' })
      nextEligibleAt =
        nextEligibleAt === undefined ? eligibleAt : Math.min(nextEligibleAt, eligibleAt)
      continue
    }
    apply.push(candidate.identifier)
  }

  return { apply, skipped, nextEligibleAt }
}

/** `IGalleryExtension.lastUpdated` is an ISO timestamp; undefined when absent/unparseable. */
export function parsePublishedAt(lastUpdated: string | undefined): number | undefined {
  if (lastUpdated === undefined) return undefined
  const parsed = Date.parse(lastUpdated)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Stable identity of a pending update set (order-independent). Used to gate
 * notifications: re-telling the user the same thing every check is noise.
 */
export function updateSetSignature(
  updates: readonly { readonly identifier: string; readonly toVersion: string }[],
): string {
  return updates
    .map((update) => `${update.identifier}@${update.toVersion}`)
    .sort()
    .join(',')
}
