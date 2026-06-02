/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPermissionHandler — auto-approve policy + persistence helper.
 *
 *  The interactive flow (presenting the request to the user) lives in
 *  AcpSessionService so each session can render an inline card rather than
 *  a global modal. This helper only:
 *    - decides whether a request can be silently approved against
 *      `acp.permissions.autoApprove`
 *    - records an `allow_always` decision back into the Memory layer of the
 *      same setting (so subsequent matching requests short-circuit too).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  createDecorator,
  IConfigurationService,
  InstantiationType,
  registerSingleton,
} from '@universe-editor/platform'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'

export interface IAcpPermissionHandler {
  readonly _serviceBrand: undefined
  /**
   * If the request's `toolCall.kind` is in the user's autoApprove list, return
   * a `selected` result naming the first `allow_*` option. Returns `undefined`
   * when the request must be presented to the user.
   */
  tryAutoApprove(params: RequestPermissionRequest): RequestPermissionResponse | undefined
  /** Persist `kind` into the Memory layer of `acp.permissions.autoApprove`. */
  persistAllow(kind: string): void
}

export const IAcpPermissionHandler = createDecorator<IAcpPermissionHandler>('acpPermissionHandler')

export class AcpPermissionHandler implements IAcpPermissionHandler {
  declare readonly _serviceBrand: undefined

  constructor(@IConfigurationService private readonly _config: IConfigurationService) {}

  tryAutoApprove(params: RequestPermissionRequest): RequestPermissionResponse | undefined {
    const kind = params.toolCall.kind
    if (!kind) return undefined
    if (!this._allowList().has(kind)) return undefined
    const allow = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
    if (!allow) return undefined
    return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }

  persistAllow(kind: string): void {
    const current = this._config.get<unknown>('acp.permissions.autoApprove')
    const list = Array.isArray(current)
      ? current.filter((s): s is string => typeof s === 'string')
      : []
    if (list.includes(kind)) return
    this._config.update('acp.permissions.autoApprove', [...list, kind], ConfigurationTarget.Memory)
  }

  private _allowList(): ReadonlySet<string> {
    const raw = this._config.get<unknown>('acp.permissions.autoApprove')
    if (!Array.isArray(raw)) return new Set()
    return new Set(raw.filter((s): s is string => typeof s === 'string'))
  }
}

registerSingleton(IAcpPermissionHandler, AcpPermissionHandler, InstantiationType.Delayed)
