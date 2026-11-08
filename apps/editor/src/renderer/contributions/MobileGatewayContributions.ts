/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for `<userData>/mobile/gateway.json`, the machine-
 *  local gateway config. The file is pinned to userData (it does not follow a
 *  relocated config directory), so the exact fileMatch is resolved once at
 *  startup. The gateway itself reads/writes the file through IMobileGatewayService.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IDisposable,
  type IJSONSchema,
  type IWorkbenchContribution,
  JSONContributionRegistry,
  localize,
  MutableDisposable,
  URI,
} from '@universe-editor/platform'
import {
  IMobileGatewayService,
  MOBILE_GATEWAY_DEFAULT_PORT,
} from '../../shared/ipc/mobileGatewayService.js'
import { schemaFileMatchForUri } from '../services/preferences/schemaFileMatch.js'

const MOBILE_GATEWAY_SCHEMA_URI = 'universe-editor://schemas/mobileGateway'

// Fields mirror MobileGatewayConfig (shared/ipc/mobileGatewayService.ts).
const MOBILE_GATEWAY_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: {
      type: 'boolean',
      default: false,
      description: localize(
        'settings.mobileGateway.enabled',
        'Serve the phone PWA from this computer and accept paired phones. Off by default; pair a device from the Mobile Devices settings page.',
      ),
    },
    bind: {
      type: 'string',
      enum: ['loopback', 'lan'],
      default: 'loopback',
      description: localize(
        'settings.mobileGateway.bind',
        'Where the gateway listens. "loopback" is the recommended Tailscale mode: the gateway listens on 127.0.0.1 and Tailscale Serve exposes it over HTTPS. "lan" binds a LAN address directly and serves HTTPS with a certificate generated on this PC.',
      ),
    },
    lanAddress: {
      type: 'string',
      default: '',
      description: localize(
        'settings.mobileGateway.lanAddress',
        'IPv4 address to bind in "lan" mode. Leave empty to auto-pick the best LAN adapter: private ranges first, physical adapters over virtual ones, and link-local 169.254.x.x addresses are ignored.',
      ),
    },
    port: {
      type: 'number',
      default: MOBILE_GATEWAY_DEFAULT_PORT,
      minimum: 1,
      maximum: 65535,
      description: localize(
        'settings.mobileGateway.port',
        'TCP port for the gateway (pairing API, PWA assets and WebSocket). The UNIVERSE_MOBILE_PORT environment variable overrides this.',
      ),
    },
    allowedHosts: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      description: localize(
        'settings.mobileGateway.allowedHosts',
        'Extra host names accepted in the Host header and offered as HTTPS origins, e.g. the Tailscale Serve name "pc.tailnet-name.ts.net". Loopback and the bind address are always accepted.',
      ),
    },
    vapidSubject: {
      type: 'string',
      default: 'https://universe-editor.example.com',
      description: localize(
        'settings.mobileGateway.vapidSubject',
        'Contact address embedded in Web Push VAPID claims. Push services require either an https URL or a mailto: address. The default is a placeholder; set a real one for production push.',
      ),
    },
  },
}

export class MobileGatewayConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _schema = this._register(new MutableDisposable<IDisposable>())

  constructor(@IMobileGatewayService private readonly _gateway: IMobileGatewayService) {
    super()
    void this._refresh()
  }

  private async _refresh(): Promise<void> {
    let uri: URI
    try {
      uri = URI.parse(await this._gateway.getConfigFileUri())
    } catch {
      return
    }
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: MOBILE_GATEWAY_SCHEMA_URI,
      fileMatch: [schemaFileMatchForUri(uri)],
      schema: MOBILE_GATEWAY_SCHEMA,
    })
  }
}
