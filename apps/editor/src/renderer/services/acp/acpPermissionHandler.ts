/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPermissionHandler — bridges ACP's `session/request_permission` requests
 *  to the modal dialog service, with a configured allow-list short-circuit.
 *
 *  Decision rules (in order):
 *    1. If the toolCall `kind` (or option name) is in `acp.permissions.autoApprove`,
 *       resolve immediately as `selected` with the first `allow_*` option.
 *    2. Otherwise prompt the user via IDialogService.confirm.
 *    3. If the user picked an `allow_always` option, persist the kind into the
 *       Memory layer of `acp.permissions.autoApprove` so future requests skip
 *       the prompt for the lifetime of this session (the User layer is left
 *       alone — UserSettingsSync owns that write path).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  createDecorator,
  IConfigurationService,
  IDialogService,
} from '@universe-editor/platform'
import type { AcpRequestPermissionParams, AcpRequestPermissionResult } from './acpProtocol.js'

export interface IAcpPermissionHandler {
  readonly _serviceBrand: undefined
  request(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult>
}

export const IAcpPermissionHandler = createDecorator<IAcpPermissionHandler>('acpPermissionHandler')

export class AcpPermissionHandler implements IAcpPermissionHandler {
  declare readonly _serviceBrand: undefined

  constructor(
    @IDialogService private readonly _dialog: IDialogService,
    @IConfigurationService private readonly _config: IConfigurationService,
  ) {}

  async request(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    const auto = this._allowList()
    const kind = params.toolCall.kind
    if (kind && auto.has(kind)) {
      const allow = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      if (allow) {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
    }

    const allowAlways = params.options.find((o) => o.kind === 'allow_always')
    const allowOnce = params.options.find((o) => o.kind === 'allow_once')
    const rejectOnce = params.options.find((o) => o.kind === 'reject_once')

    const title = params.toolCall.title ?? params.toolCall.toolCallId
    const result = await this._dialog.confirm({
      type: 'warning',
      message: `Agent requests permission: ${title}`,
      ...(kind ? { detail: `Kind: ${kind}` } : {}),
      primaryButton: allowOnce ? 'Allow' : (allowAlways?.name ?? 'Allow'),
      secondaryButton: allowAlways?.name ?? 'Allow always',
      cancelButton: rejectOnce?.name ?? 'Deny',
    })

    if (result.choice === 'primary' && allowOnce) {
      return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
    }
    if (result.choice === 'secondary' && allowAlways) {
      if (kind) this._persistAllow(kind)
      return { outcome: { outcome: 'selected', optionId: allowAlways.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }

  private _allowList(): ReadonlySet<string> {
    const raw = this._config.get<unknown>('acp.permissions.autoApprove')
    if (!Array.isArray(raw)) return new Set()
    return new Set(raw.filter((s): s is string => typeof s === 'string'))
  }

  private _persistAllow(kind: string): void {
    const current = this._config.get<unknown>('acp.permissions.autoApprove')
    const list = Array.isArray(current)
      ? current.filter((s): s is string => typeof s === 'string')
      : []
    if (list.includes(kind)) return
    this._config.update('acp.permissions.autoApprove', [...list, kind], ConfigurationTarget.Memory)
  }
}
