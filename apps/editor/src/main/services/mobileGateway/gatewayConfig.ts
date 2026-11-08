/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Runtime resolution for the machine-local gateway config: environment
 *  overrides, bind/port/address resolution and allowed origins. File parsing
 *  lives in gatewayConfigFile.ts; environment variables outrank gateway.json.
 *--------------------------------------------------------------------------------------------*/

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type {
  MobileGatewayBindMode,
  MobileGatewayConfig,
} from '../../../shared/ipc/mobileGatewayService.js'
import { MOBILE_GATEWAY_DEFAULT_PORT } from '../../../shared/ipc/mobileGatewayService.js'
import { normalizeHostEntry } from './requestSecurity.js'

export { MOBILE_GATEWAY_DEFAULT_PORT }
export { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../shared/ipc/mobileGatewayService.js'

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

/**
 * IPv4 addresses a phone could plausibly reach, best first.
 *
 * Link-local (169.254.0.0/16) entries are dropped entirely: Windows assigns
 * them to adapters that never got a DHCP lease (disconnected VPNs, idle
 * virtual switches) and no other device can reach them. Private ranges outrank
 * public ones, and physical adapters outrank virtual switches/VPNs, because a
 * multi-homed machine usually enumerates the virtual adapter first.
 */
export function listLanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const candidates: { readonly address: string; readonly score: number }[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const score = lanAddressScore(name, entry.address)
      // Ties keep OS enumeration order (Array#sort is stable), so a machine
      // without virtual adapters behaves exactly like the old first-match rule.
      if (score !== undefined) candidates.push({ address: entry.address, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.map((candidate) => candidate.address)
}

/** Best LAN address, or undefined when every candidate is unusable. */
export function pickLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | undefined {
  return listLanAddresses(interfaces)[0]
}

const VIRTUAL_INTERFACE_PREFIXES = ['br-', 'tap', 'tun', 'utun', 'veth', 'virbr', 'wg']
const VIRTUAL_INTERFACE_NAMES = [
  'docker',
  'hyper-v',
  'tailscale',
  'vethernet',
  'virtualbox',
  'vmnet',
  'wireguard',
  'wsl',
  'zerotier',
]

function lanAddressScore(name: string, address: string): number | undefined {
  const octets = parseIpv4(address)
  if (octets === undefined) return undefined
  const [a, b] = octets
  if (a === 169 && b === 254) return undefined
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  const score = privateRange ? 2 : 1
  return isVirtualInterfaceName(name) ? score - 2 : score
}

function isVirtualInterfaceName(name: string): boolean {
  const normalized = name.toLowerCase()
  return (
    VIRTUAL_INTERFACE_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    VIRTUAL_INTERFACE_NAMES.some((token) => normalized.includes(token))
  )
}

function parseIpv4(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  const [a, b, c, d] = octets
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined
  if (!octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return undefined
  }
  return [a, b, c, d]
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
