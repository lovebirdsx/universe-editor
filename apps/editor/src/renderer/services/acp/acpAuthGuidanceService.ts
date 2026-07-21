/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAuthGuidanceService — surfaces "this agent needs authentication" prompts as
 *  actionable notifications that deep-link to Agent Settings. Two entry points:
 *  a one-shot prompt when a session fails to start with an auth error, and a
 *  cooldown-throttled prompt wired to a live session's `onDidRequireAuth`.
 *
 *  Extracted from AcpSessionService (roadmap 06 · task 1): the facade should not
 *  own auth-cooldown notification state nor the `ICommandService` dependency it
 *  only used to open Agent Settings. See [[async-session-create]].
 *--------------------------------------------------------------------------------------------*/

import {
  ICommandService,
  INotificationService,
  InstantiationType,
  Severity,
  createDecorator,
  localize,
  registerSingleton,
} from '@universe-editor/platform'

/** Minimum gap between repeated auth prompts for one wired session. */
const AUTH_NOTIFICATION_COOLDOWN_MS = 10_000

export interface IAcpAuthGuidanceService {
  readonly _serviceBrand: undefined
  /**
   * A session failed to start because it has no usable credentials. Point the
   * user straight at the Authentication panel instead of a dead-end error toast.
   */
  promptSessionStartAuth(): void
  /**
   * Returns a handler for a live session's `onDidRequireAuth`. The returned
   * callback throttles repeat prompts by {@link AUTH_NOTIFICATION_COOLDOWN_MS}
   * (state is per returned handler, i.e. per wired session).
   */
  createSessionAuthPrompt(agentId: string): () => void
}

export const IAcpAuthGuidanceService =
  createDecorator<IAcpAuthGuidanceService>('acpAuthGuidanceService')

export class AcpAuthGuidanceService implements IAcpAuthGuidanceService {
  declare readonly _serviceBrand: undefined

  constructor(
    @INotificationService private readonly _notification: INotificationService,
    @ICommandService private readonly _commands: ICommandService,
  ) {}

  promptSessionStartAuth(): void {
    this._notify(
      localize('acp.session.authRequired', 'This agent needs authentication before it can start.'),
    )
  }

  createSessionAuthPrompt(agentId: string): () => void {
    let lastShownAt = 0
    return () => {
      const now = Date.now()
      if (now - lastShownAt < AUTH_NOTIFICATION_COOLDOWN_MS) return
      lastShownAt = now
      this._notify(
        localize(
          'acp.session.authRequired',
          'This agent needs authentication before it can respond.',
        ),
        agentId,
      )
    }
  }

  private _notify(message: string, agentId?: string): void {
    this._notification.notify({
      severity: Severity.Warning,
      message,
      actions: [
        {
          label: localize('acp.session.openAuth', 'Open Agent Settings'),
          run: () => {
            void this._commands.executeCommand(
              'workbench.action.agent.openSettings',
              ...(agentId !== undefined ? [agentId] : []),
            )
          },
        },
      ],
    })
  }
}

registerSingleton(IAcpAuthGuidanceService, AcpAuthGuidanceService, InstantiationType.Delayed)
