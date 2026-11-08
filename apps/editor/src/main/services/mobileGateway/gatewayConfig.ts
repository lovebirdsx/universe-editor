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
}

export function parseMobileGatewayConfig(raw: unknown): MobileGatewayConfig {
  if (!isRecord(raw)) return DEFAULT_MOBILE_GATEWAY_CONFIG
  const enabled = raw['mobileGateway.enabled']
  const bind = raw['mobileGateway.bind']
  const lanAddress = raw['mobileGateway.lanAddress']
  const port = raw['mobileGateway.port']
  const allowedHosts = raw['mobileGateway.allowedHosts']

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
  readonly mobileInsecure: string | undefined
}

export function gatewayEnvironmentFromProcess(): GatewayEnvironment {
  return {
    mobileGateway: process.env['UNIVERSE_MOBILE_GATEWAY'],
    mobilePort: process.env['UNIVERSE_MOBILE_PORT'],
    mobileBind: process.env['UNIVERSE_MOBILE_BIND'],
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
  const port = parseIntPort(options.env.mobilePort) ?? options.config.port

  if (bind === 'loopback') {
    return { ok: true, bind, host: '127.0.0.1', port, insecure: false }
  }

  // M1 ships HTTP only, so the LAN tier would expose bearer tokens in clear
  // text. Production refuses the tier outright until the self-signed HTTPS
  // work lands; development must opt in explicitly and the status flags it.
  if (options.isPackaged) {
    return { ok: false, error: '局域网档需要 HTTPS，尚未实现' }
  }
  if (options.env.mobileInsecure !== '1') {
    return {
      ok: false,
      error: '局域网档需要 HTTPS；开发构建请设置 UNIVERSE_MOBILE_INSECURE=1',
    }
  }
  const host =
    options.config.lanAddress.trim() !== ''
      ? options.config.lanAddress.trim()
      : pickLanAddress(options.interfaces ?? networkInterfaces())
  if (host === undefined) {
    return { ok: false, error: '未找到可用的局域网 IPv4 地址' }
  }
  return { ok: true, bind, host, port, insecure: true }
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

export function buildOrigins(options: {
  readonly bind: MobileGatewayBindMode
  readonly host: string
  readonly port: number
  readonly allowedHosts: readonly string[]
}): string[] {
  const origins = new Set<string>()
  if (options.bind === 'loopback') {
    origins.add(`http://127.0.0.1:${options.port}`)
    origins.add(`http://localhost:${options.port}`)
  } else {
    origins.add(`http://${options.host}:${options.port}`)
  }
  for (const raw of options.allowedHosts) {
    const host = normalizeHostEntry(raw)
    if (host !== undefined) origins.add(`https://${host}`)
  }
  return [...origins]
}

export function capabilitiesForOrigins(origins: readonly string[]): {
  readonly installable: boolean
  readonly push: boolean
} {
  const secure = origins.some((origin) => origin.startsWith('https://'))
  return { installable: secure, push: secure }
}

function parseIntPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return isPort(parsed) ? parsed : undefined
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
