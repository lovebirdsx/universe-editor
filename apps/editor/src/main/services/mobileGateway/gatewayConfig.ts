/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  `mobileGateway.*` configuration parsing and runtime resolution. Main reads
 *  settings.json directly (there is no main-side IConfigurationService; update
 *  and AI services do the same), while the renderer pushes live changes through
 *  applyConfig. Environment variables outrank the settings file.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { parse } from 'jsonc-parser'
import type {
  MobileGatewayBindMode,
  MobileGatewayConfig,
} from '../../../shared/ipc/mobileGatewayService.js'
import { MOBILE_GATEWAY_DEFAULT_PORT } from '../../../shared/ipc/mobileGatewayService.js'
import { normalizeHostEntry } from './requestSecurity.js'

export { MOBILE_GATEWAY_DEFAULT_PORT }
export const MAX_ALLOWED_HOSTS = 16

export const DEFAULT_MOBILE_GATEWAY_CONFIG: MobileGatewayConfig = {
  enabled: false,
  bind: 'loopback',
  lanAddress: '',
  port: MOBILE_GATEWAY_DEFAULT_PORT,
  allowedHosts: [],
  // Placeholder per the repository's public-value policy. Override with a real
  // `mailto:` or `https:` URL before relying on push in the field.
  vapidSubject: 'https://universe-editor.example.com',
}

export function parseMobileGatewayConfig(raw: unknown): MobileGatewayConfig {
  if (!isRecord(raw)) return DEFAULT_MOBILE_GATEWAY_CONFIG
  const enabled = raw['mobileGateway.enabled']
  const bind = raw['mobileGateway.bind']
  const lanAddress = raw['mobileGateway.lanAddress']
  const port = raw['mobileGateway.port']
  const allowedHosts = raw['mobileGateway.allowedHosts']
  const vapidSubject = raw['mobileGateway.vapidSubject']

  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_MOBILE_GATEWAY_CONFIG.enabled,
    bind: bind === 'lan' || bind === 'loopback' ? bind : DEFAULT_MOBILE_GATEWAY_CONFIG.bind,
    lanAddress: typeof lanAddress === 'string' ? lanAddress.trim() : '',
    port: isPort(port) ? port : DEFAULT_MOBILE_GATEWAY_CONFIG.port,
    allowedHosts: Array.isArray(allowedHosts)
      ? allowedHosts
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => value !== '')
          .slice(0, MAX_ALLOWED_HOSTS)
      : [],
    vapidSubject:
      typeof vapidSubject === 'string' && isValidVapidSubject(vapidSubject.trim())
        ? vapidSubject.trim()
        : DEFAULT_MOBILE_GATEWAY_CONFIG.vapidSubject,
  }
}

/** Web Push requires a `mailto:` address or an `https:` URL as the VAPID subject. */
export function isValidVapidSubject(value: string): boolean {
  if (value.startsWith('mailto:')) return value.length > 'mailto:'.length
  if (!value.startsWith('https://')) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * Read the same settings.json the renderer writes. A missing or unparseable
 * file yields defaults (the gateway stays off, which is the safe direction).
 */
export async function readMobileGatewayConfig(configDir: string): Promise<MobileGatewayConfig> {
  let text: string
  try {
    text = await readFile(join(configDir, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_MOBILE_GATEWAY_CONFIG
  }
  if (text.trim() === '') return DEFAULT_MOBILE_GATEWAY_CONFIG
  return parseMobileGatewayConfig(parse(text, [], { allowTrailingComma: true }))
}

export interface GatewayEnvironment {
  readonly mobileGateway: string | undefined
  readonly mobilePort: string | undefined
  readonly mobileBind: string | undefined
  readonly mobileLanAddress: string | undefined
  readonly mobileInsecure: string | undefined
}

export function gatewayEnvironmentFromProcess(): GatewayEnvironment {
  return {
    mobileGateway: process.env['UNIVERSE_MOBILE_GATEWAY'],
    mobilePort: process.env['UNIVERSE_MOBILE_PORT'],
    mobileBind: process.env['UNIVERSE_MOBILE_BIND'],
    mobileLanAddress: process.env['UNIVERSE_MOBILE_LAN_ADDRESS'],
    mobileInsecure: process.env['UNIVERSE_MOBILE_INSECURE'],
  }
}

export function isMobileGatewayEnabled(
  config: MobileGatewayConfig,
  env: GatewayEnvironment,
): boolean {
  return config.enabled || env.mobileGateway === '1'
}

export type GatewayRuntimeResolution =
  | {
      readonly ok: true
      readonly bind: MobileGatewayBindMode
      readonly host: string
      readonly port: number
      /** HTTPS with the gateway-managed self-signed certificate. */
      readonly secure: boolean
      /** Clear-text HTTP bound to a non-loopback address (development only). */
      readonly insecure: boolean
    }
  | { readonly ok: false; readonly error: string }

export interface ResolveGatewayRuntimeOptions {
  readonly config: MobileGatewayConfig
  readonly env: GatewayEnvironment
  readonly isPackaged: boolean
  readonly interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
}

export function resolveGatewayRuntime(
  options: ResolveGatewayRuntimeOptions,
): GatewayRuntimeResolution {
  const envBind =
    options.env.mobileBind === 'lan' || options.env.mobileBind === 'loopback'
      ? options.env.mobileBind
      : undefined
  const bind = envBind ?? options.config.bind
  // Port 0 is accepted from the environment only: tests need an ephemeral port,
  // while a persisted settings value of 0 would silently change every restart.
  const port = parseIntPort(options.env.mobilePort, true) ?? options.config.port

  if (bind === 'loopback') {
    return { ok: true, bind, host: '127.0.0.1', port, secure: false, insecure: false }
  }

  const configured = options.env.mobileLanAddress?.trim() || options.config.lanAddress.trim()
  const host =
    configured !== '' ? configured : pickLanAddress(options.interfaces ?? networkInterfaces())
  if (host === undefined) {
    return { ok: false, error: '未找到可用的局域网 IPv4 地址' }
  }

  // Plain HTTP on a LAN interface would expose bearer tokens in clear text.
  // Production always uses the self-signed HTTPS tier; development may opt into
  // clear text for debugging, but the status flags it.
  const insecure = options.env.mobileInsecure === '1'
  if (insecure && options.isPackaged) {
    return { ok: false, error: '打包版不允许明文局域网 HTTP；请关闭 UNIVERSE_MOBILE_INSECURE' }
  }
  return { ok: true, bind, host, port, secure: !insecure, insecure }
}

/** First non-internal IPv4 address, or undefined when the machine has none. */
export function pickLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | undefined {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

export interface GatewayOrigins {
  readonly urls: readonly string[]
  /**
   * At least one configured extra Host (the Tailscale tier) yields an HTTPS
   * origin whose certificate is assumed trusted by the phone. The LAN tier's
   * self-signed origin does not count: Service Worker and Push are unavailable
   * until the phone trusts the certificate.
   */
  readonly trustedSecure: boolean
}

export function buildOrigins(options: {
  readonly bind: MobileGatewayBindMode
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly allowedHosts: readonly string[]
}): GatewayOrigins {
  const urls = new Set<string>()
  if (options.bind === 'loopback') {
    urls.add(`http://127.0.0.1:${options.port}`)
    urls.add(`http://localhost:${options.port}`)
  } else {
    urls.add(`${options.secure ? 'https' : 'http'}://${options.host}:${options.port}`)
  }
  let trustedSecure = false
  for (const raw of options.allowedHosts) {
    const host = normalizeHostEntry(raw)
    if (host === undefined) continue
    urls.add(`https://${host}`)
    trustedSecure = true
  }
  return { urls: [...urls], trustedSecure }
}

export function capabilitiesForOrigins(origins: GatewayOrigins): {
  readonly installable: boolean
  readonly push: boolean
} {
  return { installable: origins.trustedSecure, push: origins.trustedSecure }
}

function parseIntPort(value: string | undefined, allowZero = false): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return isPort(parsed, allowZero) ? parsed : undefined
}

function isPort(value: unknown, allowZero = false): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= 65535
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
