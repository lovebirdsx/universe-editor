/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves a release's `urgency` from the update feed, so an important fix can be
 *  downloaded without waiting for a click.
 *
 *  The marker lives in the note's frontmatter and ships in `notes/index.json` — the
 *  metadata-only file the download page already serves. It is deliberately NOT read
 *  from the packaged `release-notes.json`: that artifact is compiled up to the version
 *  being installed, so a client running 0.15.1 has no idea what 0.15.2 says.
 *
 *  Every failure path (no feed URL, offline, 404, malformed JSON, unknown version)
 *  resolves to `normal`. A missing marker must never block or delay an update.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path'
import type { UpdateUrgency } from '../../../shared/ipc/updateService.js'

/** Long enough for an intranet round-trip, short enough to not stall the check prompt. */
const URGENCY_FETCH_TIMEOUT_MS = 2_000

/**
 * Where electron-updater keeps the feed definition. Mirrors the path convention
 * documented on `forceDevUpdateConfig` (AppUpdater.d.ts): an unpackaged build reads
 * `dev-app-update.yml` next to the app, a packaged one the electron-builder-generated
 * `app-update.yml` in resources.
 */
export function updaterConfigPath(opts: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'app-update.yml')
    : join(opts.appPath, 'dev-app-update.yml')
}

/**
 * Pull `url:` out of a feed config. The file is machine-generated flat YAML
 * (`provider` / `url` / `channel`), so a single-line match beats pulling in a YAML
 * parser; an unparsable value degrades to "no feed URL", never to a wrong one.
 */
export function feedUrlFromUpdateConfig(text: string): string | undefined {
  const raw = /^url:[ \t]*(.*)$/m.exec(text)?.[1]?.trim()
  if (raw === undefined || raw === '') return undefined
  const url = unwrapQuotes(raw)
  return url === '' ? undefined : url
}

function unwrapQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/**
 * `notes/index.json` next to the feed. The trailing slash matters: without it the last
 * path segment of the feed URL would be replaced instead of appended to (electron-updater
 * normalizes its own base URL the same way).
 */
export function siteIndexUrl(baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    const resolved = new URL('notes/index.json', base)
    // Relative resolution drops the base's query, which would 401 the notes fetch
    // against a feed the version check still reaches.
    resolved.search = base.search
    return resolved.toString()
  } catch {
    return undefined
  }
}

/**
 * Look `version` up in a parsed site index. A valid index that simply has no such
 * version yields `normal` (it is definitely not flagged important, and retrying will
 * not change that) — `undefined` is reserved for a shape we could not read at all, so
 * the caller knows not to cache the answer.
 */
export function urgencyForVersion(index: unknown, version: string): UpdateUrgency | undefined {
  if (typeof index !== 'object' || index === null) return undefined
  const versions = (index as { versions?: unknown }).versions
  if (!Array.isArray(versions)) return undefined
  for (const entry of versions) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { version?: unknown; urgency?: unknown }
    if (record.version !== version) continue
    return record.urgency === 'important' ? 'important' : 'normal'
  }
  return 'normal'
}

/** The real index is a few KB; anything far past that is not worth buffering. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024

/**
 * Bounded read of the site index: times out, never throws, and returns `undefined` on
 * any failure so the caller falls back to `normal`.
 */
export async function fetchUrgencyFromSiteIndex(params: {
  url: string
  version: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<UpdateUrgency | undefined> {
  const { url, version, timeoutMs = URGENCY_FETCH_TIMEOUT_MS, fetchImpl = fetch } = params
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: timeout.signal })
    if (!response.ok) return undefined
    const declared = Number(response.headers.get('content-length'))
    if (declared > MAX_INDEX_BYTES) return undefined
    return urgencyForVersion(await response.json(), version)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
