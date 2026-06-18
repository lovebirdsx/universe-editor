/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Resolves a JSON-schema reference (from `contributes.jsonValidation` or the
 *  user `json.schemas` setting) into an inline schema object, the only form
 *  Monaco's JSON worker accepts (schemaRequest: 'ignore'). Shared by the
 *  contribution and the extension-point translator so both apply the same
 *  http(s) download policy.
 *
 *  Policy mirrors VSCode: remote downloads are gated by `json.schemaDownload.enable`
 *  (default on) and a `json.schemaDownload.trustedDomains` allow-list. The actual
 *  fetch + cache happens in the main process (IRemoteSchemaService); here we only
 *  decide whether a url is allowed, then read the resulting text.
 *--------------------------------------------------------------------------------------------*/

import {
  IConfigurationService,
  IFileService,
  URI,
  type IJSONSchema,
  type ILogger,
} from '@universe-editor/platform'
import type { IRemoteSchemaService } from '../../../shared/ipc/remoteSchemaService.js'

export const SCHEMA_DOWNLOAD_ENABLE_KEY = 'json.schemaDownload.enable'
export const SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY = 'json.schemaDownload.trustedDomains'

/** Default trusted prefixes for remote schema downloads (subset of VSCode's list). */
export const DEFAULT_TRUSTED_SCHEMA_DOMAINS: Readonly<Record<string, boolean>> = {
  'https://json.schemastore.org/': true,
  'https://www.schemastore.org/': true,
  'https://json-schema.org/': true,
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** A non-http(s) url (local path) is always allowed; http(s) must match a trusted prefix. */
export function isTrustedSchemaUrl(url: string, trustedDomains: Record<string, boolean>): boolean {
  if (!isHttpUrl(url)) return true
  return Object.entries(trustedDomains).some(
    ([prefix, trusted]) => trusted && url.toLowerCase().startsWith(prefix.toLowerCase()),
  )
}

export interface ISchemaResolveDeps {
  readonly configuration: IConfigurationService
  readonly fileService: IFileService
  readonly remoteSchema: IRemoteSchemaService
  readonly logger: ILogger
}

/**
 * Resolve `url` into a parsed schema object, or undefined (with a logged reason)
 * if it can't be resolved. `label` is used only for log context.
 */
export async function resolveSchemaFromUrl(
  url: string,
  deps: ISchemaResolveDeps,
  label: string,
): Promise<IJSONSchema | undefined> {
  if (isHttpUrl(url)) {
    const enabled = deps.configuration.get<boolean>(SCHEMA_DOWNLOAD_ENABLE_KEY, true)
    if (!enabled) {
      deps.logger.warn(`${label}: schema download disabled; skipping ${url}`)
      return undefined
    }
    // Built-in defaults (schemastore, json-schema.org) are an always-trusted
    // baseline; the user setting *adds* domains rather than replacing it, so a
    // user listing one custom domain doesn't silently lose the official sources.
    const userTrusted = deps.configuration.get<Record<string, boolean>>(
      SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY,
      {},
    )
    const trusted = { ...DEFAULT_TRUSTED_SCHEMA_DOMAINS, ...(userTrusted ?? {}) }
    if (!isTrustedSchemaUrl(url, trusted)) {
      deps.logger.warn(`${label}: ${url} is not in json.schemaDownload.trustedDomains; skipping`)
      return undefined
    }
    const res = await deps.remoteSchema.fetchSchema(url)
    if (!res.ok) {
      deps.logger.warn(`${label}: failed to download ${url}: ${res.error}`)
      return undefined
    }
    try {
      return JSON.parse(res.content) as IJSONSchema
    } catch (err) {
      deps.logger.warn(`${label}: downloaded schema for ${url} is not valid JSON: ${String(err)}`)
      return undefined
    }
  }

  try {
    const text = await deps.fileService.readFileText(URI.file(url))
    return JSON.parse(text) as IJSONSchema
  } catch (err) {
    deps.logger.warn(`${label}: failed to read schema "${url}": ${String(err)}`)
    return undefined
  }
}
