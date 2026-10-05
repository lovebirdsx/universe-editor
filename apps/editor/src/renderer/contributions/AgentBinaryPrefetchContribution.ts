/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Idle-time maintenance of the native Claude / codex-acp binaries. Three phases,
 *  in this order (the order is load-bearing, see below):
 *    1. Sweeps stale (non-active) version dirs left by a previous upgrade — the
 *       predecessor binary is locked while a session runs, so cleanup is deferred
 *       to the next launch when its lock is gone. The local sweep always runs;
 *       when the active workspace is remote, that host's store is swept too.
 *    2. Aligns the managed-download tree with the editor's pinned version: an
 *       editor upgrade changes the pin while `.active` still names the old one, so
 *       without this the user keeps running the previous binary forever. It is a
 *       no-op unless the pin itself changed since the last alignment, so a version
 *       picked by hand survives. Follows the active workspace like the sweep: a
 *       remote workspace aligns that host's store. Gated on the version policy —
 *       under the locked `'pinned'` policy alignment always runs (the pin binding
 *       is not the user's to switch off), under `'manual'` only while
 *       `acp.autoUpgradeBinaries` is on — plus the local per-agent
 *       `acp.<agent>.source` being "download", and the e2e probe. Success is
 *       announced with the new version; failures are logged and retried next
 *       session.
 *    3. Background-prefetches the latest binary so a later upgrade activates
 *       instantly instead of waiting on a ~80MB download. Prefetch follows the
 *       active workspace: a remote workspace prefetches that host's managed store
 *       (never the local userData, which wouldn't be used), a local workspace
 *       keeps the existing local behavior. Prefetch runs only when
 *       `acp.prefetchBinaries` is enabled and never under the e2e probe (a fresh
 *       profile + no cache on every launch would otherwise race worker teardown
 *       with a multi-hundred-MB fetch). Local prefetch additionally requires the
 *       per-agent `acp.claude.source` / `acp.codex.source` to be "download";
 *       remote prefetch never consults source (managed download only).
 *  Sweeping before aligning is deliberate: the sweep's keep-set still names the
 *  pre-alignment active version, so the dir the running session uses survives this
 *  session and is reclaimed at the next launch — exactly the semantics a manual
 *  upgrade has (and on Windows the running binary still holds its lock anyway).
 *  Each authority (local included) is maintained at most once per session —
 *  workspace/connection events fire repeatedly, but booleans/Set dedupe them.
 *  Remote maintenance is gated on that authority being `connected`: the main-side
 *  getServiceProxy lazily brings the connection up on its first call, so running
 *  it against a not-yet-connected host would trigger an unrequested SSH connect /
 *  remote install. All failures are swallowed (best-effort, never disrupts the user).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  INotificationService,
  IWorkspaceService,
  type ILogger,
  ILoggerService,
  type IWorkbenchContribution,
  Severity,
  createNamedLogger,
  localize,
  runWhenIdle,
} from '@universe-editor/platform'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'
import { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'
import {
  IRemoteStatusService,
  type RemoteConnectionStatusDto,
} from '../../shared/ipc/remoteStatusService.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'
import { binaryVersionPolicy } from '../services/acp/binaryVersionPolicy.js'

/** The single call the alignment phase needs; both agent services satisfy it. */
interface IBundleSyncService {
  syncBundled(authority?: string): Promise<string | null>
}

export class AgentBinaryPrefetchContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  /** Remote authorities already maintained this session. */
  private readonly _maintained = new Set<string>()
  private readonly _connected = new Set<string>()
  /** The local sweep, started at most once; alignment/prefetch queue behind it. */
  private _localSweep: Promise<void> | undefined
  private _localMaintained = false
  /** True when the last connection-state seed failed and a retry is still available. */
  private _seedFailed = false
  /** True once the single on-demand re-seed has been consumed. */
  private _seedRetried = false

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IClaudeBinaryService private readonly _claude: IClaudeBinaryService,
    @ICodexBinaryService private readonly _codex: ICodexBinaryService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @INotificationService private readonly _notifications: INotificationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'agentBinaryPrefetch',
      name: 'Agent Binary Prefetch',
    })

    // Idle is only the initial trigger. Workspace hydration is an async IPC, so
    // `onDidChangeWorkspace` re-runs once it settles (and on every switch); a
    // remote authority whose connection is still bringing up is picked up when
    // `onDidChangeState` reports `connected`.
    this._register(runWhenIdle(globalThis, () => this._maintain()))
    this._register(this._workspace.onDidChangeWorkspace(() => this._maintain()))
    this._register(this._remoteStatus.onDidChangeState((s) => this._onState(s)))
    void this._seedConnections()
  }

  private async _seedConnections(): Promise<void> {
    try {
      const connections = await this._remoteStatus.getConnections()
      if (this._store.isDisposed) return
      for (const c of connections) {
        if (c.state === 'connected') this._connected.add(c.authority)
      }
      this._seedFailed = false
    } catch (err) {
      // Arm at most one on-demand retry (consumed in _maintain below). A
      // persistently-broken IPC read would otherwise turn the seed → maintain →
      // re-seed cycle into an unbounded self-retrigger loop that spams the log.
      if (!this._seedRetried) this._seedFailed = true
      this._logger.warn(`remote connection seed failed: ${String(err)}`)
    }
    this._maintain()
  }

  private _onState(status: RemoteConnectionStatusDto): void {
    if (status.state === 'connected') this._connected.add(status.authority)
    else this._connected.delete(status.authority)
    this._maintain()
  }

  private _maintain(): void {
    if (this._store.isDisposed) return

    // The local sweep is pure local disk work with no network; start it exactly
    // once no matter where the window ends up scoped (alignment and prefetch wait
    // on it before touching the same dirs).
    this._localSweep ??= this._sweepLocal()

    const authority = currentRemoteAuthority(this._workspace.current)
    if (authority === undefined) {
      if (this._localMaintained) return
      this._localMaintained = true
      void this._maintainLocal()
      return
    }

    if (this._maintained.has(authority)) return
    // Never let a background sweep bring up a connection the user didn't ask for.
    if (!this._connected.has(authority)) {
      // A transient seed failure would otherwise leave an already-connected
      // workspace unmaintained for the rest of the session — onDidChangeState is
      // a live emitter and does not replay history. getConnections is a passive
      // read, so re-seeding never brings a connection up. Retry exactly once:
      // _seedRetried bounds it so a persistently-failing read cannot loop.
      if (this._seedFailed && !this._seedRetried) {
        this._seedRetried = true
        this._seedFailed = false
        void this._seedConnections()
      }
      return
    }
    this._maintained.add(authority)
    void this._maintainRemote(authority)
  }

  private async _sweepLocal(): Promise<void> {
    try {
      await this._claude.cleanupStaleVersions()
    } catch (err) {
      this._logger.warn(`claude binary cleanup failed: ${String(err)}`)
    }
    try {
      await this._codex.cleanupStaleVersions()
    } catch (err) {
      this._logger.warn(`codex-acp binary cleanup failed: ${String(err)}`)
    }
  }

  private async _maintainLocal(): Promise<void> {
    await this._localSweep
    await this._alignLocal()
    await this._prefetchLocal()
  }

  private async _maintainRemote(authority: string): Promise<void> {
    try {
      await this._claude.cleanupStaleVersions(authority)
    } catch (err) {
      this._logger.warn(`claude binary cleanup failed on ${authority}: ${String(err)}`)
    }
    try {
      await this._codex.cleanupStaleVersions(authority)
    } catch (err) {
      this._logger.warn(`codex-acp binary cleanup failed on ${authority}: ${String(err)}`)
    }
    if (!this._alignGated()) {
      // Remote binaries are always managed download; the local source setting does
      // not cross the tunnel, so alignment never consults `acp.*.source` here.
      await this._alignAgent(this._claude, 'Claude', authority)
      await this._alignAgent(this._codex, 'Codex', authority)
    }
    if (this._prefetchGated()) return
    const policy = binaryVersionPolicy(this._config)
    try {
      await this._claude.prefetch(policy, authority)
    } catch (err) {
      this._logger.warn(`claude binary prefetch failed on ${authority}: ${String(err)}`)
    }
    try {
      await this._codex.prefetch(policy, authority)
    } catch (err) {
      this._logger.warn(`codex-acp binary prefetch failed on ${authority}: ${String(err)}`)
    }
  }

  private async _alignLocal(): Promise<void> {
    if (this._alignGated()) return
    // A system/custom binary isn't ours to switch, so the managed store is only
    // aligned when it is the one in use.
    if ((this._config.get<string>('acp.claude.source') ?? 'download') === 'download') {
      await this._alignAgent(this._claude, 'Claude')
    }
    if ((this._config.get<string>('acp.codex.source') ?? 'download') === 'download') {
      await this._alignAgent(this._codex, 'Codex')
    }
  }

  private async _alignAgent(
    service: IBundleSyncService,
    name: string,
    authority?: string,
  ): Promise<void> {
    const where = authority === undefined ? '' : ` on ${authority}`
    try {
      const version =
        authority === undefined ? await service.syncBundled() : await service.syncBundled(authority)
      if (version === null) return
      this._logger.info(`${name} binary auto-aligned to pinned ${version}${where}`)
      this._notifications.notify({
        severity: Severity.Info,
        message:
          authority === undefined
            ? localize(
                'agentBinary.autoUpgrade.local',
                'The {name} binary was switched to {version} to match the editor version.',
                { name, version },
              )
            : localize(
                'agentBinary.autoUpgrade.remote',
                'The {name} binary on {authority} was switched to {version} to match the editor version.',
                { name, authority, version },
              ),
      })
    } catch (err) {
      // Silent for the user on purpose: the next session retries, and a failed
      // background upgrade is not something they asked for or can act on.
      this._logger.warn(`${name} binary auto-alignment failed${where}: ${String(err)}`)
    }
  }

  private async _prefetchLocal(): Promise<void> {
    if (this._prefetchGated()) return
    const policy = binaryVersionPolicy(this._config)
    if ((this._config.get<string>('acp.claude.source') ?? 'download') === 'download') {
      try {
        await this._claude.prefetch(policy)
      } catch (err) {
        this._logger.warn(`claude binary prefetch failed: ${String(err)}`)
      }
    }
    if ((this._config.get<string>('acp.codex.source') ?? 'download') === 'download') {
      try {
        await this._codex.prefetch(policy)
      } catch (err) {
        this._logger.warn(`codex-acp binary prefetch failed: ${String(err)}`)
      }
    }
  }

  /**
   * True under the e2e probe: every worker launches a fresh profile with no cached
   * binary, so any real download here would race Playwright's worker teardown,
   * which isn't sized for a multi-hundred-MB fetch. Local sweeps stay safe (no
   * network); only the phases that may download are gated.
   */
  private _e2eProbeEnabled(): boolean {
    return typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
  }

  /**
   * The locked policy *is* the pin binding — the managed binary always runs the
   * version this build was made against — so alignment is not the user's to turn
   * off there; `acp.autoUpgradeBinaries` only governs the manual policy, where an
   * editor upgrade would otherwise silently replace a version the user picked.
   */
  private _alignGated(): boolean {
    if (this._e2eProbeEnabled()) return true
    if (binaryVersionPolicy(this._config) === 'pinned') return false
    if (this._config.get<boolean>('acp.autoUpgradeBinaries') === false) return true
    return false
  }

  private _prefetchGated(): boolean {
    if (this._e2eProbeEnabled()) return true
    if (this._config.get<boolean>('acp.prefetchBinaries') === false) return true
    return false
  }
}
