/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Configuration schema and live forwarding for the phone gateway. The settings
 *  page (M1-3) writes these keys; main reads settings.json at startup, and this
 *  contribution pushes every change through IMobileGatewayService.applyConfig so
 *  enabling/disabling takes effect without restarting the app.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  type IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'
import {
  IMobileGatewayService,
  MOBILE_GATEWAY_DEFAULT_PORT,
  type MobileGatewayBindMode,
  type MobileGatewayConfig,
} from '../../shared/ipc/mobileGatewayService.js'
import { IUserSettingsSyncService } from '../services/configuration/UserSettingsSync.js'

export const MOBILE_GATEWAY_CONFIG_KEYS = [
  'mobileGateway.enabled',
  'mobileGateway.bind',
  'mobileGateway.lanAddress',
  'mobileGateway.port',
  'mobileGateway.allowedHosts',
] as const

export class MobileGatewayConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'mobileGateway',
        title: localize('settings.mobileGateway', 'Mobile Gateway'),
        properties: {
          'mobileGateway.enabled': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.mobileGateway.enabled',
              'Serve the phone PWA from this computer and accept paired phones. Off by default; pair a device from the Mobile Devices settings page.',
            ),
          },
          'mobileGateway.bind': {
            type: 'string',
            enum: ['loopback', 'lan'],
            default: 'loopback',
            description: localize(
              'settings.mobileGateway.bind',
              'Where the gateway listens. "loopback" is the recommended Tailscale mode: the gateway listens on 127.0.0.1 and Tailscale Serve exposes it over HTTPS. "lan" binds a LAN address directly and is development-only until self-signed HTTPS ships.',
            ),
          },
          'mobileGateway.lanAddress': {
            type: 'string',
            default: '',
            description: localize(
              'settings.mobileGateway.lanAddress',
              'IPv4 address to bind in "lan" mode. Leave empty to use the first non-internal IPv4 address.',
            ),
          },
          'mobileGateway.port': {
            type: 'number',
            default: MOBILE_GATEWAY_DEFAULT_PORT,
            minimum: 1,
            maximum: 65535,
            description: localize(
              'settings.mobileGateway.port',
              'TCP port for the gateway (pairing API, PWA assets and WebSocket). The UNIVERSE_MOBILE_PORT environment variable overrides this.',
            ),
          },
          'mobileGateway.allowedHosts': {
            type: 'array',
            items: { type: 'string' },
            default: [],
            description: localize(
              'settings.mobileGateway.allowedHosts',
              'Extra host names accepted in the Host header and offered as HTTPS origins, e.g. the Tailscale Serve name "pc.tailnet-name.ts.net". Loopback and the bind address are always accepted.',
            ),
          },
        },
      }),
    )
  }
}

export class MobileGatewayConfigSyncContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _hydrated = false

  constructor(
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IMobileGatewayService private readonly _gateway: IMobileGatewayService,
    @IUserSettingsSyncService userSettingsSync: IUserSettingsSyncService,
  ) {
    super()
    // Main already read settings.json itself; pushing the renderer's still-empty
    // layers before hydration would momentarily disable a gateway that is up.
    void userSettingsSync.whenInitialized.then(() => {
      this._hydrated = true
      this._apply()
    })
    this._register(
      this._configuration.onDidChangeConfiguration((event) => {
        if (!this._hydrated) return
        if (MOBILE_GATEWAY_CONFIG_KEYS.some((key) => event.affectsConfiguration(key))) {
          this._apply()
        }
      }),
    )
  }

  private _apply(): void {
    void this._gateway.applyConfig(this._readConfig()).catch(() => undefined)
  }

  private _readConfig(): MobileGatewayConfig {
    const bind = this._configuration.get<string>('mobileGateway.bind')
    const lanAddress = this._configuration.get<string>('mobileGateway.lanAddress')
    const port = this._configuration.get<number>('mobileGateway.port')
    const allowedHosts = this._configuration.get<unknown>('mobileGateway.allowedHosts')
    const bindMode: MobileGatewayBindMode = bind === 'lan' ? 'lan' : 'loopback'
    return {
      enabled: this._configuration.get<boolean>('mobileGateway.enabled') === true,
      bind: bindMode,
      lanAddress: typeof lanAddress === 'string' ? lanAddress : '',
      port:
        typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
          ? port
          : MOBILE_GATEWAY_DEFAULT_PORT,
      allowedHosts: Array.isArray(allowedHosts)
        ? allowedHosts.filter((value): value is string => typeof value === 'string')
        : [],
    }
  }
}
