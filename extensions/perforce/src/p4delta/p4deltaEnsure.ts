/**
 * The decision of whether this session should download a managed p4delta, and
 * the wiring that runs it in the background.
 *
 * δ is an optimization that is optional EVERYWHERE else in this extension: every
 * refusal is a log line, and a machine without δ keeps running on native p4. This
 * module is the one place that spends network on it, so it is deliberately
 * conservative about when it may:
 *
 *  - only on Windows x64 (upstream publishes no other asset), only with a
 *    managed root (no globalStoragePath = no place to install into), only with
 *    `perforce.p4delta.enabled` on, and — for the background run — only with
 *    `perforce.p4delta.autoInstall` on;
 *  - never when the session named an engine (env or `perforce.p4delta.path`) —
 *    that is an operator saying "this one is mine";
 *  - never when this session's `p4` is a script override and no engine was
 *    named: the gate refuses δ in that shape (`resolveP4deltaEngine`), so a
 *    managed copy could not be used by the session that paid for it. Not a
 *    correctness rule but a waste rule — no download for a binary that is
 *    guaranteed to sit unused;
 *  - never when the machine already has its own copy on PATH or in the Windows
 *    default location. Self-installed copies come first, and this module's whole
 *    job is to fill the gap for machines that have none;
 *  - and never more than once per throttle window (see p4deltaStore), because
 *    GitHub allows 60 unauthenticated API requests per hour per IP.
 *
 * `force` (the manual `perforce.p4delta.install` command) lifts the last four:
 * a user who asks for the managed copy gets it even if another one is on PATH,
 * even under a script override (where the copy is for the machine rather than
 * for this session), and even with automatic installation turned off — that
 * setting is precisely a request to do it by hand. Only the master switch still
 * stops it, because a switched-off engine makes the download pointless.
 */
import type { P4deltaStore, P4deltaStoreOptions, P4deltaSyncOutcome } from './p4deltaStore.js'
import { activeManagedP4delta, openP4deltaStore } from './p4deltaStore.js'
import { p4deltaNamedExplicitly, resolveP4deltaCommand } from './p4deltaService.js'
import type { P4deltaSource } from './p4deltaUpstream.js'

export interface P4deltaEnsureOptions {
  /** `<globalStoragePath>/p4delta`; the empty string disables the whole feature. */
  readonly root: string
  /** `perforce.p4delta.enabled` — the master switch. Off means the engine is not
   *  used at all, so a copy would serve nobody; even the manual command refuses. */
  readonly enabled: boolean
  /** `perforce.p4delta.autoInstall` — gates the BACKGROUND path only. Whoever
   *  turned it off is the person `perforce.p4delta.install` exists for. */
  readonly autoInstall: boolean
  readonly configuredPath: string
  /**
   * `resolveP4Command().prefixArgs.length > 0` — this session drives p4 through
   * a script. Injected rather than looked up so this module stays host-agnostic.
   */
  readonly p4IsScriptOverride?: boolean
  readonly source: P4deltaSource
  readonly log: (msg: string) => void
  /** Progress for the manual command's notification; the background path omits it. */
  readonly onProgress?: (received: number, total: number | undefined) => void
  /** User cancellation from the manual command; the background path omits it. */
  readonly signal?: AbortSignal
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly now?: () => number
  /** Injected by tests; defaults to the real store. */
  readonly makeStore?: (options: P4deltaStoreOptions) => P4deltaStore
}

export interface P4deltaEnsureResult {
  readonly outcome: P4deltaSyncOutcome
  /**
   * A version was activated, so the gate's answer may have changed and the
   * caller must re-resolve. False for every other outcome — including
   * `up-to-date`, which by definition leaves the pointer where it was.
   */
  readonly changed: boolean
}

/** Never throws: the caller runs this detached from any user action. */
export async function ensureP4delta(
  options: P4deltaEnsureOptions,
  force = false,
): Promise<P4deltaEnsureResult> {
  const skip = (reason: string): P4deltaEnsureResult => {
    options.log(`[perforce] p4delta auto-install: ${reason}`)
    return { outcome: { kind: 'skipped', reason }, changed: false }
  }

  if (options.root === '') return skip('no global storage for this host')
  if ((options.platform ?? process.platform) !== 'win32') {
    return skip('no p4delta build for this platform')
  }
  if (!options.enabled) return skip('p4delta is turned off by perforce.p4delta.enabled')
  if (!options.autoInstall && !force) {
    return skip('automatic installation is off; run the install command instead')
  }
  if (!force) {
    if (p4deltaNamedExplicitly(options.configuredPath)) {
      return skip('a p4delta was named explicitly')
    }
    if (options.p4IsScriptOverride === true) {
      return skip("this session's p4 is a script override; a managed copy would go unused")
    }
    const machine = resolveP4deltaCommand(options.configuredPath)
    if (machine !== undefined) {
      return skip(`this machine already has one (${machine.exe})`)
    }
  }

  try {
    const store = (options.makeStore ?? openP4deltaStore)({
      root: options.root,
      source: options.source,
      log: options.log,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.arch !== undefined ? { arch: options.arch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    })
    const hadManaged = activeManagedP4delta(options.root) !== undefined
    const outcome = await store.sync(
      force,
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
    // The store reports failures as settles, not rejections, so this is where
    // the reason reaches the log — the only surface the background path has.
    if (outcome.kind === 'failed') {
      options.log(`[perforce] p4delta auto-install failed: ${outcome.reason}`)
    } else if (outcome.kind === 'cancelled') {
      options.log('[perforce] p4delta auto-install cancelled')
    }
    // `installed` always means the pointer moved. The second case is another
    // window having finished an install while we were asking: the gate could
    // not see a managed copy when it last resolved, and now there is one.
    const changed = outcome.kind === 'installed' || (!hadManaged && store.activeExe() !== undefined)
    return { outcome, changed }
  } catch (err) {
    // The store does not throw; this is the last line for a caller that has
    // nobody to catch a rejection.
    const reason = err instanceof Error ? err.message : String(err)
    options.log(`[perforce] p4delta auto-install failed: ${reason}`)
    return { outcome: { kind: 'failed', reason }, changed: false }
  }
}
