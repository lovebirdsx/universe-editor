/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpCodexAutoReviewGuard — says so when a Codex session's approvals cannot be
 *  reviewed at all.
 *
 *  Codex's "Auto review" mode routes every sandbox escalation to a reviewer
 *  model: its own built-in `codex-auto-review`, sent through whatever provider
 *  is configured. A custom provider (the gateway, or a hand-written
 *  `[model_providers.*]` entry) only answers for the slugs it defines, so the
 *  reviewer request comes back 403 and codex refuses to run the command — "a
 *  review failure, not a determination that the action is unsafe", and it must
 *  not be bypassed. Every action that needs an approval (writing `.git`, writing
 *  outside the workspace, network access) then fails for the whole session,
 *  which reads as the agent mysteriously refusing to commit.
 *
 *  The editor cannot supply the reviewer model, so it names the cause and offers
 *  the one fix it can apply itself: switch that session to "Workspace access",
 *  where the same escalation asks the user instead.
 *
 *  Availability is cached per host with lazy background resolution, mirroring
 *  `acpSessionProviderContext` — the same credential reverse lookup, asked a
 *  different question.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  constObservable,
  createDecorator,
  createNamedLogger,
  Disposable,
  ILoggerService,
  INotificationService,
  InstantiationType,
  localize,
  observableValue,
  registerSingleton,
  Severity,
  type IDisposable,
  type ILogger,
  type INotificationHandle,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { AgentActiveAuth } from '../../../../shared/ai/agentActiveAuth.js'
import { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'
import type { IAcpSession } from './acpSessionModel.js'

const CODEX_AGENT_ID = 'codex'

/** The config option carrying the session's approval/sandbox preset. */
export const MODE_CONFIG_ID = 'mode'

/** Codex's "Auto review" preset — the one whose approvals go to the reviewer. */
export const CODEX_AUTO_REVIEW_MODE_ID = 'agent'

/** "Workspace access": the same sandbox, but approvals ask the user. */
const CODEX_WORKSPACE_WRITE_MODE_ID = 'workspace-write'

/**
 * Whether the reviewer model codex asks for can be served here. Subscriptions
 * and the official API key talk to OpenAI, which defines it; a custom provider
 * answers only for the slugs it declares, and `codex-auto-review` is codex's own
 * built-in reviewer — so a `provider` binding is the unavailable case.
 */
export type AutoReviewAvailability = 'available' | 'unavailable' | 'unknown'

/** Pure classifier for one credential binding. */
export function autoReviewAvailabilityFor(
  auth: AgentActiveAuth | undefined,
): AutoReviewAvailability {
  if (auth === undefined) return 'unknown'
  return auth.kind === 'provider' ? 'unavailable' : 'available'
}

export interface IAcpCodexAutoReviewGuard {
  readonly _serviceBrand: undefined
  /**
   * Synchronous snapshot for an agent on one host. `'available'` for every agent
   * but codex, and for a binding with nothing to review; a cold key resolves in
   * the background and reports through the observable form.
   */
  getAutoReviewAvailability(agentId: string, authority?: string): AutoReviewAvailability
  /**
   * Observable form of the same value, stable per (agent, host) so callers can
   * pass it straight to `useObservable` / `autorun`.
   */
  observeAutoReviewAvailability(
    agentId: string,
    authority?: string,
  ): IObservable<AutoReviewAvailability>
  /**
   * Watch a live session and warn while it sits on Auto review with the reviewer
   * unservable — covering the initial mode, a later switch into it, and the mode
   * being pushed back on reconnect. The warning withdraws once the session
   * leaves that combination, and again when the watcher is disposed (session
   * closed). Read-only previews are never watched: there is no fix to offer.
   */
  watchSession(session: IAcpSession): IDisposable
  /** Re-resolve every host seen so far. */
  refresh(): Promise<void>
}

export const IAcpCodexAutoReviewGuard =
  createDecorator<IAcpCodexAutoReviewGuard>('acpCodexAutoReviewGuard')

/** Every agent but codex has nothing to guard here. */
const AVAILABLE = constObservable<AutoReviewAvailability>('available')

/**
 * One entry per host ('local' included). Only codex is ever resolved, so the
 * authority alone identifies a key; entries live as long as the window, like the
 * cost-attribution contexts they mirror.
 */
interface HostEntry {
  readonly authority: string | undefined
  readonly value: ISettableObservable<AutoReviewAvailability>
}

export class AcpCodexAutoReviewGuard extends Disposable implements IAcpCodexAutoReviewGuard {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _hosts = new Map<string, HostEntry>()
  /**
   * Session → the warning currently on screen for it. Kept so the warning can be
   * taken down when its cause goes away (the user switches mode, or the
   * credential changes back): a sticky toast left standing after the fix would
   * keep claiming failures that no longer happen.
   */
  private readonly _warnings = new WeakMap<IAcpSession, string>()
  private _resolving: Promise<void> | undefined
  /**
   * A host registered while a resolution was already in flight. That pass
   * snapshots the map after its first await, so the new host would miss it — and
   * the getter never asks again once the key exists.
   */
  private _hostGrewDuringResolve = false
  /** A credential change that landed mid-pass; another pass must follow. */
  private _refreshPending = false

  constructor(
    @ICodexConfigService private readonly _codexConfig: ICodexConfigService,
    @INotificationService private readonly _notification: INotificationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'acpCodexAutoReviewGuard',
      name: 'ACP Codex Auto Review Guard',
    })
    // A login, a credential switch or a hand edit — on this host or any
    // connected remote — can all change the verdict.
    this._register(this._codexConfig.onDidChangeAuth(() => void this.refresh()))
  }

  getAutoReviewAvailability(agentId: string, authority?: string): AutoReviewAvailability {
    if (agentId !== CODEX_AGENT_ID) return 'available'
    return this._hostFor(authority).value.get()
  }

  observeAutoReviewAvailability(
    agentId: string,
    authority?: string,
  ): IObservable<AutoReviewAvailability> {
    if (agentId !== CODEX_AGENT_ID) return AVAILABLE
    return this._hostFor(authority).value
  }

  watchSession(session: IAcpSession): IDisposable {
    if (session.agentId !== CODEX_AGENT_ID) return Disposable.None
    // A read-only preview (someone else's session, opened from another worktree)
    // accepts no config write — `setConfigOption` is a silent no-op — so warning
    // here would offer a fix the editor cannot apply, and the read-only session
    // is not the one the user is driving anyway.
    if (session.readOnly) return Disposable.None
    const availability = this.observeAutoReviewAvailability(session.agentId, session.authority)
    const run = autorun((r) => {
      const danger =
        availability.read(r) === 'unavailable' &&
        session.configOptions.read(r).find((option) => option.id === MODE_CONFIG_ID)
          ?.currentValue === CODEX_AUTO_REVIEW_MODE_ID
      const shown = this._warnings.get(session)
      if (danger && shown === undefined) {
        this._warnings.set(session, this._warn(session).id)
      } else if (!danger && shown !== undefined) {
        this._withdraw(session, shown)
      }
    })
    // The session is going away: its warning has nothing left to describe.
    return {
      dispose: () => {
        run.dispose()
        const shown = this._warnings.get(session)
        if (shown !== undefined) this._withdraw(session, shown)
      },
    }
  }

  private _withdraw(session: IAcpSession, id: string): void {
    this._warnings.delete(session)
    this._notification.dismiss(id)
  }

  private _hostFor(authority: string | undefined): HostEntry {
    const key = authority ?? ''
    const existing = this._hosts.get(key)
    if (existing !== undefined) return existing
    // 'unknown' until resolved: fail open, so a slow or unreadable credential
    // never accuses the session of a broken reviewer.
    const entry: HostEntry = {
      authority,
      value: observableValue<AutoReviewAvailability>('acp.codex.autoReviewAvailability', 'unknown'),
    }
    this._hosts.set(key, entry)
    if (this._resolving !== undefined) this._hostGrewDuringResolve = true
    void this.refresh()
    return entry
  }

  /**
   * Keep passing until nothing arrived mid-pass — a host registered while the
   * map was being walked ({@link _hostGrewDuringResolve}), or a credential change
   * that landed during it ({@link _refreshPending}), which would otherwise leave
   * the verdicts stale until the next unrelated event.
   */
  private async _resolveLoop(): Promise<void> {
    do {
      this._hostGrewDuringResolve = false
      this._refreshPending = false
      await this._doResolve()
    } while (this._hostGrewDuringResolve || this._refreshPending)
  }

  refresh(): Promise<void> {
    if (this._resolving !== undefined) {
      this._refreshPending = true
      return this._resolving
    }
    const run = this._resolveLoop().finally(() => {
      this._resolving = undefined
    })
    this._resolving = run
    return run
  }

  private async _doResolve(): Promise<void> {
    for (const { authority, value } of [...this._hosts.values()]) {
      let next: AutoReviewAvailability
      try {
        next = autoReviewAvailabilityFor(await this._codexConfig.resolveActiveAuth(authority))
      } catch (err) {
        this._logger.warn(`resolveActiveAuth failed: ${(err as Error).message}`)
        next = 'unknown'
      }
      value.set(next, undefined)
    }
  }

  private _warn(session: IAcpSession): INotificationHandle {
    this._logger.warn(
      `codex session ${session.id} runs Auto review on a custom provider — its approval reviewer cannot be served, so escalated actions will fail`,
    )
    return this._notification.notify({
      severity: Severity.Warning,
      sticky: true,
      message: localize(
        'acp.codex.autoReviewUnavailable',
        'This session uses Auto review, but Codex is bound to a custom provider here: the reviewer model "codex-auto-review" is not one it serves, so every action that needs an approval will fail. Switch to "Workspace access" to approve them yourself.',
      ),
      actions: [
        {
          label: localize('acp.codex.autoReviewUnavailable.switch', 'Switch to "Workspace access"'),
          run: () => void this._switchToWorkspaceAccess(session),
        },
      ],
    })
  }

  private async _switchToWorkspaceAccess(session: IAcpSession): Promise<void> {
    try {
      await session.setConfigOption(MODE_CONFIG_ID, CODEX_WORKSPACE_WRITE_MODE_ID)
    } catch (err) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize('agent.configOption.failed', 'Failed to apply option: {error}', {
          error: (err as Error).message,
        }),
      })
    }
  }
}

registerSingleton(IAcpCodexAutoReviewGuard, AcpCodexAutoReviewGuard, InstantiationType.Delayed)
