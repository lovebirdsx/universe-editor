/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parser / validator for the machine-local `<userData>/mobile/gateway.json`.
 *  Kept separate from gatewayConfig.ts (runtime/env resolution) so the file
 *  format is unit-testable without Electron. A known field that is present but
 *  invalid rejects the whole file instead of silently falling back per field.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises'
import { parse, type ParseError } from 'jsonc-parser'
import type {
  MobileGatewayBindMode,
  MobileGatewayCertificateMode,
  MobileGatewayConfig,
  MobileGatewayConfigPatch,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  DEFAULT_MOBILE_GATEWAY_CONFIG,
  MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT,
} from '../../../shared/ipc/mobileGatewayService.js'
import { isValidVapidSubject } from './gatewayConfig.js'
import { normalizeHostEntry } from './requestSecurity.js'

export const MOBILE_GATEWAY_CONFIG_FILE = 'gateway.json'
export const MAX_ALLOWED_HOSTS = 16

const CONFIG_KEYS = new Set([
  'enabled',
  'bind',
  'lanAddress',
  'port',
  'allowedHosts',
  'certificateMode',
  'vapidSubject',
  'sessionHistoryWorkspaceLimit',
])

export type MobileGatewayConfigFileReadResult =
  | { readonly kind: 'ok'; readonly config: MobileGatewayConfig }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly error: string }

export type MobileGatewayConfigParseResult =
  | { readonly ok: true; readonly config: MobileGatewayConfig }
  | { readonly ok: false; readonly errors: readonly string[] }

export type MobileGatewayConfigPatchResult =
  | { readonly ok: true; readonly patch: MobileGatewayConfigPatch }
  | { readonly ok: false; readonly errors: readonly string[] }

/** Missing fields take their defaults; unknown fields are ignored. */
export function parseMobileGatewayConfigFile(raw: unknown): MobileGatewayConfigParseResult {
  if (!isRecord(raw)) return { ok: false, errors: ['gateway.json must contain a JSON object'] }

  const errors: string[] = []
  let config: MobileGatewayConfig = { ...DEFAULT_MOBILE_GATEWAY_CONFIG }

  if (hasOwn(raw, 'enabled')) {
    const value = raw['enabled']
    if (typeof value === 'boolean') config = { ...config, enabled: value }
    else errors.push('"enabled" must be a boolean')
  }

  if (hasOwn(raw, 'bind')) {
    const bind = parseBindMode(raw['bind'])
    if (bind !== undefined) config = { ...config, bind }
    else errors.push('"bind" must be "loopback" or "lan"')
  }

  if (hasOwn(raw, 'lanAddress')) {
    const value = raw['lanAddress']
    if (typeof value === 'string') config = { ...config, lanAddress: value.trim() }
    else errors.push('"lanAddress" must be a string')
  }

  if (hasOwn(raw, 'port')) {
    const value = raw['port']
    if (isPort(value)) config = { ...config, port: value }
    else errors.push('"port" must be an integer between 1 and 65535')
  }

  if (hasOwn(raw, 'allowedHosts')) {
    const hosts = parseAllowedHosts(raw['allowedHosts'], 'allowedHosts', errors)
    if (hosts !== undefined) config = { ...config, allowedHosts: hosts }
  }

  if (hasOwn(raw, 'certificateMode')) {
    const mode = parseCertificateMode(raw['certificateMode'])
    if (mode !== undefined) config = { ...config, certificateMode: mode }
    else errors.push('"certificateMode" must be "self-signed" or "root-ca"')
  }

  if (hasOwn(raw, 'vapidSubject')) {
    const value = raw['vapidSubject']
    if (typeof value === 'string' && isValidVapidSubject(value.trim())) {
      config = { ...config, vapidSubject: value.trim() }
    } else {
      errors.push('"vapidSubject" must be an https: URL or a mailto: address')
    }
  }

  if (hasOwn(raw, 'sessionHistoryWorkspaceLimit')) {
    const value = raw['sessionHistoryWorkspaceLimit']
    if (isSessionHistoryWorkspaceLimit(value)) {
      config = { ...config, sessionHistoryWorkspaceLimit: value }
    } else {
      errors.push(sessionHistoryWorkspaceLimitError())
    }
  }

  return errors.length === 0 ? { ok: true, config } : { ok: false, errors }
}

/** `undefined` means "leave unchanged"; an unknown key rejects the patch. */
export function validateMobileGatewayConfigPatch(raw: unknown): MobileGatewayConfigPatchResult {
  if (!isRecord(raw)) return { ok: false, errors: ['config patch must be a JSON object'] }

  const errors: string[] = []
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`unknown config field "${key}"`)
  }

  const patch: {
    enabled?: boolean
    bind?: MobileGatewayBindMode
    lanAddress?: string
    port?: number
    allowedHosts?: readonly string[]
    certificateMode?: MobileGatewayCertificateMode
    vapidSubject?: string
    sessionHistoryWorkspaceLimit?: number
  } = {}

  if (hasOwn(raw, 'enabled')) {
    const value = raw['enabled']
    if (value !== undefined) {
      if (typeof value === 'boolean') patch.enabled = value
      else errors.push('"enabled" must be a boolean')
    }
  }

  if (hasOwn(raw, 'bind')) {
    const value = raw['bind']
    if (value !== undefined) {
      const bind = parseBindMode(value)
      if (bind !== undefined) patch.bind = bind
      else errors.push('"bind" must be "loopback" or "lan"')
    }
  }

  if (hasOwn(raw, 'lanAddress')) {
    const value = raw['lanAddress']
    if (value !== undefined) {
      if (typeof value === 'string') patch.lanAddress = value.trim()
      else errors.push('"lanAddress" must be a string')
    }
  }

  if (hasOwn(raw, 'port')) {
    const value = raw['port']
    if (value !== undefined) {
      if (isPort(value)) patch.port = value
      else errors.push('"port" must be an integer between 1 and 65535')
    }
  }

  if (hasOwn(raw, 'allowedHosts')) {
    const value = raw['allowedHosts']
    if (value !== undefined) {
      const hosts = parseAllowedHosts(value, 'allowedHosts', errors)
      if (hosts !== undefined) patch.allowedHosts = hosts
    }
  }

  if (hasOwn(raw, 'certificateMode')) {
    const value = raw['certificateMode']
    if (value !== undefined) {
      const mode = parseCertificateMode(value)
      if (mode !== undefined) patch.certificateMode = mode
      else errors.push('"certificateMode" must be "self-signed" or "root-ca"')
    }
  }

  if (hasOwn(raw, 'vapidSubject')) {
    const value = raw['vapidSubject']
    if (value !== undefined) {
      if (typeof value === 'string' && isValidVapidSubject(value.trim())) {
        patch.vapidSubject = value.trim()
      } else {
        errors.push('"vapidSubject" must be an https: URL or a mailto: address')
      }
    }
  }

  if (hasOwn(raw, 'sessionHistoryWorkspaceLimit')) {
    const value = raw['sessionHistoryWorkspaceLimit']
    if (value !== undefined) {
      if (isSessionHistoryWorkspaceLimit(value)) {
        patch.sessionHistoryWorkspaceLimit = value
      } else {
        errors.push(sessionHistoryWorkspaceLimitError())
      }
    }
  }

  return errors.length === 0 ? { ok: true, patch } : { ok: false, errors }
}

export function mergeMobileGatewayConfig(
  base: MobileGatewayConfig,
  patch: MobileGatewayConfigPatch,
): MobileGatewayConfig {
  return {
    enabled: patch.enabled ?? base.enabled,
    bind: patch.bind ?? base.bind,
    lanAddress: patch.lanAddress ?? base.lanAddress,
    port: patch.port ?? base.port,
    allowedHosts: patch.allowedHosts ?? base.allowedHosts,
    certificateMode: patch.certificateMode ?? base.certificateMode,
    vapidSubject: patch.vapidSubject ?? base.vapidSubject,
    sessionHistoryWorkspaceLimit:
      patch.sessionHistoryWorkspaceLimit ?? base.sessionHistoryWorkspaceLimit,
  }
}

/** Fixed key order keeps diffs stable when the UI rewrites the file. */
export function serializeMobileGatewayConfig(config: MobileGatewayConfig): MobileGatewayConfig {
  return {
    enabled: config.enabled,
    bind: config.bind,
    lanAddress: config.lanAddress,
    port: config.port,
    allowedHosts: [...config.allowedHosts],
    certificateMode: config.certificateMode,
    vapidSubject: config.vapidSubject,
    sessionHistoryWorkspaceLimit: config.sessionHistoryWorkspaceLimit,
  }
}

export async function readMobileGatewayConfigFile(
  file: string,
): Promise<MobileGatewayConfigFileReadResult> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return {
      kind: 'invalid',
      error: `cannot read gateway.json: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  text = stripBom(text)
  if (text.trim() === '') {
    return { kind: 'ok', config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG } }
  }

  const errors: ParseError[] = []
  const raw = parse(text, errors, { allowTrailingComma: true })
  const firstError = errors[0]
  if (firstError !== undefined) {
    return {
      kind: 'invalid',
      error: `gateway.json is not valid JSON (offset ${firstError.offset})`,
    }
  }

  const parsed = parseMobileGatewayConfigFile(raw)
  if (!parsed.ok) return { kind: 'invalid', error: parsed.errors.join('; ') }
  return { kind: 'ok', config: parsed.config }
}

function parseBindMode(value: unknown): MobileGatewayBindMode | undefined {
  return value === 'loopback' || value === 'lan' ? value : undefined
}

function parseCertificateMode(value: unknown): MobileGatewayCertificateMode | undefined {
  return value === 'self-signed' || value === 'root-ca' ? value : undefined
}

function parseAllowedHosts(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`"${field}" must be an array of host names`)
    return undefined
  }
  if (value.length > MAX_ALLOWED_HOSTS) {
    errors.push(`"${field}" accepts at most ${MAX_ALLOWED_HOSTS} entries`)
    return undefined
  }
  const hosts: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || normalizeHostEntry(entry) === undefined) {
      errors.push(`"${field}" contains an invalid host name: ${JSON.stringify(entry)}`)
      return undefined
    }
    hosts.push(entry.trim())
  }
  return hosts
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isSessionHistoryWorkspaceLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT
  )
}

function sessionHistoryWorkspaceLimitError(): string {
  return `"sessionHistoryWorkspaceLimit" must be an integer between 1 and ${MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT}`
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
